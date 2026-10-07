import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { pool } from './db.js';

/**
 * Auth state Baileys yang disimpan ke PostgreSQL (Neon),
 * sehingga session WhatsApp tetap ada meski server redeploy / restart.
 */
export async function useDbAuthState() {
  const readCreds = async () => {
    const { rows } = await pool.query('SELECT data FROM auth_creds WHERE id = 1');
    if (!rows.length) return null;
    return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
  };

  let creds = (await readCreds()) || initAuthCreds();

  const saveCreds = async () => {
    const data = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO auth_creds (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [data]
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids.length) return result;
      const { rows } = await pool.query(
        'SELECT key_id, data FROM auth_keys WHERE key_id = ANY($1)',
        [ids.map((id) => `${type}-${id}`)]
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
            await pool.query('DELETE FROM auth_keys WHERE key_id = $1', [keyId]);
          } else {
            const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            await pool.query(
              `INSERT INTO auth_keys (key_id, data, updated_at) VALUES ($1, $2, now())
               ON CONFLICT (key_id) DO UPDATE SET data = $2, updated_at = now()`,
              [keyId, json]
            );
          }
        }
      }
    },
  };

  return { state: { creds, keys }, saveCreds };
}
