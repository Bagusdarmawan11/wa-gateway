import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      api_token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
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
    CREATE INDEX IF NOT EXISTS idx_logs_user ON message_logs (user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_due ON schedules (done, run_at);
  `);
}

/** Klaim data lama (user_id NULL dari versi single-user) ke user pertama */
export async function claimLegacyData(userId) {
  for (const t of ['message_logs', 'autoreplies', 'schedules']) {
    await pool.query(`UPDATE ${t} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
  }
}

export async function logMessage({ userId, direction, jid, text, mediaType, status }) {
  try {
    await pool.query(
      'INSERT INTO message_logs (user_id, direction, jid, text, media_type, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId ?? null, direction, jid, text ?? null, mediaType ?? null, status ?? null]
    );
  } catch (e) {
    console.error('logMessage error:', e.message);
  }
}
