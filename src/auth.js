import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { pool, claimLegacyData } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_TOKEN || 'wa-gateway-dev-secret';
const COOKIE_NAME = 'wgt_session';

export function generateApiToken() {
  return 'wgt_' + crypto.randomBytes(24).toString('hex');
}

function setSessionCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

export async function register(req, res) {
  try {
    const { name, email, password } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [cleanEmail]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Email sudah terdaftar, silakan login' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, api_token) VALUES ($1,$2,$3,$4) RETURNING id, name, email, api_token',
      [name.trim(), cleanEmail, hash, generateApiToken()]
    );
    const user = rows[0];
    await claimLegacyData(user.id); // migrasi data versi single-user (jika ada)
    setSessionCookie(res, user.id);
    res.json({ status: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Email atau password salah' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Email atau password salah' });
    setSessionCookie(res, rows[0].id);
    res.json({ status: true, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export function logoutSession(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ status: true });
}

/** Middleware: wajib login via cookie dashboard */
export async function requireLogin(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Belum login' });
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, name, email, api_token, created_at FROM users WHERE id = $1',
      [payload.uid]
    );
    if (!rows.length) return res.status(401).json({ error: 'Sesi tidak valid' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Sesi berakhir, silakan login ulang' });
  }
}

/** Middleware: auth via API token device (endpoint publik /api/*) */
export async function tokenAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token API diperlukan' });

    // Token device (syn_...)
    let { rows } = await pool.query('SELECT * FROM devices WHERE token = $1', [token]);

    // Fallback: master token akun (wgt_...) -> pakai device pertama user
    if (!rows.length) {
      const u = await pool.query('SELECT id FROM users WHERE api_token = $1', [token]);
      if (u.rows.length) {
        const d = await pool.query(
          'SELECT * FROM devices WHERE user_id = $1 ORDER BY id LIMIT 1', [u.rows[0].id]
        );
        rows = d.rows;
      }
    }
    if (!rows.length) return res.status(403).json({ error: 'Token tidak valid' });

    const device = rows[0];

    // Whitelist IP (opsional): daftar IP dipisah koma
    if (device.whitelist_ip?.trim()) {
      const allowed = device.whitelist_ip.split(',').map((s) => s.trim()).filter(Boolean);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
      if (!allowed.includes(ip)) {
        return res.status(403).json({ error: `IP ${ip} tidak ada di whitelist` });
      }
    }

    req.device = device;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function regenerateToken(req, res) {
  const token = generateApiToken();
  await pool.query('UPDATE users SET api_token = $1 WHERE id = $2', [token, req.user.id]);
  res.json({ status: true, api_token: token });
}
