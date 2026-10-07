import baileysDefault, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useDbAuthState, clearAuthState } from './auth-state.js';
import { pool, logMessage } from './db.js';

// Kompatibel lintas versi Baileys (6.7.x vs 6.17.x)
const makeWASocket = baileysDefault?.default ?? baileysDefault;

const logger = pino({ level: 'warn' });

/**
 * Manajer multi-session: tiap user punya koneksi WhatsApp sendiri.
 * sessions: Map<userId, { sock, status, qrDataUrl, me, reconnecting }>
 */
const sessions = new Map();

function getOrCreate(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      sock: null,
      status: 'idle', // idle | starting | qr | connected | disconnected
      qrDataUrl: null,
      me: null,
      reconnecting: false,
    });
  }
  return sessions.get(userId);
}

export function getState(userId) {
  const s = getOrCreate(userId);
  return { status: s.status, qr: s.qrDataUrl, me: s.me };
}

export async function connectUser(userId) {
  const s = getOrCreate(userId);
  s.status = 'starting';
  s.qrDataUrl = null;

  const { state, saveCreds } = await useDbAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();

  s.sock = makeWASocket({
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

  s.sock.ev.on('creds.update', saveCreds);

  s.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      s.status = 'qr';
      s.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      console.log(`[WA user ${userId}] QR baru tersedia`);
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.qrDataUrl = null;
      s.me = s.sock.user;
      console.log(`[WA user ${userId}] Terhubung sebagai`, s.sock.user?.id);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      s.status = 'disconnected';
      s.me = null;

      if (code === DisconnectReason.loggedOut) {
        console.log(`[WA user ${userId}] Logout, session dihapus`);
        await clearAuthState(userId);
      }
      if (!s.reconnecting) {
        s.reconnecting = true;
        setTimeout(() => {
          s.reconnecting = false;
          connectUser(userId).catch((e) =>
            console.error(`[WA user ${userId}] reconnect error:`, e.message)
          );
        }, 3000);
      }
    }
  });

  // Autoreply pesan masuk (milik user ini saja)
  s.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';
        if (!text) continue;

        await logMessage({ userId, direction: 'in', jid, text, status: 'received' });

        const { rows } = await pool.query(
          'SELECT * FROM autoreplies WHERE user_id = $1 AND active = TRUE',
          [userId]
        );
        const lower = text.toLowerCase();
        for (const rule of rows) {
          const kw = rule.keyword.toLowerCase();
          const matched =
            rule.match_mode === 'exact' ? lower === kw : lower.includes(kw);
          if (matched) {
            await s.sock.sendMessage(jid, { text: rule.response });
            await logMessage({
              userId, direction: 'out', jid,
              text: rule.response, status: 'autoreply',
            });
            break;
          }
        }
      } catch (e) {
        console.error(`[WA user ${userId}] autoreply error:`, e.message);
      }
    }
  });

  return s.sock;
}

/** Saat server start: sambungkan semua user yang punya session tersimpan */
export async function connectAllSessions() {
  const { rows } = await pool.query('SELECT user_id FROM auth_creds');
  for (const { user_id } of rows) {
    connectUser(user_id).catch((e) =>
      console.error(`[WA user ${user_id}] boot connect error:`, e.message)
    );
  }
  console.log(`[WA] ${rows.length} session tersimpan disambungkan ulang`);
}

/** Normalisasi nomor: 08xxx -> 628xxx@s.whatsapp.net */
export function toJid(number) {
  let n = String(number).replace(/[^0-9@.]/g, '');
  if (n.includes('@')) return n; // sudah jid (termasuk group)
  if (n.startsWith('0')) n = '62' + n.slice(1);
  return `${n}@s.whatsapp.net`;
}

function requireConnected(userId) {
  const s = getOrCreate(userId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung. Scan QR dulu di dashboard.');
  }
  return s.sock;
}

export async function sendText(userId, number, text) {
  const sock = requireConnected(userId);
  const jid = toJid(number);
  await sock.sendMessage(jid, { text });
  return jid;
}

/**
 * Kirim media. media = { buffer?, url?, mimetype, fileName?, caption? }
 * kind: image | video | audio | document (auto dari mimetype jika tidak diisi)
 */
export async function sendMedia(userId, number, media) {
  const sock = requireConnected(userId);
  const jid = toJid(number);
  const mt = media.mimetype || 'application/octet-stream';
  let kind = media.kind;
  if (!kind) {
    if (mt.startsWith('image/')) kind = 'image';
    else if (mt.startsWith('video/')) kind = 'video';
    else if (mt.startsWith('audio/')) kind = 'audio';
    else kind = 'document';
  }
  const source = media.buffer ? media.buffer : { url: media.url };
  const payload = { caption: media.caption || undefined };
  payload[kind] = source;
  if (kind === 'document') {
    payload.mimetype = mt;
    payload.fileName = media.fileName || 'file';
  }
  if (kind === 'audio') payload.mimetype = mt;
  await sock.sendMessage(jid, payload);
  return { jid, kind };
}

export async function logoutUser(userId) {
  const s = getOrCreate(userId);
  if (s.sock) {
    try { await s.sock.logout(); } catch {}
  }
  await clearAuthState(userId);
  s.status = 'idle';
  s.qrDataUrl = null;
  s.me = null;
  s.sock = null;
}
