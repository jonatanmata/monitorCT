import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting, type NodeRow, type EdgeRow, type Credentials } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';
import { allLiveNodes, dropLiveNode } from '../state.js';
import { pingHost } from '../pollers/ping.js';
import { testConnection as testMikrotik } from '../pollers/mikrotik.js';
import { testSnmp } from '../pollers/snmp.js';
import { lossMatrix, hourlyCorrelation } from '../pollers/probes.js';
import { getThresholds } from '../alerts/engine.js';
import { aiAvailable, resolveApiKey, saveApiKey, clearApiKey, testApiKey } from '../ai/agent.js';
import { getTelegramConfigSafe, saveTelegramConfig, clearTelegramConfig, testTelegram } from '../alerts/telegram.js';

interface NodeBody {
  type: NodeRow['type'];
  name: string;
  ip?: string;
  posX?: number;
  posY?: number;
  credentials?: Credentials;
  probeTargets?: string[];
  probeSrcAddresses?: string[];
  enabled?: boolean;
}

function nodeToJson(n: NodeRow) {
  const creds = decryptJson<Credentials>(n.credentials_enc, {});
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    ip: n.ip,
    posX: n.pos_x,
    posY: n.pos_y,
    enabled: Boolean(n.enabled),
    probeTargets: JSON.parse(n.probe_targets || '[]'),
    probeSrcAddresses: JSON.parse(n.probe_src_addresses || '[]'),
    // Nunca devolver contraseñas; solo indicar qué hay configurado
    hasRouterosCreds: Boolean(creds.routerosUser),
    snmpCommunity: creds.snmpCommunity ?? '',
  };
}

export function registerApiRoutes(app: FastifyInstance): void {
  // ---------- Topología ----------
  app.get('/api/topology', async () => {
    const nodes = (db.prepare('SELECT * FROM nodes').all() as NodeRow[]).map(nodeToJson);
    const edges = db.prepare('SELECT * FROM edges').all() as EdgeRow[];
    return { nodes, edges, live: allLiveNodes(), aiAvailable: aiAvailable() };
  });

  app.post('/api/nodes', async (req) => {
    const b = req.body as NodeBody;
    const res = db
      .prepare(
        `INSERT INTO nodes (type, name, ip, pos_x, pos_y, credentials_enc, probe_targets, probe_src_addresses, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.type, b.name, b.ip ?? '', b.posX ?? 0, b.posY ?? 0,
        b.credentials ? encryptJson(b.credentials) : '',
        JSON.stringify(b.probeTargets ?? []),
        JSON.stringify(b.probeSrcAddresses ?? []),
        b.enabled === false ? 0 : 1,
      );
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(res.lastInsertRowid) as NodeRow;
    return nodeToJson(node);
  });

  app.put('/api/nodes/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'Nodo no encontrado' });
    const b = req.body as Partial<NodeBody>;

    // Fusionar credenciales: los campos vacíos no pisan lo guardado
    let credentialsEnc = existing.credentials_enc;
    if (b.credentials) {
      const prev = decryptJson<Credentials>(existing.credentials_enc, {});
      const merged: Credentials = {
        routerosUser: b.credentials.routerosUser || prev.routerosUser,
        routerosPass: b.credentials.routerosPass || prev.routerosPass,
        snmpCommunity: b.credentials.snmpCommunity ?? prev.snmpCommunity,
      };
      credentialsEnc = encryptJson(merged);
    }

    db.prepare(
      `UPDATE nodes SET type = ?, name = ?, ip = ?, pos_x = ?, pos_y = ?, credentials_enc = ?,
       probe_targets = ?, probe_src_addresses = ?, enabled = ? WHERE id = ?`,
    ).run(
      b.type ?? existing.type,
      b.name ?? existing.name,
      b.ip ?? existing.ip,
      b.posX ?? existing.pos_x,
      b.posY ?? existing.pos_y,
      credentialsEnc,
      JSON.stringify(b.probeTargets ?? JSON.parse(existing.probe_targets)),
      JSON.stringify(b.probeSrcAddresses ?? JSON.parse(existing.probe_src_addresses)),
      b.enabled === undefined ? existing.enabled : b.enabled ? 1 : 0,
      id,
    );
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow;
    return nodeToJson(node);
  });

  app.delete('/api/nodes/:id', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    dropLiveNode(id);
    return { ok: true };
  });

  app.post('/api/edges', async (req) => {
    const b = req.body as { sourceId: number; targetId: number; label?: string; capacityMbps?: number; sourceInterface?: string };
    const res = db
      .prepare('INSERT INTO edges (source_id, target_id, label, capacity_mbps, source_interface) VALUES (?, ?, ?, ?, ?)')
      .run(b.sourceId, b.targetId, b.label ?? '', b.capacityMbps ?? null, b.sourceInterface ?? '');
    return db.prepare('SELECT * FROM edges WHERE id = ?').get(res.lastInsertRowid);
  });

  app.put('/api/edges/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const existing = db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'Arista no encontrada' });
    const b = req.body as { label?: string; capacityMbps?: number | null; sourceInterface?: string };
    db.prepare('UPDATE edges SET label = ?, capacity_mbps = ?, source_interface = ? WHERE id = ?').run(
      b.label ?? existing.label,
      b.capacityMbps === undefined ? existing.capacity_mbps : b.capacityMbps,
      b.sourceInterface ?? existing.source_interface,
      id,
    );
    return db.prepare('SELECT * FROM edges WHERE id = ?').get(id);
  });

  app.delete('/api/edges/:id', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    db.prepare('DELETE FROM edges WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---------- Probar conexión ----------
  app.post('/api/nodes/:id/test', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    if (!node.ip) return { ping: { ok: false, detail: 'Sin IP configurada' } };

    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    const out: Record<string, { ok: boolean; detail: string }> = {};

    try {
      const p = await pingHost(node.ip, 3);
      out.ping = p.alive
        ? { ok: true, detail: `responde, ${p.avgMs?.toFixed(1) ?? '?'} ms, pérdida ${p.lossPct}%` }
        : { ok: false, detail: 'no responde a ping' };
    } catch (err) {
      out.ping = { ok: false, detail: String(err) };
    }

    if (node.type === 'mikrotik') {
      out.routeros = await testMikrotik(node.ip, creds);
    }
    if (node.type === 'ptp-mimosa' || node.type === 'ap-ubiquiti' || node.type === 'cliente') {
      out.snmp = await testSnmp(node.ip, creds.snmpCommunity || 'public');
    }
    return out;
  });

  // ---------- Métricas ----------
  app.get('/api/metrics', async (req) => {
    const q = req.query as { nodeId?: string; edgeId?: string; metric: string; hoursBack?: string };
    const hours = Math.min(parseFloat(q.hoursBack ?? '6'), 720);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const nodeId = q.nodeId ? parseInt(q.nodeId, 10) : null;
    const edgeId = q.edgeId ? parseInt(q.edgeId, 10) : null;
    const names = hours > 48 ? [`agg5m:${q.metric}`] : [q.metric, `agg5m:${q.metric}`];
    const rows = db
      .prepare(
        `SELECT value, extra, ts FROM metrics
         WHERE node_id IS ? AND edge_id IS ? AND metric IN (${names.map(() => '?').join(',')}) AND ts >= ? ORDER BY ts`,
      )
      .all(nodeId, edgeId, ...names, since);
    return { points: rows };
  });

  /** Métricas disponibles para un nodo/arista (para poblar el selector de gráficas). */
  app.get('/api/metrics/available', async (req) => {
    const q = req.query as { nodeId?: string; edgeId?: string };
    const nodeId = q.nodeId ? parseInt(q.nodeId, 10) : null;
    const edgeId = q.edgeId ? parseInt(q.edgeId, 10) : null;
    const rows = db
      .prepare(`SELECT DISTINCT metric FROM metrics WHERE node_id IS ? AND edge_id IS ? AND metric NOT LIKE 'agg5m:%'`)
      .all(nodeId, edgeId) as { metric: string }[];
    return { metrics: rows.map((r) => r.metric) };
  });

  // ---------- Sondas y saturación ----------
  app.get('/api/loss-matrix', async (req) => {
    const q = req.query as { hoursBack?: string };
    return { matrix: lossMatrix(Math.min(parseFloat(q.hoursBack ?? '24'), 720)) };
  });

  app.get('/api/correlation', async (req) => {
    const q = req.query as { edgeId?: string; daysBack?: string };
    return {
      hourly: hourlyCorrelation(
        q.edgeId ? parseInt(q.edgeId, 10) : null,
        Math.min(parseFloat(q.daysBack ?? '7'), 30),
      ),
    };
  });

  // ---------- Alertas ----------
  app.get('/api/alerts', async (req) => {
    const q = req.query as { hoursBack?: string };
    const since = Math.floor(Date.now() / 1000) - Math.min(parseFloat(q.hoursBack ?? '72'), 720) * 3600;
    const rows = db
      .prepare(
        `SELECT a.*, n.name AS node_name FROM alerts a
         LEFT JOIN nodes n ON n.id = a.node_id
         WHERE a.created_at >= ? OR a.resolved_at IS NULL
         ORDER BY (a.resolved_at IS NULL) DESC, a.created_at DESC LIMIT 200`,
      )
      .all(since);
    return { alerts: rows };
  });

  app.post('/api/alerts/:id/resolve', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL').run(id);
    return { ok: true };
  });

  // ---------- Ajustes ----------
  app.get('/api/settings', async () => ({
    thresholds: getThresholds(),
    pcProbeTargets: JSON.parse(getSetting('pc_probe_targets', '["8.8.8.8"]')),
    // Nunca se devuelve la clave; solo si hay una y de dónde viene
    hasApiKey: aiAvailable(),
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'env' : resolveApiKey() ? 'ui' : null,
    telegram: getTelegramConfigSafe(),
  }));

  app.put('/api/settings', async (req) => {
    const b = req.body as {
      thresholds?: Record<string, number>;
      pcProbeTargets?: string[];
      anthropicApiKey?: string;      // guardarla cifrada en la BD local
      clearApiKey?: boolean;         // borrar la guardada desde la UI
    };
    if (b.thresholds) setSetting('thresholds', JSON.stringify(b.thresholds));
    if (b.pcProbeTargets) setSetting('pc_probe_targets', JSON.stringify(b.pcProbeTargets));
    if (b.clearApiKey) clearApiKey();
    else if (b.anthropicApiKey) saveApiKey(b.anthropicApiKey.trim());
    return { ok: true, hasApiKey: aiAvailable() };
  });

  /** Valida una clave (la enviada, o la configurada si no se envía) sin gastar tokens. */
  app.post('/api/settings/test-api-key', async (req) => {
    const b = (req.body ?? {}) as { key?: string };
    return testApiKey(b.key?.trim() || undefined);
  });

  // ---------- Telegram ----------
  app.put('/api/settings/telegram', async (req) => {
    const b = req.body as { enabled?: boolean; botToken?: string; chatId?: string; clear?: boolean };
    if (b.clear) clearTelegramConfig();
    else saveTelegramConfig({ enabled: b.enabled, botToken: b.botToken, chatId: b.chatId });
    return { ok: true, telegram: getTelegramConfigSafe() };
  });

  app.post('/api/settings/telegram/test', async (req) => {
    const b = (req.body ?? {}) as { botToken?: string; chatId?: string };
    return testTelegram(b);
  });
}
