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

const makeWASocket = baileysDefault?.default ?? baileysDefault;
const logger = pino({ level: 'warn' });

/**
 * sessions: Map<deviceId, SessionState>
 * SessionState: { sock, status, qrDataUrl, me, reconnectTimer, lastActivity }
 * status: 'idle' | 'starting' | 'qr' | 'connected' | 'disconnected'
 */
const sessions = new Map();

// ─── Cache versi Baileys ─────────────────────────────────────────────────────
let _cachedVersion = null;
async function getBaileysVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    _cachedVersion = version;
    return version;
  } catch {
    _cachedVersion = [2, 3000, 1015];
    return _cachedVersion;
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────
function getOrCreate(deviceId) {
  if (!sessions.has(deviceId)) {
    sessions.set(deviceId, {
      sock: null,
      status: 'idle',
      qrDataUrl: null,
      me: null,
      reconnectTimer: null,
      lastActivity: Date.now(),
    });
  }
  return sessions.get(deviceId);
}

function clearReconnectTimer(s) {
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
}

function touchActivity(deviceId) {
  const s = sessions.get(deviceId);
  if (s) s.lastActivity = Date.now();
}

async function fireWebhook(url, payload) {
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {}
}

// ─── Export: getState ─────────────────────────────────────────────────────────
export function getState(deviceId) {
  const s = sessions.get(deviceId);
  if (!s) return { status: 'idle', qr: null, me: null };
  return { status: s.status, qr: s.qrDataUrl, me: s.me };
}

// ─── Tutup socket dengan bersih ───────────────────────────────────────────────
function closeSocket(s) {
  if (s.sock) {
    try { s.sock.ev.removeAllListeners(); } catch {}
    try { s.sock.end(); } catch {}
    s.sock = null;
  }
}

// ─── connectDevice ────────────────────────────────────────────────────────────
export async function connectDevice(deviceId) {
  const s = getOrCreate(deviceId);
  const device = await getDevice(deviceId);
  if (!device) throw new Error('Device tidak ditemukan');

  // Batalkan timer reconnect yang pending
  clearReconnectTimer(s);

  // Tutup socket lama — apapun statusnya, buat yang baru
  closeSocket(s);

  s.status = 'starting';
  s.qrDataUrl = null;
  s.lastActivity = Date.now();

  const { state, saveCreds } = await useDbAuthState(deviceId);
  const version = await getBaileysVersion();

  const sock = makeWASocket({
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

  s.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // Abaikan event dari socket lama
    if (s.sock !== sock) return;

    const { connection, lastDisconnect, qr } = update;
    touchActivity(deviceId);

    if (qr) {
      s.status = 'qr';
      s.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
    }

    if (connection === 'open') {
      clearReconnectTimer(s);
      s.status = 'connected';
      s.qrDataUrl = null;
      s.me = sock.user;
      const number = (sock.user?.id || '').split(':')[0];
      try {
        await pool.query('UPDATE devices SET number = $1 WHERE id = $2', [number, deviceId]);
      } catch {}
      fireWebhook(device.webhook_connect_url, {
        event: 'connect', device_id: deviceId, number, status: 'connected',
      });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || '';
      const prevStatus = s.status;

      s.status = 'disconnected';
      s.me = null;
      s.qrDataUrl = null;

      fireWebhook(device.webhook_connect_url, {
        event: 'disconnect', device_id: deviceId, status: 'disconnected',
      });

      // Logout: hapus session, jangan reconnect
      if (code === DisconnectReason.loggedOut) {
        closeSocket(s);
        await clearAuthState(deviceId);
        await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]).catch(() => {});
        s.status = 'idle';
        return;
      }

      // QR expired / dibatalkan user: jangan auto-reconnect
      if (prevStatus === 'qr' || prevStatus === 'starting') {
        closeSocket(s);
        return;
      }

      // Conflict (diambil alih perangkat lain): reconnect dengan delay lebih panjang
      const isConflict = code === DisconnectReason.connectionReplaced
        || errMsg.toLowerCase().includes('conflict')
        || errMsg.toLowerCase().includes('replaced');
      const delay = isConflict ? 20000 : (5000 + Math.random() * 5000);

      closeSocket(s);
      clearReconnectTimer(s);
      s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        connectDevice(deviceId).catch(() => {});
      }, delay);
    }
  });

  // Webhook message status
  sock.ev.on('messages.update', (updates) => {
    if (s.sock !== sock) return;
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
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (s.sock !== sock) return;
    touchActivity(deviceId);
    if (type !== 'notify') return;
    const dev = await getDevice(deviceId);
    if (!dev) return;

    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const fromMe = !!msg.key.fromMe;
        if (fromMe && !dev.quick_reply) continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || '';
        const hasMedia = !!(
          msg.message?.imageMessage || msg.message?.videoMessage ||
          msg.message?.audioMessage || msg.message?.documentMessage
        );
        if (!text && !hasMedia) continue;

        if (dev.autoread && !dev.silent_read && !fromMe) {
          try { await sock.readMessages([msg.key]); } catch {}
        }
        if ((dev.inbox_enabled || dev.autodelete) && !fromMe) {
          await logMessage({ userId: dev.user_id, deviceId, direction: 'in', jid, text: text || '[media]', status: 'received' });
        }
        if (dev.webhook_url && !fromMe) {
          fireWebhook(dev.webhook_url, { event: 'message', device_id: deviceId, sender: jid, name: msg.pushName || null, message: text, is_group: isGroup });
        }
        if (dev.webhook_chaining_url && !fromMe) {
          fireWebhook(dev.webhook_chaining_url, { event: 'chaining', device_id: deviceId, raw: msg });
        }
        if (!text) continue;

        const handled = await runFlows(dev, sock, { jid, text, isGroup, fromMe });
        if (handled) continue;

        const scopeOk = isGroup ? dev.ar_group : dev.ar_personal;
        if (scopeOk && !fromMe) {
          const { rows } = await pool.query(
            'SELECT * FROM autoreplies WHERE device_id = $1 AND active = TRUE', [deviceId]
          );
          const lower = text.toLowerCase();
          for (const rule of rows) {
            const kw = rule.keyword.toLowerCase();
            const matched = rule.match_mode === 'exact' ? lower === kw : lower.includes(kw);
            if (matched) {
              await sock.sendMessage(jid, { text: rule.response });
              await logMessage({ userId: dev.user_id, deviceId, direction: 'out', jid, text: rule.response, status: 'autoreply' });
              break;
            }
          }
        }
      } catch (e) {
        console.error(`[device ${deviceId}] message handler error:`, e.message);
      }
    }
  });

  return sock;
}

// ─── connectAllSessions ───────────────────────────────────────────────────────
export async function connectAllSessions() {
  const { rows } = await pool.query('SELECT device_id FROM session_creds');
  for (let i = 0; i < rows.length; i++) {
    const { device_id } = rows[i];
    setTimeout(() => {
      connectDevice(device_id).catch((e) =>
        console.error(`[device ${device_id}] boot connect error:`, e.message)
      );
    }, i * 2000);
  }
}

// ─── watchdogReconnect ────────────────────────────────────────────────────────
export async function watchdogReconnect() {
  const THRESHOLD = 12 * 60 * 1000; // 12 menit
  const now = Date.now();
  for (const [deviceId, s] of sessions.entries()) {
    try {
      if (s.status !== 'connected') continue;
      const alive = s.sock && s.sock.user;
      const inactive = now - (s.lastActivity || 0) > THRESHOLD;
      if (!alive || inactive) {
        console.log(`[watchdog] Device ${deviceId} tidak responsif, reconnect`);
        connectDevice(deviceId).catch(() => {});
      }
    } catch {}
  }
}

// ─── toJid ────────────────────────────────────────────────────────────────────
export function toJid(number) {
  let n = String(number).trim();
  if (n.endsWith('@g.us') || n.endsWith('@s.whatsapp.net')) return n;
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
  await sock.sendMessage(toJid(number), { text });
  return toJid(number);
}

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
  if (kind === 'document') { payload.mimetype = mt; payload.fileName = media.fileName || 'file'; }
  if (kind === 'audio') payload.mimetype = mt;
  await sock.sendMessage(jid, payload);
  return { jid, kind };
}

export async function listGroups(deviceId) {
  const sock = requireConnected(deviceId);
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject, participants: g.participants?.length ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function logoutDevice(deviceId) {
  const s = getOrCreate(deviceId);
  clearReconnectTimer(s);
  if (s.sock) {
    try { await s.sock.logout(); } catch {}
  }
  closeSocket(s);
  await clearAuthState(deviceId);
  await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]).catch(() => {});
  s.status = 'idle';
  s.qrDataUrl = null;
  s.me = null;
}

export function removeSession(deviceId) {
  const s = sessions.get(deviceId);
  if (s) {
    clearReconnectTimer(s);
    closeSocket(s);
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

export async function requestPairingCode(deviceId, phoneNumber) {
  const s = getOrCreate(deviceId);
  const device = await getDevice(deviceId);
  if (!device) throw new Error('Device tidak ditemukan');

  const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!cleanNumber || cleanNumber.length < 10) throw new Error('Nomor tidak valid');

  clearReconnectTimer(s);
  closeSocket(s);
  s.status = 'starting';
  s.qrDataUrl = null;

  const { state, saveCreds } = await useDbAuthState(deviceId);
  const version = await getBaileysVersion();

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: ['Synpera', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
  });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  // Tunggu socket siap lalu minta kode
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let code = null;
  try {
    code = await sock.requestPairingCode(cleanNumber);
  } catch (e) {
    console.error(`[device ${deviceId}] requestPairingCode error:`, e.message);
  }

  sock.ev.on('connection.update', async (update) => {
    if (s.sock !== sock) return;
    const { connection, lastDisconnect } = update;
    touchActivity(deviceId);
    if (connection === 'open') {
      clearReconnectTimer(s);
      s.status = 'connected';
      s.me = sock.user;
      const number = (sock.user?.id || '').split(':')[0];
      await pool.query('UPDATE devices SET number = $1 WHERE id = $2', [number, deviceId]).catch(() => {});
      fireWebhook(device.webhook_connect_url, { event: 'connect', device_id: deviceId, number, status: 'connected' });
    }
    if (connection === 'close') {
      const code2 = lastDisconnect?.error?.output?.statusCode;
      s.status = 'disconnected';
      s.me = null;
      closeSocket(s);
      if (code2 === DisconnectReason.loggedOut) {
        await clearAuthState(deviceId);
        await pool.query('UPDATE devices SET number = NULL WHERE id = $1', [deviceId]).catch(() => {});
        s.status = 'idle';
        return;
      }
      clearReconnectTimer(s);
      s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        connectDevice(deviceId).catch(() => {});
      }, 7000);
    }
  });

  return code;
}
