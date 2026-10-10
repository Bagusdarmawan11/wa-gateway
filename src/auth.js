import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { pool, claimLegacyData } from './db.js';

const JWT_SECRET  = process.env.JWT_SECRET || process.env.ADMIN_TOKEN || 'wa-gateway-dev-secret';
const COOKIE_NAME = 'wgt_session';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// ===== Helper: kirim email via Nodemailer (SMTP) =====
async function sendMail({ to, subject, html }) {
  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // Verifikasi koneksi SMTP sebelum kirim (lempar error jika credentials salah)
  await transporter.verify();

  const fromAddr = (() => {
    const raw = process.env.SMTP_FROM || '';
    if (raw.includes('<')) return raw;
    if (raw.includes('@')) return `"Synpera" <${raw}>`;
    return `"Synpera" <${process.env.SMTP_USER}>`;
  })();

  await transporter.sendMail({ from: fromAddr, to, subject, html });
}

// ===== Debug: Test kirim email (hanya untuk diagnosa) =====
export async function testEmail(req, res) {
  const { to } = req.query;
  if (!to) return res.status(400).json({ error: 'Tambahkan ?to=email@kamu.com di URL' });

  const config = {
    SMTP_HOST: process.env.SMTP_HOST || '(tidak diset)',
    SMTP_PORT: process.env.SMTP_PORT || '(tidak diset)',
    SMTP_SECURE: process.env.SMTP_SECURE || '(tidak diset)',
    SMTP_USER: process.env.SMTP_USER || '(tidak diset)',
    SMTP_PASS: process.env.SMTP_PASS ? '***' + process.env.SMTP_PASS.slice(-4) : '(tidak diset)',
    SMTP_FROM: process.env.SMTP_FROM || '(tidak diset)',
    APP_URL: APP_URL,
  };

  try {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Step 1: verifikasi koneksi
    await transporter.verify();

    // Step 2: kirim email test
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: '✅ Test Email Synpera',
      html: `<p>Email test berhasil dikirim dari Synpera.<br>Config: <pre>${JSON.stringify(config, null, 2)}</pre></p>`,
    });

    res.json({ status: true, message: 'Email berhasil dikirim!', messageId: info.messageId, config });
  } catch (e) {
    res.status(500).json({
      status: false,
      error: e.message,
      errorCode: e.code,
      config,
      hint: getSmtpHint(e),
    });
  }
}

function getSmtpHint(e) {
  const msg = e.message || '';
  if (msg.includes('Invalid login') || msg.includes('Authentication')) {
    return 'SMTP_USER atau SMTP_PASS salah. Untuk Brevo: SMTP_USER harus email akun Brevo kamu (bukan email lain), SMTP_PASS adalah SMTP key dari dashboard Brevo (SMTP & API → Generate SMTP key).';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
    return 'Tidak bisa terhubung ke SMTP server. Pastikan SMTP_HOST dan SMTP_PORT benar.';
  }
  if (msg.includes('Sender') || msg.includes('sender') || msg.includes('not allowed')) {
    return 'Sender email (SMTP_FROM) belum diverifikasi di Brevo. Buka Brevo → Senders & IP → tambah dan verifikasi domain/email pengirim.';
  }
  if (msg.includes('self signed') || msg.includes('certificate')) {
    return 'SSL/TLS error. Coba set SMTP_SECURE=false dan SMTP_PORT=587.';
  }
  return 'Cek Render Logs untuk detail lebih lanjut.';
}

// ===== Verifikasi Cloudflare Turnstile =====
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true; // skip jika secret belum di-set (dev mode)
  if (!token) return false;
  try {
    const body = new URLSearchParams({
      secret: TURNSTILE_SECRET,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
    });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await r.json();
    return data.success === true;
  } catch { return true; } // jika gagal menghubungi CF, lanjut saja (jangan blokir user)
}

function getClientIp(req) {
  return (req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip || '');
}

export function generateApiToken() {
  return 'wgt_' + crypto.randomBytes(24).toString('hex');
}

function setSessionCookie(res, userId, remember = false) {
  const expiresIn = remember ? '90d' : '30d';
  const maxAge   = remember ? 90 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  });
}

// ===== Register =====
export async function register(req, res) {
  try {
    const { name, email, password, ts_token } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Nama, email, dan kata sandi wajib diisi' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Kata sandi minimal 8 karakter' });
    }

    // Verifikasi Turnstile
    const ip = getClientIp(req);
    const tsOk = await verifyTurnstile(ts_token, ip);
    if (!tsOk) {
      return res.status(400).json({ error: 'Verifikasi keamanan gagal. Coba lagi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [cleanEmail]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Email sudah terdaftar, silakan login' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, api_token) VALUES ($1,$2,$3,$4) RETURNING id, name, email, api_token',
      [name.trim(), cleanEmail, hash, generateApiToken()]
    );
    const user = rows[0];
    await claimLegacyData(user.id);
    setSessionCookie(res, user.id, false);
    res.json({ status: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ===== Login =====
export async function login(req, res) {
  try {
    const { email, password, remember, ts_token } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan kata sandi wajib diisi' });
    }

    // Verifikasi Turnstile
    const ip = getClientIp(req);
    const tsOk = await verifyTurnstile(ts_token, ip);
    if (!tsOk) {
      return res.status(400).json({ error: 'Verifikasi keamanan gagal. Coba lagi.' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    // Email belum terdaftar → kembalikan sinyal khusus untuk redirect ke register
    if (!rows.length) {
      return res.status(404).json({
        error: 'Email belum terdaftar',
        redirect_register: true,
      });
    }
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Kata sandi salah' });

    setSessionCookie(res, rows[0].id, !!remember);
    res.json({ status: true, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export function logoutSession(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ status: true });
}

// ===== Middleware: wajib login via cookie =====
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

// ===== Middleware: auth via API token device =====
export async function tokenAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token API diperlukan' });

    let { rows } = await pool.query('SELECT * FROM devices WHERE token = $1', [token]);

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
    if (device.whitelist_ip?.trim()) {
      const allowed = device.whitelist_ip.split(',').map(s => s.trim()).filter(Boolean);
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

// ===== Lupa Kata Sandi: kirim email =====
export async function forgotPassword(req, res) {
  try {
    const { email, ts_token } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email wajib diisi' });

    const ip = getClientIp(req);
    const tsOk = await verifyTurnstile(ts_token, ip);
    if (!tsOk) return res.status(400).json({ error: 'Verifikasi keamanan gagal. Coba lagi.' });

    const cleanEmail = email.trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, name FROM users WHERE email = $1', [cleanEmail]);

    if (!rows.length) {
      // Email tidak terdaftar — tetap balas sukses (anti email enumeration)
      return res.json({ status: true });
    }

    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 jam

    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET token=$2, expires_at=$3, used=FALSE`,
      [user.id, resetToken, expiresAt]
    );

    const resetLink = `${APP_URL}/reset-password?token=${resetToken}`;

    const html = `
<!DOCTYPE html>
<html lang="id">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;font-family:'Inter',Arial,sans-serif;background:#f1f5f9;color:#0f172a;}
  .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.1);}
  .header{background:linear-gradient(135deg,#1e3a8a,#0891b2);padding:36px 40px;text-align:center;}
  .header img{width:44px;height:44px;object-fit:contain;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;}
  .header h1{color:#fff;font-size:1.4rem;font-weight:800;margin:0 0 4px;letter-spacing:-.02em;}
  .header p{color:rgba(255,255,255,.75);font-size:.9rem;margin:0;}
  .body{padding:36px 40px;}
  .greeting{font-size:1rem;font-weight:600;margin-bottom:12px;color:#0f172a;}
  .text{font-size:.93rem;color:#475569;line-height:1.65;margin-bottom:24px;}
  .btn-wrap{text-align:center;margin:28px 0;}
  .btn{display:inline-block;padding:15px 36px;background:linear-gradient(135deg,#2563eb,#0891b2);color:#fff!important;text-decoration:none;border-radius:14px;font-weight:700;font-size:1rem;letter-spacing:-.01em;box-shadow:0 4px 20px rgba(37,99,235,.3);}
  .divider{border:none;border-top:1px solid #e2e8f0;margin:28px 0;}
  .link-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;word-break:break-all;font-size:.8rem;color:#64748b;font-family:monospace;}
  .warning{background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 18px;font-size:.85rem;color:#92400e;margin-top:20px;}
  .warning strong{color:#c2410c;}
  .footer{background:#f8fafc;padding:24px 40px;text-align:center;font-size:.78rem;color:#94a3b8;border-top:1px solid #e2e8f0;}
  .footer a{color:#2563eb;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <img src="${APP_URL}/assets/logo.png" alt="Synpera">
    <h1>Synpera</h1>
    <p>WhatsApp API Gateway Platform</p>
  </div>
  <div class="body">
    <p class="greeting">Halo, ${user.name} 👋</p>
    <p class="text">
      Kami menerima permintaan untuk mengatur ulang kata sandi akun Synpera kamu
      yang terdaftar dengan alamat email <strong>${cleanEmail}</strong>.
    </p>
    <p class="text">
      Klik tombol di bawah ini untuk membuat kata sandi baru. Link ini hanya berlaku selama
      <strong>1 jam</strong> dan hanya bisa digunakan satu kali.
    </p>
    <div class="btn-wrap">
      <a href="${resetLink}" class="btn">🔐 Atur Ulang Kata Sandi</a>
    </div>
    <hr class="divider">
    <p class="text" style="font-size:.85rem;color:#64748b;">Jika tombol di atas tidak berfungsi, salin dan tempel link berikut ke browser kamu:</p>
    <div class="link-box">${resetLink}</div>
    <div class="warning">
      <strong>⚠ Jika kamu tidak meminta ini</strong>, abaikan email ini. Kata sandi kamu tidak akan berubah.
      Jangan pernah membagikan link ini kepada siapa pun.
    </div>
  </div>
  <div class="footer">
    Email ini dikirim secara otomatis oleh sistem Synpera. Jangan balas email ini.<br>
    © ${new Date().getFullYear()} <a href="${APP_URL}">PT. Catindo Bagus Perkasa</a>
  </div>
</div>
</body>
</html>`;

    try {
      await sendMail({
        to: cleanEmail,
        subject: '🔐 Atur Ulang Kata Sandi Synpera',
        html,
      });
      // Email berhasil dikirim — baru balas sukses ke client
      res.json({ status: true });
    } catch (mailErr) {
      console.error('[auth] Gagal kirim email reset:', mailErr.message, mailErr.code);
      // Balas error agar UI tidak tampil "Terkirim" padahal gagal
      res.status(500).json({
        error: 'Gagal mengirim email. Silakan coba lagi atau hubungi admin.',
        detail: process.env.NODE_ENV !== 'production' ? mailErr.message : undefined,
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ===== Verifikasi reset token (GET) =====
export async function verifyResetToken(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token diperlukan' });
  const { rows } = await pool.query(
    'SELECT id FROM password_resets WHERE token=$1 AND expires_at > now() AND used=FALSE',
    [token]
  );
  if (!rows.length) return res.status(400).json({ error: 'Token tidak valid atau sudah kedaluwarsa' });
  res.json({ status: true });
}

// ===== Reset kata sandi (POST) =====
export async function resetPassword(req, res) {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token dan kata sandi wajib diisi' });
    if (password.length < 8) return res.status(400).json({ error: 'Kata sandi minimal 8 karakter' });

    const { rows } = await pool.query(
      'SELECT user_id FROM password_resets WHERE token=$1 AND expires_at > now() AND used=FALSE',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Link sudah kedaluwarsa atau tidak valid. Minta link baru.' });

    const userId = rows[0].user_id;
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    await pool.query('UPDATE password_resets SET used=TRUE WHERE token=$1', [token]);

    res.json({ status: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
