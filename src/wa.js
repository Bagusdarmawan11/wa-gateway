import baileysDefault, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';

// Kompatibel lintas versi Baileys (6.7.x vs 6.17.x):
// di sebagian versi fungsi ada di default import, di versi lain di .default
const makeWASocket = baileysDefault?.default ?? baileysDefault;
import QRCode from 'qrcode';
import pino from 'pino';
import { useDbAuthState } from './auth-state.js';
import { pool, logMessage } from './db.js';

const logger = pino({ level: 'warn' });

export const waState = {
  status: 'starting', // starting | qr | connected | disconnected
  qrDataUrl: null,
  me: null,
};

let sock = null;
let reconnecting = false;

export async function connectWA() {
  const { state, saveCreds } = await useDbAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['WA Gateway', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waState.status = 'qr';
      waState.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      console.log('[WA] QR baru tersedia, scan dari dashboard');
    }

    if (connection === 'open') {
      waState.status = 'connected';
      waState.qrDataUrl = null;
      waState.me = sock.user;
      console.log('[WA] Terhubung sebagai', sock.user?.id);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      waState.status = 'disconnected';
      waState.me = null;

      if (code === DisconnectReason.loggedOut) {
        console.log('[WA] Logout! Hapus session di database lalu scan ulang.');
        await pool.query('DELETE FROM auth_creds; DELETE FROM auth_keys;');
      }
      // Reconnect otomatis (termasuk setelah logout -> QR baru)
      if (!reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          connectWA().catch(console.error);
        }, 3000);
      }
    }
  });

  // Autoreply pesan masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';
        if (!text) continue;

        await logMessage({ direction: 'in', jid, text, status: 'received' });

        const { rows } = await pool.query(
          'SELECT * FROM autoreplies WHERE active = TRUE'
        );
        const lower = text.toLowerCase();
        for (const rule of rows) {
          const kw = rule.keyword.toLowerCase();
          const matched =
            rule.match_mode === 'exact'
              ? lower === kw
              : lower.includes(kw);
          if (matched) {
            await sock.sendMessage(jid, { text: rule.response });
            await logMessage({
              direction: 'out',
              jid,
              text: rule.response,
              status: 'autoreply',
            });
            break; // satu balasan per pesan
          }
        }
      } catch (e) {
        console.error('[WA] autoreply error:', e.message);
      }
    }
  });

  return sock;
}

export function getSocket() {
  return sock;
}

/** Normalisasi nomor: 08xxx -> 628xxx@s.whatsapp.net */
export function toJid(number) {
  let n = String(number).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.includes('@')) return n; // sudah jid
  return `${n}@s.whatsapp.net`;
}

export async function sendText(number, text) {
  if (!sock || waState.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung');
  }
  const jid = toJid(number);
  await sock.sendMessage(jid, { text });
  return jid;
}

export async function logout() {
  if (sock) {
    try {
      await sock.logout();
    } catch {}
  }
  await pool.query('DELETE FROM auth_creds; DELETE FROM auth_keys;');
}
