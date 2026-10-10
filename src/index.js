import 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import { initDb, pool, logMessage, createDevice, getDevice } from './db.js';
import {
  register, login, logoutSession,
  requireLogin, tokenAuth, regenerateToken,
  forgotPassword, verifyResetToken, resetPassword, 
} from './auth.js';
import {
  connectDevice, connectAllSessions, getState,
  sendText, sendMedia, toJid, logoutDevice, listGroups,
  removeSession, guessMimetype,
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
  connectDevice(d.id).catch(() => {});
  res.json({ status: true });
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
  .then(() => connectAllSessions())
  .then(() => {
    app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
  })
  .catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
