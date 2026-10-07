import 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { initDb, pool, logMessage } from './db.js';
import {
  register, login, logoutSession,
  requireLogin, tokenAuth, regenerateToken,
} from './auth.js';
import {
  connectUser, connectAllSessions, getState,
  sendText, sendMedia, toJid, logoutUser,
} from './wa.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// ---------- Halaman ----------
app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));
app.get('/login', (req, res) => res.sendFile('login.html', { root: 'public' }));
app.get('/register', (req, res) => res.sendFile('register.html', { root: 'public' }));
app.get('/dashboard', (req, res) => res.sendFile('dashboard.html', { root: 'public' }));

// ---------- Health & statistik publik (untuk landing page) ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/public/stats', async (req, res) => {
  try {
    const [u, d, m] = await Promise.all([
      pool.query('SELECT count(*)::int AS c FROM users'),
      pool.query('SELECT count(*)::int AS c FROM auth_creds'),
      pool.query('SELECT count(*)::int AS c FROM message_logs'),
    ]);
    res.json({
      users: u.rows[0].c,
      devices: d.rows[0].c,
      messages: m.rows[0].c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Auth ----------
app.post('/auth/register', register);
app.post('/auth/login', login);
app.post('/auth/logout', logoutSession);

// ---------- Dashboard (per user, wajib login) ----------
app.get('/me', requireLogin, (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    api_token: req.user.api_token,
    wa: getState(req.user.id),
  });
});

app.post('/me/regenerate-token', requireLogin, regenerateToken);

app.get('/me/status', requireLogin, (req, res) => {
  res.json(getState(req.user.id));
});

app.post('/me/connect', requireLogin, async (req, res) => {
  try {
    connectUser(req.user.id).catch(() => {});
    res.json({ status: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/me/disconnect', requireLogin, async (req, res) => {
  await logoutUser(req.user.id);
  res.json({ status: true });
});

// Kirim pesan dari dashboard (login)
app.post('/me/send', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const { target, message } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target wajib diisi' });
    if (req.file) {
      const { jid, kind } = await sendMedia(req.user.id, target, {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        fileName: req.file.originalname,
        caption: message,
      });
      await logMessage({
        userId: req.user.id, direction: 'out', jid,
        text: message || req.file.originalname, mediaType: kind, status: 'sent',
      });
      return res.json({ status: true, target: jid, media: kind });
    }
    if (!message) return res.status(400).json({ error: 'message wajib diisi' });
    const jid = await sendText(req.user.id, target, message);
    await logMessage({ userId: req.user.id, direction: 'out', jid, text: message, status: 'sent' });
    res.json({ status: true, target: jid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/me/logs', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM message_logs WHERE user_id = $1 ORDER BY id DESC LIMIT 100',
    [req.user.id]
  );
  res.json(rows);
});

app.get('/me/autoreplies', requireLogin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM autoreplies WHERE user_id = $1 ORDER BY id DESC',
    [req.user.id]
  );
  res.json(rows);
});

app.post('/me/autoreplies', requireLogin, async (req, res) => {
  const { keyword, response, match_mode } = req.body || {};
  if (!keyword || !response) return res.status(400).json({ error: 'keyword & response wajib' });
  const { rows } = await pool.query(
    'INSERT INTO autoreplies (user_id, keyword, response, match_mode) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.user.id, keyword, response, match_mode === 'exact' ? 'exact' : 'contains']
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
  const { rows } = await pool.query(
    'SELECT * FROM schedules WHERE user_id = $1 ORDER BY run_at DESC LIMIT 100',
    [req.user.id]
  );
  res.json(rows);
});

app.delete('/me/schedules/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM schedules WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ status: true });
});

// ---------- API publik untuk developer (via token, seperti Fonnte) ----------
// Kirim teks / media via JSON + media_url, atau multipart form-data + file
app.post('/api/send', tokenAuth, upload.single('file'), async (req, res) => {
  try {
    const { target, message, media_url, filename } = req.body || {};
    if (!target) return res.status(400).json({ status: false, error: 'target wajib diisi' });

    if (req.file) {
      const { jid, kind } = await sendMedia(req.user.id, target, {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        fileName: req.file.originalname,
        caption: message,
      });
      await logMessage({
        userId: req.user.id, direction: 'out', jid,
        text: message || req.file.originalname, mediaType: kind, status: 'api',
      });
      return res.json({ status: true, target: jid, media: kind });
    }

    if (media_url) {
      const { jid, kind } = await sendMedia(req.user.id, target, {
        url: media_url,
        mimetype: guessMimetype(media_url),
        fileName: filename,
        caption: message,
      });
      await logMessage({
        userId: req.user.id, direction: 'out', jid,
        text: message || media_url, mediaType: kind, status: 'api',
      });
      return res.json({ status: true, target: jid, media: kind });
    }

    if (!message) return res.status(400).json({ status: false, error: 'message wajib diisi' });
    const jid = await sendText(req.user.id, target, message);
    await logMessage({ userId: req.user.id, direction: 'out', jid, text: message, status: 'api' });
    res.json({ status: true, target: jid });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

function guessMimetype(url) {
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

app.post('/api/broadcast', tokenAuth, async (req, res) => {
  try {
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
            await sendMedia(req.user.id, t, {
              url: media_url, mimetype: guessMimetype(media_url), caption: message,
            });
          } else {
            await sendText(req.user.id, t, message);
          }
          await logMessage({
            userId: req.user.id, direction: 'out', jid,
            text: message || media_url, status: 'broadcast',
          });
        } catch (e) {
          await logMessage({
            userId: req.user.id, direction: 'out', jid,
            text: message || media_url, status: 'failed: ' + e.message,
          });
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
      'INSERT INTO schedules (user_id, jid, text, run_at) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user.id, toJid(target), message, new Date(run_at)]
    );
    res.json({ status: true, schedule_id: rows[0].id });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
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
        await sendText(s.user_id, s.jid, s.text);
        await logMessage({ userId: s.user_id, direction: 'out', jid: s.jid, text: s.text, status: 'scheduled' });
      } catch (e) {
        await logMessage({ userId: s.user_id, direction: 'out', jid: s.jid, text: s.text, status: 'failed: ' + e.message });
      }
    }
  } catch (e) {
    console.error('cron error:', e.message);
  }
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
