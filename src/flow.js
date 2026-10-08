import { pool, logMessage } from './db.js';

/**
 * Eksekutor flow (diagram alur) untuk pesan masuk.
 * Struktur data: { nodes: [{id,type,x,y,data}], edges: [{from,to,port}] }
 * Tipe node:
 *  - start     : titik awal pesan masuk
 *  - condition : cek keyword -> port 'yes' / 'no'  (data: {keyword, mode})
 *  - response  : kirim teks                        (data: {text})
 *  - media     : kirim media via URL               (data: {url, caption})
 *  - delay     : tunggu N detik                    (data: {seconds})
 *  - global    : fallback bila tidak ada keyword yang cocok
 * Return true jika flow mengirim balasan (pesan ditangani flow).
 */
export async function runFlows(device, sock, { jid, text, isGroup, fromMe }) {
  let flows;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM flows WHERE device_id = $1 AND active = TRUE ORDER BY id',
      [device.id]
    );
    flows = rows;
  } catch {
    return false;
  }
  if (!flows.length) return false;

  for (const flow of flows) {
    try {
      const sent = await executeFlow(flow.data, device, sock, { jid, text });
      if (sent) return true;
    } catch (e) {
      console.error(`[flow ${flow.id}] error:`, e.message);
    }
  }
  return false;
}

async function executeFlow(data, device, sock, ctx) {
  const nodes = data?.nodes || [];
  const edges = data?.edges || [];
  if (!nodes.length) return false;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = (fromId, port) => {
    const e = edges.find((e) => e.from === fromId && (port ? e.port === port : !e.port || e.port === 'default'));
    return e ? byId.get(e.to) : null;
  };

  let node = nodes.find((n) => n.type === 'start');
  if (!node) return false;

  let sent = false;
  let guard = 0;
  node = next(node.id);

  while (node && guard++ < 50) {
    if (node.type === 'condition') {
      const kw = (node.data?.keyword || '').toLowerCase();
      if (!kw) { node = next(node.id, 'no'); continue; }
      const lower = ctx.text.toLowerCase();
      const matched = node.data?.mode === 'exact' ? lower === kw : lower.includes(kw);
      node = next(node.id, matched ? 'yes' : 'no');
      continue;
    }

    if (node.type === 'delay') {
      const sec = Math.min(Math.max(Number(node.data?.seconds) || 1, 1), 60);
      await new Promise((r) => setTimeout(r, sec * 1000));
      node = next(node.id);
      continue;
    }

    if (node.type === 'response') {
      const t = node.data?.text;
      if (t) {
        await sock.sendMessage(ctx.jid, { text: t });
        await logMessage({
          userId: device.user_id, deviceId: device.id,
          direction: 'out', jid: ctx.jid, text: t, status: 'flow',
        });
        sent = true;
      }
      node = next(node.id);
      continue;
    }

    if (node.type === 'media') {
      const url = node.data?.url;
      if (url) {
        const { sendMedia, guessMimetype } = await import('./wa.js');
        await sendMedia(device.id, ctx.jid, {
          url, mimetype: guessMimetype(url), caption: node.data?.caption || '',
        });
        await logMessage({
          userId: device.user_id, deviceId: device.id,
          direction: 'out', jid: ctx.jid, text: node.data?.caption || url,
          mediaType: 'media', status: 'flow',
        });
        sent = true;
      }
      node = next(node.id);
      continue;
    }

    if (node.type === 'global') {
      node = next(node.id);
      continue;
    }

    // tipe tak dikenal -> lanjut
    node = next(node.id);
  }
  return sent;
}
