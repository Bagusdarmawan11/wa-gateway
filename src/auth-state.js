import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { pool } from './db.js';

/**
 * Auth state Baileys per-user, disimpan ke PostgreSQL (Neon),
 * sehingga session WhatsApp tetap ada meski server redeploy / restart.
 */
export async function useDbAuthState(userId) {
  const readCreds = async () => {
    const { rows } = await pool.query(
      'SELECT data FROM auth_creds WHERE user_id = $1',
      [userId]
    );
    if (!rows.length) return null;
    return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
  };

  let creds = (await readCreds()) || initAuthCreds();

  const saveCreds = async () => {
    const data = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO auth_creds (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, data]
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids.length) return result;
      const { rows } = await pool.query(
        'SELECT key_id, data FROM auth_keys WHERE user_id = $1 AND key_id = ANY($2)',
        [userId, ids.map((id) => `${type}-${id}`)]
      );
      for (const row of rows) {
        const id = row.key_id.slice(type.length + 1);
        result[id] = JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
      }
      return result;
    },
    set: async (data) => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries || {})) {
          const keyId = `${type}-${id}`;
          if (value == null) {
            await pool.query(
              'DELETE FROM auth_keys WHERE user_id = $1 AND key_id = $2',
              [userId, keyId]
            );
          } else {
            const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            await pool.query(
              `INSERT INTO auth_keys (user_id, key_id, data, updated_at) VALUES ($1, $2, $3, now())
               ON CONFLICT (user_id, key_id) DO UPDATE SET data = $3, updated_at = now()`,
              [userId, keyId, json]
            );
          }
        }
      }
    },
  };

  return { state: { creds, keys }, saveCreds };
}

export async function clearAuthState(userId) {
  await pool.query('DELETE FROM auth_creds WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM auth_keys WHERE user_id = $1', [userId]);
}
