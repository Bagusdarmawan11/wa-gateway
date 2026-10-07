import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_creds (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS auth_keys (
      key_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY,
      direction TEXT NOT NULL,
      jid TEXT NOT NULL,
      text TEXT,
      status TEXT,
      token_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS autoreplies (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL,
      response TEXT NOT NULL,
      match_mode TEXT DEFAULT 'contains',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      jid TEXT NOT NULL,
      text TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

export async function logMessage({ direction, jid, text, status, tokenName }) {
  try {
    await pool.query(
      'INSERT INTO message_logs (direction, jid, text, status, token_name) VALUES ($1,$2,$3,$4,$5)',
      [direction, jid, text ?? null, status ?? null, tokenName ?? null]
    );
  } catch (e) {
    console.error('logMessage error:', e.message);
  }
}
