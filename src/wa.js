import baileysDefault, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useDbAuthState, clearAuthState } from './auth-state.js';
import { pool, logMessage, getDevice } from './db.js';
import { runFlows } from './flow.js';

// Kompatibel lintas versi Baileys (6.7.x vs 6.17.x)
const makeWASocket = baileysDefault?.default ?? baileysDefault;

const logger = pino({ level: 'warn' });

/**
 * Manajer multi-device: Map<deviceId, { sock, status, qrDataUrl, me, reconnecting, lastActivity }>
 */
const sessions = new Map();

// Cache versi Baileys agar tidak fetch ulang setiap connect (hemat network + waktu)
let _cachedVersion = null;
async function getBaileysVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    _cachedVersion = version;
    console.log('[WA] Baileys version fetched:', version.join('.'));
    return version;
  } catch (e) {
    // Fallback ke versi stabil yang dikenal jika fetch gagal
    console.warn('[WA] Gagal fetch versi Baileys, pakai fallback 2.3000.1015:', e.message);
    _cachedVersion = [2, 3000, 1015];
    return _cachedVersion;
  }
}

function getOrCreate(deviceId) {
  if (!sessions.has(deviceId)) {
    sessions.set(deviceId, {
      sock: null,
      status: 'idle', // idle | starting | qr | connected | disconnected
      qrDataUrl: null,
      me: null,
      reconnecting: false,
      lastActivity: Date.now(),
    });
  }
  return sessions.get(deviceId);
}

export function getState(deviceId) {
  const s = getOrCreate(deviceId);
  return { status: s.status, qr: s.qrDataUrl, me: s.me };
}

/** Update lastActivity untuk keperluan watchdog */
function touchActivity(deviceId) {
  const s = sessions.get(deviceId);
  if (s) s.lastActivity = Date.now();
}

/** Kirim event ke webhook URL (fire-and-forget) */
async function fireWebhook(url, payload) {
  if (!url) return;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.error('[webhook] gagal:', url, e.message);
  }
}

export async function connectDevice(deviceId) {
  const s = getOrCreate(deviceId);
  const device = await getDevice(deviceId);
  if (!device) throw new Error('Device tidak ditemukan');

  // Jika sudah ada socket yang connecting/connected, jangan buat baru
  if (s.sock && (s.status === 'starting' || s.status === 'qr' || s.status === 'connected')) {
    console.log(`[device ${deviceId}] Sudah dalam status ${s.status}, skip reconnect`);
    return s.sock;
  }

  // Tutup socket lama jika ada
  if (s.sock) {
    try { s.sock.end(); } catch {}
    s.sock = null;
  }

  s.status = 'starting';
  s.qrDataUrl = null;
  s.lastActivity = Date.now();

  const { state, saveCreds } = await useDbAuthState(deviceId);
  const version = await getBaileysVersion();

  s.sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Synpera', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Tambahan: timeout yang lebih panjang untuk jaringan lambat
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000, // ping WA setiap 25 detik
  });

  s.sock.ev.on('creds.update', saveCreds);

  s.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    touchActivity(deviceId);

    if (qr) {
      s.status = 'qr';
      s.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      console.log(`[device ${deviceId}] QR baru tersedia`);
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.qrDataUrl = null;
      s.me = s.sock.user;
      s.reconnecting = false;
      const number = (s.sock.user?.id || '').split(':')[0];
      await pool.query('UPDATE devices SET number = $1 WHERE id = $2', [number, deviceId]);
      console.log(`[device ${deviceId}] Terhubung sebagai`, number);
      fireWebhook(device.webhook_connect_url, { event: 'connect', device_id: deviceId, number, status: 'connected' });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || '';
      const prevStatus = s.status;
      s.status = 'disconnected';
      s.me = null;
      fireWebhook(device.webhook_connect_url, { event: 'disconnect', device_id: deviceId, status: 'disconnected' });

      console.log(`[device ${deviceId}] Koneksi terputus. Code: ${code}, Msg: ${errMsg}`);

      if (code === DisconnectReason.loggedOut) {
        console.log(`[device ${deviceId}] Logout, session dihapus`);
        await clearAuthState(deviceId);
        await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]);
        s.sock = null;
        return;
      }

      // Koneksi digantikan oleh perangkat lain
      const isConflict = code === DisconnectReason.connectionReplaced ||
        errMsg.toLowerCase().includes('conflict') ||
        errMsg.toLowerCase().includes('replaced');

      if (isConflict) {
        console.log(`[device ${deviceId}] Koneksi diambil alih, tunggu 20 detik...`);
        s.sock = null;
        s.reconnecting = true;
        setTimeout(() => {
          s.reconnecting = false;
          connectDevice(deviceId).catch((e) =>
            console.error(`[device ${deviceId}] reconnect error:`, e.message)
          );
        }, 20000);
        return;
      }

      // Jika masih di tahap QR dan terputus, jangan reconnect agresif
      if (prevStatus === 'qr') {
        console.log(`[device ${deviceId}] QR expired atau dibatalkan.`);
        s.sock = null;
        return;
      }

      // Reconnect biasa — gunakan backoff agar tidak spam
      if (!s.reconnecting) {
        s.sock = null;
        s.reconnecting = true;
        const delay = 5000 + Math.random() * 5000; // 5-10 detik random
        console.log(`[device ${deviceId}] Reconnect dalam ${Math.round(delay / 1000)} detik...`);
        setTimeout(() => {
          s.reconnecting = false;
          connectDevice(deviceId).catch((e) =>
            console.error(`[device ${deviceId}] reconnect error:`, e.message)
          );
        }, delay);
      }
    }
  });

  // Status terkirim/dibaca -> webhook message status
  s.sock.ev.on('messages.update', (updates) => {
    touchActivity(deviceId);
    if (!device.webhook_status_url) return;
    for (const u of updates) {
      if (u.update?.status != null) {
        fireWebhook(device.webhook_status_url, {
          event: 'message_status', device_id: deviceId,
          id: u.key?.id, jid: u.key?.remoteJid, status: u.update.status,
        });
      }
    }
  });

  // Pesan masuk
  s.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    touchActivity(deviceId);
    if (type !== 'notify') return;
    const dev = await getDevice(deviceId); // settings terbaru
    if (!dev) return;

    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const fromMe = !!msg.key.fromMe;

        // Quick reply: balas pesan yang dikirim sendiri (dari HP)
        if (fromMe && !dev.quick_reply) continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';
        const hasMedia = !!(
          msg.message?.imageMessage || msg.message?.videoMessage ||
          msg.message?.audioMessage || msg.message?.documentMessage
        );
        if (!text && !hasMedia) continue;

        // Autoread (kecuali silent read)
        if (dev.autoread && !dev.silent_read && !fromMe) {
          try { await s.sock.readMessages([msg.key]); } catch {}
        }

        // Simpan ke inbox / log
        if ((dev.inbox_enabled || dev.autodelete) && !fromMe) {
          await logMessage({
            userId: dev.user_id, deviceId, direction: 'in', jid,
            text: text || '[media]', status: 'received',
          });
        }

        // Webhook pesan masuk
        if (dev.webhook_url && !fromMe) {
          fireWebhook(dev.webhook_url, {
            event: 'message', device_id: deviceId, sender: jid,
            name: msg.pushName || null, message: text, is_group: isGroup,
          });
        }
        // Webhook chaining: teruskan mentah
        if (dev.webhook_chaining_url && !fromMe) {
          fireWebhook(dev.webhook_chaining_url, {
            event: 'chaining', device_id: deviceId, raw: msg,
          });
        }

        if (!text) continue;

        // 1) Flow builder dulu (jika ada yang cocok)
        const handled = await runFlows(dev, s.sock, { jid, text, isGroup, fromMe });
        if (handled) continue;

        // 2) Autoreply klasik
        const scopeOk = isGroup ? dev.ar_group : dev.ar_personal;
        if (scopeOk && !fromMe) {
          const { rows } = await pool.query(
            'SELECT * FROM autoreplies WHERE device_id = $1 AND active = TRUE',
            [deviceId]
          );
          const lower = text.toLowerCase();
          for (const rule of rows) {
            const kw = rule.keyword.toLowerCase();
            const matched = rule.match_mode === 'exact' ? lower === kw : lower.includes(kw);
            if (matched) {
              await s.sock.sendMessage(jid, { text: rule.response });
              await logMessage({
                userId: dev.user_id, deviceId, direction: 'out', jid,
                text: rule.response, status: 'autoreply',
              });
              break;
            }
          }
        }
      } catch (e) {
        console.error(`[device ${deviceId}] message handler error:`, e.message);
      }
    }
  });

  return s.sock;
}

/** Saat server start: sambungkan semua device yang punya session */
export async function connectAllSessions() {
  const { rows } = await pool.query('SELECT device_id FROM session_creds');
  // Sambungkan bertahap agar tidak overload saat startup
  for (let i = 0; i < rows.length; i++) {
    const { device_id } = rows[i];
    setTimeout(() => {
      connectDevice(device_id).catch((e) =>
        console.error(`[device ${device_id}] boot connect error:`, e.message)
      );
    }, i * 2000); // jeda 2 detik antar device
  }
  console.log(`[WA] ${rows.length} session tersimpan disambungkan bertahap`);
}

/**
 * Watchdog: cek semua device yang harusnya connected tapi socket-nya mati.
 * Dipanggil dari cron di index.js setiap 5 menit.
 */
export async function watchdogReconnect() {
  const INACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 menit tanpa aktivitas = curigai mati
  const now = Date.now();

  for (const [deviceId, s] of sessions.entries()) {
    try {
      // Hanya cek device yang statusnya 'connected'
      if (s.status !== 'connected') continue;

      // Cek apakah socket masih ada dan tidak dalam proses reconnect
      const socketAlive = s.sock && s.sock.user;
      const lastAct = s.lastActivity || 0;
      const inactive = now - lastAct > INACTIVE_THRESHOLD;

      if (!socketAlive || inactive) {
        console.log(`[watchdog] Device ${deviceId} tidak responsif (socketAlive=${socketAlive}, inactive=${inactive}), reconnect...`);
        s.status = 'disconnected';
        s.reconnecting = false;
        if (s.sock) {
          try { s.sock.end(); } catch {}
          s.sock = null;
        }
        await connectDevice(deviceId);
      }
    } catch (e) {
      console.error(`[watchdog] Error device ${deviceId}:`, e.message);
    }
  }
}

/** Normalisasi nomor: 08xxx -> 628xxx@s.whatsapp.net, group ID tetap @g.us */
export function toJid(number) {
  let n = String(number).trim();
  if (n.endsWith('@g.us')) return n;
  if (n.endsWith('@s.whatsapp.net')) return n;
  n = n.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  return `${n}@s.whatsapp.net`;
}

function requireConnected(deviceId) {
  const s = getOrCreate(deviceId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error('Device belum terhubung. Scan QR dulu di dashboard.');
  }
  touchActivity(deviceId);
  return s.sock;
}

export async function sendText(deviceId, number, text) {
  const sock = requireConnected(deviceId);
  const jid = toJid(number);
  await sock.sendMessage(jid, { text });
  return jid;
}

/**
 * Kirim media. media = { buffer?, url?, mimetype, fileName?, caption?, kind? }
 */
export async function sendMedia(deviceId, number, media) {
  const sock = requireConnected(deviceId);
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

/** Daftar grup WhatsApp yang diikuti device */
export async function listGroups(deviceId) {
  const sock = requireConnected(deviceId);
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject, participants: g.participants?.length ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function logoutDevice(deviceId) {
  const s = getOrCreate(deviceId);
  if (s.sock) {
    try { await s.sock.logout(); } catch {}
  }
  await clearAuthState(deviceId);
  await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]);
  s.status = 'idle';
  s.qrDataUrl = null;
  s.me = null;
  s.sock = null;
}

export function removeSession(deviceId) {
  const s = sessions.get(deviceId);
  if (s?.sock) {
    try { s.sock.end(); } catch {}
  }
  sessions.delete(deviceId);
}

export function guessMimetype(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

/** Pairing via 8-digit code (no QR). Nomor harus format internasional tanpa +, misal 628xxx */
export async function requestPairingCode(deviceId, phoneNumber) {
  const s = getOrCreate(deviceId);
  const device = await getDevice(deviceId);
  if (!device) throw new Error('Device tidak ditemukan');

  const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!cleanNumber || cleanNumber.length < 10) throw new Error('Nomor tidak valid');

  if (s.sock) {
    try { s.sock.end(); } catch {}
    s.sock = null;
  }

  s.status = 'starting';
  s.qrDataUrl = null;

  const { state, saveCreds } = await useDbAuthState(deviceId);
  const version = await getBaileysVersion();

  s.sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Synpera', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
  });

  s.sock.ev.on('creds.update', saveCreds);

  let code = null;
  await new Promise((resolve) => {
    setTimeout(async () => {
      try {
        code = await s.sock.requestPairingCode(cleanNumber);
        console.log(`[device ${deviceId}] Pairing code: ${code}`);
        resolve();
      } catch (e) {
        console.error(`[device ${deviceId}] requestPairingCode error:`, e.message);
        resolve();
      }
    }, 2000);
  });

  s.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    touchActivity(deviceId);
    if (connection === 'open') {
      s.status = 'connected';
      s.qrDataUrl = null;
      s.me = s.sock.user;
      s.reconnecting = false;
      const number = (s.sock.user?.id || '').split(':')[0];
      await pool.query('UPDATE devices SET number = $1 WHERE id = $2', [number, deviceId]);
      console.log(`[device ${deviceId}] Terhubung (code) sebagai`, number);
      fireWebhook(device.webhook_connect_url, { event: 'connect', device_id: deviceId, number, status: 'connected' });
    }
    if (connection === 'close') {
      const code2 = lastDisconnect?.error?.output?.statusCode;
      s.status = 'disconnected';
      s.me = null;
      s.sock = null;
      if (code2 === DisconnectReason.loggedOut) {
        await clearAuthState(deviceId);
        await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]);
        return;
      }
      if (!s.reconnecting) {
        s.reconnecting = true;
        const delay = 5000 + Math.random() * 5000;
        setTimeout(() => {
          s.reconnecting = false;
          connectDevice(deviceId).catch(() => {});
        }, delay);
      }
    }
  });

  return code;
}
