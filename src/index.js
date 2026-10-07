import 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { initDb, pool, logMessage } from './db.js';
import { connectWA, sendText, waState, toJid, logout } from './wa.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-dev-token';

// ---------- Middleware auth ----------
function adminOnly(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.admin_token;
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: 'Admin token salah' });
  next();
}

async function tokenAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-token'];
  if (!token) return res.status(401).json({ error: 'Token API diperlukan' });
  const { rows } = await pool.query(
    'SELECT * FROM tokens WHERE token = $1 AND active = TRUE',
    [token]
  );
  if (!rows.length) return res.status(403).json({ error: 'Token tidak valid / nonaktif' });
  req.tokenRow = rows[0];
  next();
}

// ---------- Public / health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, wa: waState.status, time: new Date().toISOString() });
});

// ---------- API untuk pemegang token (seperti Fonnte) ----------
app.post('/api/send', tokenAuth, async (req, res) => {
  try {
    const { target, message } = req.body || {};
    if (!target || !message) {
      return res.status(400).json({ error: 'target dan message wajib diisi' });
    }
    const jid = await sendText(target, message);
    await logMessage({
      direction: 'out', jid, text: message,
      status: 'sent', tokenName: req.tokenRow.name,
    });
    res.json({ status: true, message: 'Terkirim', target: jid });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

app.post('/api/broadcast', tokenAuth, async (req, res) => {
  try {
    const { targets, message, delay_ms } = req.body || {};
    if (!Array.isArray(targets) || !targets.length || !message) {
      return res.status(400).json({ error: 'targets (array) dan message wajib diisi' });
    }
    if (targets.length > 100) {
      return res.status(400).json({ error: 'Maksimal 100 nomor per request (anti-banned)' });
    }
    const delay = Math.max(Number(delay_ms) || 3000, 2000); // min 2 detik
    res.json({ status: true, message: `Broadcast ke ${targets.length} nomor dimulai di background` });

    // Proses di background dengan jeda acak agar aman
    (async () => {
      for (const t of targets) {
        try {
          const jid = await sendText(t, message);
          await logMessage({
            direction: 'out', jid, text: message,
            status: 'broadcast', tokenName: req.tokenRow.name,
          });
        } catch (e) {
          await logMessage({
            direction: 'out', jid: toJid(t), text: message,
            status: 'failed: ' + e.message, tokenName: req.tokenRow.name,
          });
        }
        await new Promise((r) => setTimeout(r, delay + Math.random() * 2000));
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
      return res.status(400).json({ error: 'target, message, run_at (ISO date) wajib diisi' });
    }
    const { rows } = await pool.query(
      'INSERT INTO schedules (jid, text, run_at) VALUES ($1,$2,$3) RETURNING id',
      [toJid(target), message, new Date(run_at)]
    );
    res.json({ status: true, schedule_id: rows[0].id });
  } catch (e) {
    res.status(500).json({ status: false, error: e.message });
  }
});

// ---------- Admin (dashboard) ----------
app.get('/admin/status', adminOnly, (req, res) => {
  res.json({
    status: waState.status,
    qr: waState.qrDataUrl,
    me: waState.me,
  });
});

app.post('/admin/logout', adminOnly, async (req, res) => {
  await logout();
  res.json({ status: true });
});

app.get('/admin/tokens', adminOnly, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tokens ORDER BY id DESC');
  res.json(rows);
});

app.post('/admin/tokens', adminOnly, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib diisi' });
  const token = 'wgt_' + crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    'INSERT INTO tokens (token, name) VALUES ($1,$2) RETURNING *',
    [token, name]
  );
  res.json(rows[0]);
});

app.post('/admin/tokens/:id/toggle', adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE tokens SET active = NOT active WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  res.json(rows[0] || {});
});

app.delete('/admin/tokens/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM tokens WHERE id = $1', [req.params.id]);
  res.json({ status: true });
});

app.get('/admin/logs', adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM message_logs ORDER BY id DESC LIMIT 100'
  );
  res.json(rows);
});

app.get('/admin/autoreplies', adminOnly, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM autoreplies ORDER BY id DESC');
  res.json(rows);
});

app.post('/admin/autoreplies', adminOnly, async (req, res) => {
  const { keyword, response, match_mode } = req.body || {};
  if (!keyword || !response) return res.status(400).json({ error: 'keyword & response wajib' });
  const { rows } = await pool.query(
    'INSERT INTO autoreplies (keyword, response, match_mode) VALUES ($1,$2,$3) RETURNING *',
    [keyword, response, match_mode === 'exact' ? 'exact' : 'contains']
  );
  res.json(rows[0]);
});

app.post('/admin/autoreplies/:id/toggle', adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE autoreplies SET active = NOT active WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  res.json(rows[0] || {});
});

app.delete('/admin/autoreplies/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM autoreplies WHERE id = $1', [req.params.id]);
  res.json({ status: true });
});

app.get('/admin/schedules', adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM schedules ORDER BY run_at DESC LIMIT 100'
  );
  res.json(rows);
});

app.delete('/admin/schedules/:id', adminOnly, async (req, res) => {
  await pool.query('DELETE FROM schedules WHERE id = $1', [req.params.id]);
  res.json({ status: true });
});

// ---------- Cron: jalankan pesan terjadwal tiap menit ----------
cron.schedule('* * * * *', async () => {
  try {
    const { rows } = await pool.query(
      `UPDATE schedules SET done = TRUE
       WHERE done = FALSE AND run_at <= now()
       RETURNING *`
    );
    for (const s of rows) {
      try {
        await sendText(s.jid, s.text);
        await logMessage({ direction: 'out', jid: s.jid, text: s.text, status: 'scheduled' });
      } catch (e) {
        await logMessage({ direction: 'out', jid: s.jid, text: s.text, status: 'failed: ' + e.message });
      }
    }
  } catch (e) {
    console.error('cron error:', e.message);
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => connectWA())
  .then(() => {
    app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
  })
  .catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
