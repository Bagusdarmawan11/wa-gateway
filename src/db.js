import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

export async function initDb() {
  // Migrasi aman untuk DB lama v1 (single-user) maupun DB baru v2.
  // Penting: CREATE TABLE IF NOT EXISTS tidak menambah kolom ke tabel lama,
  // jadi semua perubahan skema lama dilakukan eksplisit dengan ALTER/RENAME.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Session Baileys lama (v1) tidak punya user_id dan bentuk PK-nya berbeda.
    -- Jangan dipaksa ALTER karena ON CONFLICT (user_id) butuh struktur baru.
    DO $$
    BEGIN
      IF to_regclass('public.auth_creds') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'auth_creds' AND column_name = 'user_id'
         ) THEN
        ALTER TABLE auth_creds RENAME TO auth_creds_legacy_v1;
      END IF;

      IF to_regclass('public.auth_keys') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'auth_keys' AND column_name = 'user_id'
         ) THEN
        ALTER TABLE auth_keys RENAME TO auth_keys_legacy_v1;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS auth_creds (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS auth_keys (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      jid TEXT NOT NULL,
      text TEXT,
      media_type TEXT,
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS autoreplies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      response TEXT NOT NULL,
      match_mode TEXT DEFAULT 'contains',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      jid TEXT NOT NULL,
      text TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Tambahkan kolom v2 ke tabel lama v1 bila belum ada.
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS direction TEXT;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS jid TEXT;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS text TEXT;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS media_type TEXT;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS status TEXT;
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS keyword TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS response TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS match_mode TEXT DEFAULT 'contains';
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS jid TEXT;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS text TEXT;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS done BOOLEAN DEFAULT FALSE;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

    CREATE INDEX IF NOT EXISTS idx_logs_user ON message_logs (user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_due ON schedules (done, run_at);

    -- ===== v3: multi-device =====
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Device',
      number TEXT,
      token TEXT UNIQUE NOT NULL,
      whitelist_ip TEXT DEFAULT '',
      webhook_url TEXT DEFAULT '',
      webhook_connect_url TEXT DEFAULT '',
      webhook_status_url TEXT DEFAULT '',
      webhook_chaining_url TEXT DEFAULT '',
      autoread BOOLEAN DEFAULT FALSE,
      silent_read BOOLEAN DEFAULT FALSE,
      inbox_enabled BOOLEAN DEFAULT TRUE,
      ar_personal BOOLEAN DEFAULT TRUE,
      ar_group BOOLEAN DEFAULT FALSE,
      quick_reply BOOLEAN DEFAULT FALSE,
      forward_attachment BOOLEAN DEFAULT FALSE,
      forward_number TEXT DEFAULT '',
      autodelete BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Session WhatsApp kini per device (bukan per user)
    CREATE TABLE IF NOT EXISTS session_creds (
      device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS session_keys (
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (device_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS flows (
      id SERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Flow',
      data JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Kolom device_id untuk data operasional
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE;
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_logs_device ON message_logs (device_id, id DESC);

    -- ===== Reset kata sandi =====
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pw_reset_token ON password_resets (token);
  `);

  // Migrasi session lama (per user) -> device pertama user tsb
  await migrateSessionsToDevices();
}

async function migrateSessionsToDevices() {
  const { rows: oldCreds } = await pool.query(
    `SELECT user_id, data FROM auth_creds`
  ).catch(() => ({ rows: [] }));
  for (const row of oldCreds) {
    // Sudah dimigrasi? (user punya device dengan session)
    const { rows: existing } = await pool.query(
      `SELECT d.id FROM devices d
       JOIN session_creds sc ON sc.device_id = d.id
       WHERE d.user_id = $1 LIMIT 1`,
      [row.user_id]
    );
    if (existing.length) continue;
    const device = await createDevice(row.user_id, 'Device 1');
    await pool.query(
      'INSERT INTO session_creds (device_id, data) VALUES ($1, $2) ON CONFLICT (device_id) DO NOTHING',
      [device.id, row.data]
    );
    const { rows: keys } = await pool.query(
      'SELECT key_id, data FROM auth_keys WHERE user_id = $1', [row.user_id]
    ).catch(() => ({ rows: [] }));
    for (const k of keys) {
      await pool.query(
        'INSERT INTO session_keys (device_id, key_id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [device.id, k.key_id, k.data]
      );
    }
    // Backfill device_id pada data operasional user ini
    for (const t of ['message_logs', 'autoreplies', 'schedules']) {
      await pool.query(
        `UPDATE ${t} SET device_id = $1 WHERE user_id = $2 AND device_id IS NULL`,
        [device.id, row.user_id]
      );
    }
    console.log(`[migrate] Session user ${row.user_id} -> device ${device.id}`);
  }
}

export async function createDevice(userId, name) {
  const token = 'syn_' + crypto.randomBytes(20).toString('hex');
  const { rows } = await pool.query(
    'INSERT INTO devices (user_id, name, token) VALUES ($1,$2,$3) RETURNING *',
    [userId, name || 'Device', token]
  );
  return rows[0];
}

export async function getDevice(deviceId) {
  const { rows } = await pool.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
  return rows[0] || null;
}

/** Klaim data lama (user_id NULL dari versi single-user) ke user pertama */
export async function claimLegacyData(userId) {
  for (const t of ['message_logs', 'autoreplies', 'schedules']) {
    await pool.query(`UPDATE ${t} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
  }
}

export async function logMessage({ userId, deviceId, direction, jid, text, mediaType, status }) {
  try {
    await pool.query(
      'INSERT INTO message_logs (user_id, device_id, direction, jid, text, media_type, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId ?? null, deviceId ?? null, direction, jid, text ?? null, mediaType ?? null, status ?? null]
    );
  } catch (e) {
    console.error('logMessage error:', e.message);
  }
}
