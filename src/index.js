import 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import { initDb, pool, logMessage, createDevice, getDevice, migrateNewTables } from './db.js';
import {
  register, login, logoutSession,
  requireLogin, tokenAuth, regenerateToken,
  forgotPassword, verifyResetToken, resetPassword, 
} from './auth.js';
import {
  connectDevice, connectAllSessions, getState,
  sendText, sendMedia, toJid, logoutDevice, listGroups,
  removeSession, guessMimetype, requestPairingCode, watchdogReconnect,
} from './wa.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// ---------- Halaman ----------
app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));
app.get('/login', (req, res) => res.sendFile('login.html', { root: 'public' }));
app.get('/register', (req, res) => res.sendFile('register.html', { root: 'public' }));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));
app.get('/flow', (req, res) => res.sendFile('flow.html', { root: 'public' }));
app.get('/reset-password', (req, res) => res.sendFile('reset-password.html', { root: 'public' }));

// ---------- Health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- Auth ----------
app.post('/auth/register', register);
app.post('/auth/login', login);
app.post('/auth/logout', logoutSession);
app.post('/auth/forgot-password', forgotPassword);
app.get('/auth/verify-reset-token', verifyResetToken);
app.post('/auth/reset-password', resetPassword);

app.get('/me', requireLogin, (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    api_token: req.user.api_token,
  });
});
app.post('/me/regenerate-token', requireLogin, regenerateToken);

// ---------- Helper: device milik user ----------
async function ownDevice(req, res) {
  const d = await getDevice(Number(req.params.id));
  if (!d || d.user_id !== req.user.id) {
    res.status(404).json({ error: 'Device tidak ditemukan' });
    return null;
  }
  return d;
}

// ---------- Devices ----------
app.get('/me/devices', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM devices WHERE user_id = $1 ORDER BY id',
    [req.user.id]
  );
  res.json(rows.map((d) => ({ ...d, state: getState(d.id) })));
});

app.post('/me/devices', requireLogin, async (req, res) => {
  try {
    const count = await pool.query('SELECT count(*)::int AS c FROM devices WHERE user_id = $1', [req.user.id]);
    if (count.rows[0].c >= 5) {
      return res.status(400).json({ error: 'Maksimal 5 device per akun' });
    }
    const d = await createDevice(req.user.id, req.body?.name?.trim());
    res.json({ ...d, state: getState(d.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/me/devices/:id', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE devices SET
       name = $2, whitelist_ip = $3, webhook_url = $4, webhook_connect_url = $5,
       webhook_status_url = $6, webhook_chaining_url = $7, autoread = $8,
       silent_read = $9, inbox_enabled = $10, ar_personal = $11, ar_group = $12,
       quick_reply = $13, forward_attachment = $14, forward_number = $15, autodelete = $16
     WHERE id = $1 RETURNING *`,
    [
      d.id,
      b.name?.trim() || d.name,
      b.whitelist_ip ?? d.whitelist_ip,
      b.webhook_url ?? d.webhook_url,
      b.webhook_connect_url ?? d.webhook_connect_url,
      b.webhook_status_url ?? d.webhook_status_url,
      b.webhook_chaining_url ?? d.webhook_chaining_url,
      !!b.autoread, !!b.silent_read, !!b.inbox_enabled,
      !!b.ar_personal, !!b.ar_group, !!b.quick_reply,
      !!b.forward_attachment, b.forward_number ?? d.forward_number,
      !!b.autodelete,
    ]
  );
  res.json(rows[0]);
});

app.delete('/me/devices/:id', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  await logoutDevice(d.id);
  removeSession(d.id);
  await pool.query('DELETE FROM devices WHERE id = $1', [d.id]);
  res.json({ status: true });
});

app.post('/me/devices/:id/connect', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  // Jalankan connect lalu tunggu sampai QR/connected tersedia (maks 20 detik)
  connectDevice(d.id).catch(() => {});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(800);
    const st = getState(d.id);
    if (st.status === 'qr' || st.status === 'connected') {
      return res.json({ status: true, state: st });
    }
  }
  // Timeout: kembalikan status terkini apa adanya
  res.json({ status: true, state: getState(d.id) });
});

app.post('/me/devices/:id/disconnect', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  await logoutDevice(d.id);
  res.json({ status: true });
});

app.post('/me/devices/:id/regenerate-token', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  const token = 'syn_' + crypto.randomBytes(20).toString('hex');
  await pool.query('UPDATE devices SET token = $1 WHERE id = $2', [token, d.id]);
  res.json({ status: true, token });
});

app.get('/me/devices/:id/groups', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  try {
    res.json(await listGroups(d.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/me/devices/:id/send', requireLogin, upload.single('file'), async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  try {
    const { target, message } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target wajib diisi' });
    if (req.file) {
      const { jid, kind } = await sendMedia(d.id, target, {
        buffer: req.file.buffer, mimetype: req.file.mimetype,
        fileName: req.file.originalname, caption: message,
      });
      await logMessage({
        userId: req.user.id, deviceId: d.id, direction: 'out', jid,
        text: message || req.file.originalname, mediaType: kind, status: 'sent',
      });
      return res.json({ status: true, target: jid, media: kind });
    }
    if (!message) return res.status(400).json({ error: 'message wajib diisi' });
    const jid = await sendText(d.id, target, message);
    await logMessage({ userId: req.user.id, deviceId: d.id, direction: 'out', jid, text: message, status: 'sent' });
    res.json({ status: true, target: jid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Autoreply / Logs / Schedules (per device) ----------
function deviceParam(req) {
  return Number(req.query.device) || null;
}

app.get('/me/logs', requireLogin, async (req, res) => {
  const dev = deviceParam(req);
  const { rows } = dev
    ? await pool.query('SELECT * FROM message_logs WHERE device_id = $1 ORDER BY id DESC LIMIT 100', [dev])
    : await pool.query('SELECT * FROM message_logs WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json(rows);
});

app.get('/me/autoreplies', requireLogin, async (req, res) => {
  const dev = deviceParam(req);
  if (!dev) return res.status(400).json({ error: 'parameter device wajib' });
  const { rows } = await pool.query(
    'SELECT * FROM autoreplies WHERE device_id = $1 ORDER BY id DESC', [dev]
  );
  res.json(rows);
});

app.post('/me/autoreplies', requireLogin, async (req, res) => {
  const { device_id, keyword, response, match_mode } = req.body || {};
  if (!device_id || !keyword || !response) return res.status(400).json({ error: 'device_id, keyword & response wajib' });
  const d = await getDevice(Number(device_id));
  if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan device kamu' });
  const { rows } = await pool.query(
    'INSERT INTO autoreplies (user_id, device_id, keyword, response, match_mode) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.id, d.id, keyword, response, match_mode === 'exact' ? 'exact' : 'contains']
  );
  res.json(rows[0]);
});

app.post('/me/autoreplies/:id/toggle', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE autoreplies SET active = NOT active WHERE id = $1 AND user_id = $2 RETURNING *',
    [req.params.id, req.user.id]
  );
  res.json(rows[0] || {});
});

app.delete('/me/autoreplies/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM autoreplies WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ status: true });
});

app.get('/me/schedules', requireLogin, async (req, res) => {
  const dev = deviceParam(req);
  const { rows } = dev
    ? await pool.query('SELECT * FROM schedules WHERE device_id = $1 ORDER BY run_at DESC LIMIT 100', [dev])
    : await pool.query('SELECT * FROM schedules WHERE user_id = $1 ORDER BY run_at DESC LIMIT 100', [req.user.id]);
  res.json(rows);
});

app.delete('/me/schedules/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM schedules WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ status: true });
});

// ---------- Flows ----------
app.get('/me/devices/:id/flows', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  const { rows } = await pool.query('SELECT * FROM flows WHERE device_id = $1 ORDER BY id', [d.id]);
  res.json(rows);
});

app.post('/me/devices/:id/flows', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  const { rows } = await pool.query(
    'INSERT INTO flows (device_id, name, data) VALUES ($1,$2,$3) RETURNING *',
    [d.id, req.body?.name || 'Flow', req.body?.data || { nodes: [], edges: [] }]
  );
  res.json(rows[0]);
});

app.put('/me/flows/:id', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE flows f SET name = $2, data = $3, active = $4
     FROM devices d WHERE f.device_id = d.id AND d.user_id = $5 AND f.id = $1
     RETURNING f.*`,
    [req.params.id, req.body?.name || 'Flow', req.body?.data || { nodes: [], edges: [] }, req.body?.active !== false, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Flow tidak ditemukan' });
  res.json(rows[0]);
});

app.delete('/me/flows/:id', requireLogin, async (req, res) => {
  await pool.query(
    `DELETE FROM flows f USING devices d
     WHERE f.device_id = d.id AND d.user_id = $2 AND f.id = $1`,
    [req.params.id, req.user.id]
  );
  res.json({ status: true });
});

// ---------- API publik (token device, seperti Fonnte) ----------
app.post('/api/send', tokenAuth, upload.single('file'), async (req, res) => {
  try {
    const d = req.device;
    const { target, message, media_url, filename } = req.body || {};
    if (!target) return res.status(400).json({ status: false, error: 'target wajib diisi' });

    if (req.file) {
      const { jid, kind } = await sendMedia(d.id, target, {
        buffer: req.file.buffer, mimetype: req.file.mimetype,
        fileName: req.file.originalname, caption: message,
      });
      await logMessage({
        userId: d.user_id, deviceId: d.id, direction: 'out', jid,
        text: message || req.file.originalname, mediaType: kind, status: 'api',
      });
      return res.json({ status: true, target: jid, media: kind });
    }

    if (media_url) {
      const { jid, kind } = await sendMedia(d.id, target, {
        url: media_url, mimetype: guessMimetype(media_url), fileName: filename, caption: message,
      });
      await logMessage({
        userId: d.user_id, deviceId: d.id, direction: 'out', jid,
        text: message || media_url, mediaType: kind, status: 'api',
      });
      return res.json({ status: true, target: jid, media: kind });
    }

    if (!message) return res.status(400).json({ status: false, error: 'message wajib diisi' });
    const jid = await sendText(d.id, target, message);
    await logMessage({ userId: d.user_id, deviceId: d.id, direction: 'out', jid, text: message, status: 'api' });
    res.json({ status: true, target: jid });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

app.post('/api/broadcast', tokenAuth, async (req, res) => {
  try {
    const d = req.device;
    const { targets, message, media_url, delay_ms } = req.body || {};
    if (!Array.isArray(targets) || !targets.length || (!message && !media_url)) {
      return res.status(400).json({ status: false, error: 'targets (array) dan message/media_url wajib diisi' });
    }
    if (targets.length > 100) {
      return res.status(400).json({ status: false, error: 'Maksimal 100 nomor per request (anti-banned)' });
    }
    const delay = Math.max(Number(delay_ms) || 3000, 2000);
    res.json({ status: true, message: `Broadcast ke ${targets.length} nomor dimulai di background` });

    (async () => {
      for (const t of targets) {
        const jid = toJid(t);
        try {
          if (media_url) {
            await sendMedia(d.id, t, { url: media_url, mimetype: guessMimetype(media_url), caption: message });
          } else {
            await sendText(d.id, t, message);
          }
          await logMessage({ userId: d.user_id, deviceId: d.id, direction: 'out', jid, text: message || media_url, status: 'broadcast' });
        } catch (e) {
          await logMessage({ userId: d.user_id, deviceId: d.id, direction: 'out', jid, text: message || media_url, status: 'failed: ' + e.message });
        }
        await sleep(delay + rand(0, 2000));
      }
    })();
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

app.post('/api/schedule', tokenAuth, async (req, res) => {
  try {
    const { target, message, run_at } = req.body || {};
    if (!target || !message || !run_at) {
      return res.status(400).json({ status: false, error: 'target, message, run_at (ISO date) wajib diisi' });
    }
    const { rows } = await pool.query(
      'INSERT INTO schedules (user_id, device_id, jid, text, run_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.device.user_id, req.device.id, toJid(target), message, new Date(run_at)]
    );
    res.json({ status: true, schedule_id: rows[0].id });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

app.get('/api/device', tokenAuth, (req, res) => {
  const d = req.device;
  res.json({
    status: true,
    device: { id: d.id, name: d.name, number: d.number },
    wa: getState(d.id).status,
  });
});


// ---------- Templates ----------
app.get('/me/templates', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM templates WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  res.json(rows);
});

app.post('/me/templates', requireLogin, async (req, res) => {
  const { name, message } = req.body || {};
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const { rows } = await pool.query(
    'INSERT INTO templates (user_id, name, message) VALUES ($1,$2,$3) RETURNING *',
    [req.user.id, name.trim(), message]
  );
  res.json(rows[0]);
});

app.put('/me/templates/:id', requireLogin, async (req, res) => {
  const { name, message } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE templates SET name=$2, message=$3 WHERE id=$1 AND user_id=$4 RETURNING *',
    [req.params.id, name, message, req.user.id]
  );
  res.json(rows[0] || {});
});

app.delete('/me/templates/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM templates WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ status: true });
});

// ---------- Recurring ----------
app.get('/me/recurring', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT r.*, d.name as device_name FROM recurring_messages r LEFT JOIN devices d ON d.id=r.device_id WHERE r.user_id=$1 ORDER BY r.id DESC',
    [req.user.id]
  );
  res.json(rows);
});

app.post('/me/recurring', requireLogin, async (req, res) => {
  const { device_id, name, target, message, cron_expr } = req.body || {};
  if (!device_id || !target || !message) return res.status(400).json({ error: 'device_id, target, message required' });
  const d = await getDevice(Number(device_id));
  if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: 'Not your device' });
  const { rows } = await pool.query(
    'INSERT INTO recurring_messages (user_id, device_id, name, target, message, cron_expr) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.id, d.id, name || 'Recurring', target, message, cron_expr || '0 9 * * *']
  );
  res.json(rows[0]);
});

app.post('/me/recurring/:id/toggle', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE recurring_messages SET active = NOT active WHERE id=$1 AND user_id=$2 RETURNING *',
    [req.params.id, req.user.id]
  );
  res.json(rows[0] || {});
});

app.delete('/me/recurring/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM recurring_messages WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ status: true });
});

// ---------- Inbox (incoming messages) ----------
app.get('/me/inbox', requireLogin, async (req, res) => {
  const dev = deviceParam(req);
  const { rows } = dev
    ? await pool.query("SELECT * FROM message_logs WHERE device_id=$1 AND direction='in' ORDER BY id DESC LIMIT 200", [dev])
    : await pool.query("SELECT * FROM message_logs WHERE user_id=$1 AND direction='in' ORDER BY id DESC LIMIT 200", [req.user.id]);
  res.json(rows);
});

// ---------- Logs with filter & pagination ----------
app.get('/me/logs/export', requireLogin, async (req, res) => {
  const { device, direction, from, to } = req.query;
  let q = 'SELECT * FROM message_logs WHERE user_id=$1';
  const params = [req.user.id];
  if (device) { params.push(Number(device)); q += ` AND device_id=$${params.length}`; }
  if (direction) { params.push(direction); q += ` AND direction=$${params.length}`; }
  if (from) { params.push(new Date(from)); q += ` AND created_at>=$${params.length}`; }
  if (to) { params.push(new Date(to)); q += ` AND created_at<=$${params.length}`; }
  q += ' ORDER BY id DESC LIMIT 5000';
  const { rows } = await pool.query(q, params);
  
  const csv = ['id,direction,jid,text,media_type,status,created_at',
    ...rows.map(r => [r.id, r.direction, r.jid, (r.text||'').replace(/,/g,'|'), r.media_type||'', r.status||'', r.created_at].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="history.csv"');
  res.send(csv);
});

app.delete('/me/logs', requireLogin, async (req, res) => {
  const { device, ids } = req.body || {};
  if (ids && Array.isArray(ids) && ids.length) {
    await pool.query('DELETE FROM message_logs WHERE id = ANY($1) AND user_id=$2', [ids.map(Number), req.user.id]);
  } else if (device) {
    await pool.query('DELETE FROM message_logs WHERE device_id=$1 AND user_id=$2', [Number(device), req.user.id]);
  } else {
    await pool.query('DELETE FROM message_logs WHERE user_id=$1', [req.user.id]);
  }
  res.json({ status: true });
});

// ---------- Statistics ----------
app.get('/me/stats', requireLogin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE direction='out') as total_sent,
      COUNT(*) FILTER (WHERE direction='in') as total_received,
      COUNT(*) FILTER (WHERE direction='out' AND created_at > now() - interval '7 days') as sent_7d,
      COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') as total_30d
    FROM message_logs WHERE user_id=$1
  `, [req.user.id]);
  const { rows: byDay } = await pool.query(`
    SELECT DATE(created_at) as day, direction, COUNT(*) as cnt
    FROM message_logs WHERE user_id=$1 AND created_at > now() - interval '14 days'
    GROUP BY day, direction ORDER BY day
  `, [req.user.id]);
  res.json({ summary: rows[0], byDay });
});

// ---------- Dashboard Summary ----------
app.get('/me/dashboard', requireLogin, async (req, res) => {
  try {
    const { rows: devRows } = await pool.query('SELECT * FROM devices WHERE user_id=$1', [req.user.id]);
    const { rows: statsRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='out') as total_sent,
        COUNT(*) FILTER (WHERE direction='in') as total_received
      FROM message_logs WHERE user_id=$1
    `, [req.user.id]);
    const { rows: schedRows } = await pool.query(
      "SELECT COUNT(*)::int AS pending FROM schedules WHERE user_id=$1 AND done=FALSE",
      [req.user.id]
    );
    const connected = devRows.filter(d => {
      const { status } = getState(d.id);
      return status === 'connected';
    });
    res.json({
      total_devices: devRows.length,
      connected_devices: connected.length,
      total_sent: Number(statsRows[0]?.total_sent || 0),
      total_received: Number(statsRows[0]?.total_received || 0),
      pending_schedules: schedRows[0]?.pending || 0,
      plan: 'Free', // placeholder
      plan_devices_limit: 5,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------- Pairing Code (Code method) ----------
app.post('/me/devices/:id/pairing-code', requireLogin, async (req, res) => {
  const d = await ownDevice(req, res);
  if (!d) return;
  const { phone_number } = req.body || {};
  if (!phone_number) return res.status(400).json({ error: 'phone_number wajib' });
  try {
    const code = await requestPairingCode(d.id, phone_number);
    if (!code) return res.status(500).json({ error: 'Gagal mendapatkan kode pairing. Pastikan nomor valid dan belum terhubung.' });
    res.json({ status: true, code });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Poll (simpan ke DB) ----------
app.get('/me/polls', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM schedules WHERE user_id=$1 AND text LIKE \'[POLL]%\' ORDER BY id DESC LIMIT 100',
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

app.post('/me/polls/send', requireLogin, async (req, res) => {
  const { device_id, target, name, choices, select_type } = req.body || {};
  if (!device_id || !target || !name || !choices?.length) {
    return res.status(400).json({ error: 'device_id, target, name, choices wajib' });
  }
  const d = await getDevice(Number(device_id));
  if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan device kamu' });
  const s = getState(d.id);
  if (s.status !== 'connected') return res.status(400).json({ error: 'Device belum terhubung' });
  try {
    const { getOrCreate } = await import('./wa.js').catch(() => ({ getOrCreate: null }));
    // Kirim poll via Baileys sock
    const { sessions } = await import('./wa.js').then(m => ({ sessions: m._sessions })).catch(() => ({ sessions: null }));
    // Gunakan sendText sebagai fallback dengan format teks
    const pollText = `📊 *${name}*\n\n${choices.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\n_Pilih satu jawaban:_`;
    const jid = toJid(target);
    await sendText(d.id, target, pollText);
    await logMessage({ userId: req.user.id, deviceId: d.id, direction: 'out', jid, text: `[POLL] ${name}`, status: 'poll' });
    res.json({ status: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------- Rotator ----------
app.post('/me/rotator/send', requireLogin, async (req, res) => {
  const { device_ids, targets, message, delay_ms } = req.body || {};
  if (!device_ids?.length || !targets?.length || !message) {
    return res.status(400).json({ error: 'device_ids, targets, message wajib' });
  }
  // Verifikasi semua device milik user
  for (const did of device_ids) {
    const d = await getDevice(Number(did));
    if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: `Device ${did} bukan milik kamu` });
  }
  const delay = Math.max(Number(delay_ms) || 3000, 2000);
  res.json({ status: true, message: `Rotator ke ${targets.length} target dari ${device_ids.length} device dimulai` });
  (async () => {
    let devIdx = 0;
    for (const t of targets) {
      const did = device_ids[devIdx % device_ids.length];
      devIdx++;
      try {
        const jid = await sendText(did, t, message);
        await logMessage({ userId: req.user.id, deviceId: did, direction: 'out', jid, text: message, status: 'rotator' });
      } catch(e) {
        const jid = toJid(t);
        await logMessage({ userId: req.user.id, deviceId: did, direction: 'out', jid, text: message, status: 'failed: '+e.message });
      }
      await sleep(delay + rand(0, 1000));
    }
  })();
});

// ---------- Follow Up ----------
app.post('/me/followup', requireLogin, async (req, res) => {
  const { device_id, target, message1, message2, delay_hours } = req.body || {};
  if (!device_id || !target || !message1 || !message2) {
    return res.status(400).json({ error: 'device_id, target, message1, message2 wajib' });
  }
  const d = await getDevice(Number(device_id));
  if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan device kamu' });
  const s = getState(d.id);
  if (s.status !== 'connected') return res.status(400).json({ error: 'Device belum terhubung' });
  try {
    const jid = await sendText(d.id, target, message1);
    await logMessage({ userId: req.user.id, deviceId: d.id, direction: 'out', jid, text: message1, status: 'followup-1' });
    // Schedule follow-up message
    const runAt = new Date(Date.now() + (Number(delay_hours) || 24) * 3600000);
    await pool.query(
      'INSERT INTO schedules (user_id, device_id, jid, text, run_at) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, d.id, jid, message2, runAt]
    );
    res.json({ status: true, scheduled_at: runAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------- Chaining ----------
app.post('/me/chaining', requireLogin, async (req, res) => {
  const { device_id, target, steps } = req.body || {};
  if (!device_id || !target || !steps?.length) {
    return res.status(400).json({ error: 'device_id, target, steps wajib' });
  }
  const d = await getDevice(Number(device_id));
  if (!d || d.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan device kamu' });
  const s = getState(d.id);
  if (s.status !== 'connected') return res.status(400).json({ error: 'Device belum terhubung' });
  res.json({ status: true, message: `Chain ${steps.length} pesan dimulai` });
  (async () => {
    let cumulativeMs = 0;
    for (const step of steps) {
      await new Promise(resolve => setTimeout(resolve, cumulativeMs));
      cumulativeMs = (Number(step.wait_minutes) || 0) * 60000;
      try {
        const jid = await sendText(d.id, target, step.message);
        await logMessage({ userId: req.user.id, deviceId: d.id, direction: 'out', jid, text: step.message, status: 'chaining' });
      } catch(e) {
        console.error('[chaining] error:', e.message);
      }
    }
  })();
});

// ---------- Cron: pesan terjadwal tiap menit ----------
cron.schedule('* * * * *', async () => {
  try {
    const { rows } = await pool.query(
      `UPDATE schedules SET done = TRUE
       WHERE done = FALSE AND run_at <= now()
       RETURNING *`
    );
    for (const s of rows) {
      try {
        await sendText(s.device_id, s.jid, s.text);
        await logMessage({ userId: s.user_id, deviceId: s.device_id, direction: 'out', jid: s.jid, text: s.text, status: 'scheduled' });
      } catch (e) {
        await logMessage({ userId: s.user_id, deviceId: s.device_id, direction: 'out', jid: s.jid, text: s.text, status: 'failed: ' + e.message });
      }
    }
  } catch (e) {
    console.error('cron error:', e.message);
  }
});

// Cron: recurring messages - run every minute and check cron expressions
cron.schedule('* * * * *', async () => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM recurring_messages WHERE active = TRUE"
    );
    for (const r of rows) {
      // Simple cron check: only handle "0 H * * *" daily patterns for now
      const now = new Date();
      const [min, hour] = r.cron_expr.split(' ').map(Number);
      if (now.getMinutes() === min && now.getHours() === hour) {
        const lastRun = r.last_run ? new Date(r.last_run) : null;
        const today = now.toDateString();
        if (!lastRun || lastRun.toDateString() !== today) {
          try {
            const jid = toJid(r.target);
            await sendText(r.device_id, r.target, r.message);
            await logMessage({ userId: r.user_id, deviceId: r.device_id, direction: 'out', jid, text: r.message, status: 'recurring' });
            await pool.query('UPDATE recurring_messages SET last_run=now() WHERE id=$1', [r.id]);
          } catch(e) {
            console.error('[recurring] error:', e.message);
          }
        }
      }
    }
  } catch(e) { console.error('recurring cron error:', e.message); }
});

// Cron: autodelete riwayat pesan (per jam, untuk device yang mengaktifkan)
cron.schedule('7 * * * *', async () => {
  try {
    await pool.query(
      `DELETE FROM message_logs ml USING devices d
       WHERE ml.device_id = d.id AND d.autodelete = TRUE AND ml.created_at < now() - interval '1 day'`
    );
  } catch (e) {
    console.error('autodelete error:', e.message);
  }
});

// Cron: watchdog koneksi — cek tiap 5 menit apakah device masih benar-benar connected
cron.schedule('*/5 * * * *', async () => {
  try {
    await watchdogReconnect();
  } catch (e) {
    console.error('watchdog error:', e.message);
  }
});

// ===== Global error handler: jangan crash karena error di satu device =====
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Diabaikan agar server tidak crash:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  // Hanya crash jika bukan error Baileys/WA biasa
  const baileysMsgs = ['Connection Closed', 'connection replaced', 'Stream Errored', 'conflict'];
  const isBaileys = baileysMsgs.some(m => err?.message?.toLowerCase().includes(m.toLowerCase()));
  if (isBaileys) {
    console.error('[uncaughtException] Error Baileys diabaikan:', err.message);
    return; // jangan exit
  }
  console.error('[uncaughtException] Fatal:', err);
  process.exit(1);
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => migrateNewTables())
  .then(() => connectAllSessions())
  .then(() => {
    app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
  })
  .catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
