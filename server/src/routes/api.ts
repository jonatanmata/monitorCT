import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting, NODE_TYPES, CONTAINER_TYPES, focusStart, setFocusStart, clearFocus, withFocus, type NodeRow, type EdgeRow, type Credentials, type NodeType } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';
import { allLiveNodes, dropLiveNode } from '../state.js';
import { broadcast } from '../state.js';
import { pingHost } from '../pollers/ping.js';
import { testConnection as testMikrotik, runCableTestAll, getRouterosFlow, auditMikrotik, getInterfaces } from '../pollers/mikrotik.js';
import { testSnmp } from '../pollers/snmp.js';
import { lossMatrix, hourlyCorrelation } from '../pollers/probes.js';
import { getThresholds } from '../alerts/engine.js';
import { aiAvailable, resolveApiKey, saveApiKey, clearApiKey, testApiKey, getAiModels, setAiModels, AI_MODELS } from '../ai/agent.js';
import { getTelegramConfigSafe, saveTelegramConfig, clearTelegramConfig, testTelegram, detectChatIds, setWatched, isWatched } from '../alerts/telegram.js';
import { syncTelegramPoller, stopTelegramPoller } from '../alerts/telegram-poller.js';
import { getUpdateStatus, applyUpdate, setAutoUpdate } from '../update.js';
import { computePonBudget } from '../pon/budget.js';

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
  // Ubicación en el mapa. Semántica explícita: si la clave viene en el body se usa
  // (incluido null = des-ubicar); si no viene, se conserva la guardada.
  lat?: number | null;
  lng?: number | null;
  containerId?: number | null; // rack/torre al que pertenece (null = suelto)
  meta?: unknown;              // metadatos por tipo (puertos OLT, ratio NAP, etc.)
}

const TYPE_DEFAULT_NAME: Record<NodeType, string> = {
  'monitor': 'PC de monitoreo',
  'gateway-isp': 'Gateway / ISP',
  'router': 'Router',
  'mikrotik': 'MikroTik',
  'switch': 'Switch',
  'ptp-mimosa': 'PTP Mimosa',
  'ap-ubiquiti': 'AP Ubiquiti',
  'litebeam': 'LiteBeam',
  'cliente': 'Cliente',
  'torre': 'Torre',
  'rack': 'Rack',
  'olt': 'OLT',
  'onu': 'ONU',
  'nap': 'NAP / Caja',
  'poste': 'Poste',
  'poe': 'Fuente PoE',
  'patch': 'Patch Panel',
};
function defaultNameForType(type: NodeType): string {
  return TYPE_DEFAULT_NAME[type] ?? type;
}

/**
 * Valida asignar `nodeId` (o un nodo nuevo del tipo dado) al contenedor `containerId`.
 * Reglas: el destino debe ser rack/torre; sin auto-contención ni ciclos.
 * Devuelve un mensaje de error o null si es válido.
 */
function validateContainer(containerId: number | null, nodeId: number | null, nodeType: NodeType): string | null {
  if (containerId == null) return null;
  if (nodeId != null && containerId === nodeId) return 'Un equipo no puede contenerse a sí mismo';
  const target = db.prepare('SELECT type FROM nodes WHERE id = ?').get(containerId) as { type: NodeType } | undefined;
  if (!target) return 'El contenedor destino no existe';
  if (!CONTAINER_TYPES.includes(target.type)) return 'Solo un rack o una torre puede contener equipos';
  if (CONTAINER_TYPES.includes(nodeType)) return 'Un contenedor no puede ir dentro de otro contenedor';
  return null;
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
    watched: isWatched(n.id),
    lat: n.lat,
    lng: n.lng,
    containerId: n.container_id,
    meta: safeParse(n.meta),
  };
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function edgeToJson(e: EdgeRow) {
  return {
    id: e.id, source_id: e.source_id, target_id: e.target_id,
    label: e.label, capacity_mbps: e.capacity_mbps, source_interface: e.source_interface,
    medium: e.medium ?? '', fiber: safeParse(e.fiber),
    source_port: e.source_port ?? '', target_port: e.target_port ?? '',
  };
}

export function registerApiRoutes(app: FastifyInstance): void {
  // ---------- Topología ----------
  app.get('/api/topology', async () => {
    const nodes = (db.prepare('SELECT * FROM nodes').all() as NodeRow[]).map(nodeToJson);
    const edges = (db.prepare('SELECT * FROM edges').all() as EdgeRow[]).map(edgeToJson);
    return { nodes, edges, live: allLiveNodes(), aiAvailable: aiAvailable() };
  });

  app.post('/api/nodes', async (req, reply) => {
    const b = req.body as NodeBody;
    if (!NODE_TYPES.includes(b.type)) return reply.code(400).send({ error: 'Tipo de equipo inválido' });
    if (b.type === 'monitor') return reply.code(400).send({ error: 'El nodo Monitor es único y se crea automáticamente' });
    const contErr = validateContainer(b.containerId ?? null, null, b.type);
    if (contErr) return reply.code(400).send({ error: contErr });
    const res = db
      .prepare(
        `INSERT INTO nodes (type, name, ip, pos_x, pos_y, credentials_enc, probe_targets, probe_src_addresses, enabled, lat, lng, container_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.type, b.name, b.ip ?? '', b.posX ?? 0, b.posY ?? 0,
        b.credentials ? encryptJson(b.credentials) : '',
        JSON.stringify(b.probeTargets ?? []),
        JSON.stringify(b.probeSrcAddresses ?? []),
        b.enabled === false ? 0 : 1,
        b.lat ?? null, b.lng ?? null, b.containerId ?? null,
        b.meta !== undefined ? JSON.stringify(b.meta) : null,
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

    // lat/lng/containerId: semántica de clave presente (permite null explícito)
    const body = req.body as Record<string, unknown>;
    const lat = 'lat' in body ? (b.lat ?? null) : existing.lat;
    const lng = 'lng' in body ? (b.lng ?? null) : existing.lng;
    const newType = b.type ?? existing.type;
    const containerId = 'containerId' in body ? (b.containerId ?? null) : existing.container_id;
    const metaJson = 'meta' in body ? (b.meta != null ? JSON.stringify(b.meta) : null) : existing.meta;

    if ('containerId' in body) {
      const contErr = validateContainer(containerId, id, newType);
      if (contErr) return reply.code(400).send({ error: contErr });
    }
    // No convertir un contenedor con miembros a otro tipo (dejaría miembros huérfanos)
    if (newType !== existing.type && CONTAINER_TYPES.includes(existing.type)) {
      const members = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE container_id = ?').get(id) as { c: number };
      if (members.c > 0) return reply.code(400).send({ error: 'Saca primero los equipos del contenedor antes de cambiar su tipo' });
    }

    db.prepare(
      `UPDATE nodes SET type = ?, name = ?, ip = ?, pos_x = ?, pos_y = ?, credentials_enc = ?,
       probe_targets = ?, probe_src_addresses = ?, enabled = ?, lat = ?, lng = ?, container_id = ?, meta = ? WHERE id = ?`,
    ).run(
      newType,
      b.name ?? existing.name,
      b.ip ?? existing.ip,
      b.posX ?? existing.pos_x,
      b.posY ?? existing.pos_y,
      credentialsEnc,
      JSON.stringify(b.probeTargets ?? JSON.parse(existing.probe_targets)),
      JSON.stringify(b.probeSrcAddresses ?? JSON.parse(existing.probe_src_addresses)),
      b.enabled === undefined ? existing.enabled : b.enabled ? 1 : 0,
      lat, lng, containerId, metaJson,
      id,
    );
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow;
    return nodeToJson(node);
  });

  app.delete('/api/nodes/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT type FROM nodes WHERE id = ?').get(id) as { type: NodeType } | undefined;
    if (node?.type === 'monitor') {
      return reply.code(400).send({ error: 'El nodo Monitor (PC) es la raíz de la red y no se puede eliminar' });
    }
    db.prepare('DELETE FROM alerts WHERE node_id = ?').run(id); // evita alertas huérfanas abiertas
    db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    dropLiveNode(id);
    return { ok: true };
  });

  app.post('/api/edges', async (req) => {
    const b = req.body as { sourceId: number; targetId: number; label?: string; capacityMbps?: number; sourceInterface?: string; medium?: string; fiber?: unknown; sourcePort?: string; targetPort?: string };
    const res = db
      .prepare('INSERT INTO edges (source_id, target_id, label, capacity_mbps, source_interface, medium, fiber, source_port, target_port) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.sourceId, b.targetId, b.label ?? '', b.capacityMbps ?? null, b.sourceInterface ?? '', b.medium ?? '', b.fiber != null ? JSON.stringify(b.fiber) : null, b.sourcePort ?? '', b.targetPort ?? '');
    return edgeToJson(db.prepare('SELECT * FROM edges WHERE id = ?').get(res.lastInsertRowid) as EdgeRow);
  });

  app.put('/api/edges/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const existing = db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'Arista no encontrada' });
    const b = req.body as { label?: string; capacityMbps?: number | null; sourceInterface?: string; medium?: string; fiber?: unknown; sourcePort?: string; targetPort?: string };
    const body = req.body as Record<string, unknown>;
    const fiber = 'fiber' in body ? (b.fiber != null ? JSON.stringify(b.fiber) : null) : existing.fiber;
    db.prepare('UPDATE edges SET label = ?, capacity_mbps = ?, source_interface = ?, medium = ?, fiber = ?, source_port = ?, target_port = ? WHERE id = ?').run(
      b.label ?? existing.label,
      b.capacityMbps === undefined ? existing.capacity_mbps : b.capacityMbps,
      b.sourceInterface ?? existing.source_interface,
      b.medium ?? existing.medium ?? '',
      fiber,
      'sourcePort' in body ? (b.sourcePort ?? '') : existing.source_port,
      'targetPort' in body ? (b.targetPort ?? '') : existing.target_port,
      id,
    );
    return edgeToJson(db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow);
  });

  /** Presupuesto óptico PON: potencia estimada recibida en una ONU (breakdown por salto). */
  app.get('/api/pon/budget/:onuId', async (req) => {
    const onuId = parseInt((req.params as { onuId: string }).onuId, 10);
    const nodes = (db.prepare('SELECT id, type, name, meta FROM nodes').all() as { id: number; type: string; name: string; meta: string | null }[])
      .map((n) => ({ id: n.id, type: n.type, name: n.name, meta: safeParse(n.meta) }));
    const edges = (db.prepare('SELECT source_id, target_id, fiber, source_port, target_port FROM edges').all() as { source_id: number; target_id: number; fiber: string | null; source_port: string; target_port: string }[])
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id, fiber: safeParse(e.fiber) as { lengthM?: number; dbPerKm?: number; connectors?: number; oltPort?: string } | null, source_port: e.source_port, target_port: e.target_port }));
    return computePonBudget(nodes, edges, onuId);
  });

  app.delete('/api/edges/:id', async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    db.prepare('DELETE FROM alerts WHERE edge_id = ?').run(id); // evita alertas huérfanas abiertas
    db.prepare('DELETE FROM edges WHERE id = ?').run(id);
    return { ok: true };
  });

  /**
   * "Romper el hilo": inserta una cadena de nodos dentro de un enlace existente.
   * A→B pasa a A→c1→…→cn→B. La primera arista hereda capacidad/interfaz del original
   * (mismo primer salto desde A); las demás quedan en blanco para configurar.
   */
  app.post('/api/edges/:id/split', async (req, reply) => {
    const edgeId = parseInt((req.params as { id: string }).id, 10);
    const b = req.body as { nodes: { type: NodeType; name?: string }[] };
    const chain = Array.isArray(b?.nodes) ? b.nodes : [];
    if (chain.length === 0) return reply.code(400).send({ error: 'Debe indicar al menos un equipo a insertar' });
    for (const c of chain) {
      if (!NODE_TYPES.includes(c.type) || c.type === 'monitor') {
        return reply.code(400).send({ error: `Tipo inválido para insertar: ${c.type}` });
      }
    }

    const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get(edgeId) as EdgeRow | undefined;
    if (!edge) return reply.code(404).send({ error: 'Enlace no encontrado' });
    const src = db.prepare('SELECT pos_x, pos_y FROM nodes WHERE id = ?').get(edge.source_id) as { pos_x: number; pos_y: number } | undefined;
    const tgt = db.prepare('SELECT pos_x, pos_y FROM nodes WHERE id = ?').get(edge.target_id) as { pos_x: number; pos_y: number } | undefined;
    const ax = src?.pos_x ?? 0, ay = src?.pos_y ?? 0;
    const bx = tgt?.pos_x ?? ax + 200, by = tgt?.pos_y ?? ay;

    const insertNode = db.prepare(
      `INSERT INTO nodes (type, name, pos_x, pos_y) VALUES (?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      'INSERT INTO edges (source_id, target_id, label, capacity_mbps, source_interface, medium, fiber) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    // Si el enlace es de fibra, repartir la longitud entre los N+1 tramos; el primero
    // conserva el puerto OLT, los conectores se reparten y cada tramo cae en 1/(n+1).
    const origFiber = edge.medium === 'fiber' ? (safeParse(edge.fiber) as { lengthM?: number; connectors?: number; dbPerKm?: number; cableType?: string; oltPort?: string } | null) : null;

    const result = db.transaction(() => {
      const newNodeIds: number[] = [];
      chain.forEach((c, i) => {
        const f = (i + 1) / (chain.length + 1); // fracción sobre la recta A→B
        const x = ax + (bx - ax) * f;
        const y = ay + (by - ay) * f;
        const name = c.name?.trim() || defaultNameForType(c.type);
        const r = insertNode.run(c.type, name, Math.round(x), Math.round(y));
        newNodeIds.push(Number(r.lastInsertRowid));
      });

      db.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);

      const seq = [edge.source_id, ...newNodeIds, edge.target_id];
      const segments = seq.length - 1;
      const newEdgeIds: number[] = [];
      for (let i = 0; i < segments; i++) {
        const isFirst = i === 0;
        let fiberJson: string | null = isFirst ? edge.fiber : null;
        if (origFiber) {
          const seg: Record<string, unknown> = {
            lengthM: origFiber.lengthM != null ? Math.round(origFiber.lengthM / segments) : undefined,
            connectors: origFiber.connectors != null ? Math.round(origFiber.connectors / segments) : undefined,
            dbPerKm: origFiber.dbPerKm, cableType: origFiber.cableType,
            oltPort: isFirst ? origFiber.oltPort : undefined, // solo el tramo pegado a la OLT
          };
          fiberJson = JSON.stringify(seg);
        }
        const r = insertEdge.run(
          seq[i], seq[i + 1],
          isFirst ? edge.label : '',
          isFirst ? edge.capacity_mbps : null,
          isFirst ? edge.source_interface : '',
          edge.medium ?? '',
          fiberJson,
        );
        newEdgeIds.push(Number(r.lastInsertRowid));
      }
      return { newNodeIds, newEdgeIds };
    })();

    const nodes = (db.prepare(`SELECT * FROM nodes WHERE id IN (${result.newNodeIds.map(() => '?').join(',')})`).all(...result.newNodeIds) as NodeRow[]).map(nodeToJson);
    const edges = (db.prepare(`SELECT * FROM edges WHERE id IN (${result.newEdgeIds.map(() => '?').join(',')})`).all(...result.newEdgeIds) as EdgeRow[]).map(edgeToJson);
    return { nodes, edges };
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

  // ---------- Prueba de cable (TDR) ----------
  app.post('/api/nodes/:id/cable-test', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    if (node.type !== 'mikrotik') {
      return { supported: false, note: 'La prueba de cable TDR requiere un equipo MikroTik. Para un equipo detrás de un switch pasivo, prueba el puerto del MikroTik vecino.' };
    }
    if (!node.ip) return { supported: false, note: 'El equipo no tiene IP configurada' };
    const b = (req.body ?? {}) as { interface?: string };
    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    try {
      const results = await runCableTestAll(node.ip, creds, b.interface);
      return { supported: true, results };
    } catch (err) {
      return { supported: false, note: err instanceof Error ? err.message : String(err) };
    }
  });

  // Flujo RouterOS (para la vista del drawer): datos en vivo por API.
  app.post('/api/nodes/:id/routeros-flow', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    if (node.type !== 'mikrotik' && node.type !== 'router') {
      return { supported: false, note: 'El flujo RouterOS solo está disponible en equipos MikroTik.' };
    }
    if (node.type === 'router') {
      return { supported: false, note: 'Router genérico: el flujo detallado requiere un MikroTik con API RouterOS.' };
    }
    if (!node.ip) return { supported: false, note: 'El equipo no tiene IP configurada.' };
    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    if (!creds.routerosUser) return { supported: false, note: 'Configura el usuario/clave API RouterOS del equipo para leer el flujo.' };
    try {
      const flow = await getRouterosFlow(node.ip, creds);
      return { supported: true, ...flow };
    } catch (err) {
      return reply.code(200).send({ supported: false, note: err instanceof Error ? err.message : String(err) });
    }
  });

  // Auditoría de configuración MikroTik (solo lectura).
  app.post('/api/nodes/:id/audit', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    if (node.type !== 'mikrotik') return { supported: false, note: 'La auditoría de configuración requiere un equipo MikroTik.' };
    if (!node.ip) return { supported: false, note: 'El equipo no tiene IP configurada.' };
    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    if (!creds.routerosUser) return { supported: false, note: 'Configura el usuario/clave API RouterOS del equipo para auditarlo.' };
    try {
      const result = await auditMikrotik(node.ip, creds);
      return { supported: true, ...result };
    } catch (err) {
      return { supported: false, note: err instanceof Error ? err.message : String(err) };
    }
  });

  // Interfaces de un MikroTik con su tráfico (para elegir la interfaz origen de un enlace).
  app.post('/api/nodes/:id/interfaces', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    if (node.type !== 'mikrotik') return { supported: false, note: 'La lista de puertos requiere un MikroTik (API RouterOS).' };
    if (!node.ip) return { supported: false, note: 'El equipo no tiene IP configurada.' };
    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    if (!creds.routerosUser) return { supported: false, note: 'Configura el usuario/clave API RouterOS del equipo.' };
    try {
      return { supported: true, interfaces: await getInterfaces(node.ip, creds) };
    } catch (err) {
      return { supported: false, note: err instanceof Error ? err.message : String(err) };
    }
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
    const since = withFocus(Math.floor(Date.now() / 1000) - Math.min(parseFloat(q.hoursBack ?? '72'), 720) * 3600);
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
    const res = db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL').run(id);
    // Avisar a la UI para que refresque y retire la alarma en pantalla de ese equipo.
    if (res.changes > 0) broadcast('alert_resolved', { id });
    return { ok: true };
  });

  // ---------- Modo enfoque (nueva investigación) ----------
  app.get('/api/focus', async () => {
    const fs = focusStart();
    return { focusStart: fs > 0 ? fs : null };
  });

  app.put('/api/focus', async (req) => {
    const b = (req.body ?? {}) as { start?: number };
    const ts = b.start && b.start > 0 ? b.start : Math.floor(Date.now() / 1000);
    setFocusStart(ts);
    return { ok: true, focusStart: ts };
  });

  app.delete('/api/focus', async () => {
    clearFocus();
    return { ok: true, focusStart: null };
  });

  /** Borra datos anteriores al enfoque (métricas, sondas) y limpia alertas viejas. */
  app.post('/api/focus/purge', async (_req, reply) => {
    const fs = focusStart();
    if (fs <= 0) return reply.code(400).send({ error: 'No hay un enfoque activo' });
    const del = db.transaction(() => {
      const m = db.prepare('DELETE FROM metrics WHERE ts < ?').run(fs);
      const p = db.prepare('DELETE FROM probe_results WHERE ts < ?').run(fs);
      // Resolver alertas abiertas anteriores al enfoque y borrar las ya resueltas anteriores
      db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE created_at < ? AND resolved_at IS NULL').run(fs);
      const a = db.prepare('DELETE FROM alerts WHERE created_at < ? AND resolved_at IS NOT NULL').run(fs);
      return { metrics: m.changes, probes: p.changes, alerts: a.changes };
    })();
    return { ok: true, deleted: del };
  });

  // ---------- Ajustes ----------
  app.get('/api/settings', async () => ({
    thresholds: getThresholds(),
    pcProbeTargets: JSON.parse(getSetting('pc_probe_targets', '["8.8.8.8"]')),
    // Nunca se devuelve la clave; solo si hay una y de dónde viene
    hasApiKey: aiAvailable(),
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'env' : resolveApiKey() ? 'ui' : null,
    telegram: getTelegramConfigSafe(),
    aiModels: getAiModels(),
    aiModelOptions: AI_MODELS,
    // Modo mapa (MapTiler): key gratuita del usuario + estilo elegido
    maptilerKey: getSetting('maptiler_key', ''),
    mapStyle: getSetting('map_style', 'dark'),
  }));

  app.put('/api/settings', async (req) => {
    const b = req.body as {
      thresholds?: Record<string, number>;
      pcProbeTargets?: string[];
      anthropicApiKey?: string;      // guardarla cifrada en la BD local
      clearApiKey?: boolean;         // borrar la guardada desde la UI
      aiModelDiagnosis?: string;
      aiModelEconomic?: string;
      maptilerKey?: string;
      mapStyle?: string;
    };
    if (b.thresholds) setSetting('thresholds', JSON.stringify(b.thresholds));
    if (b.pcProbeTargets) setSetting('pc_probe_targets', JSON.stringify(b.pcProbeTargets));
    if (b.clearApiKey) clearApiKey();
    else if (b.anthropicApiKey) saveApiKey(b.anthropicApiKey.trim());
    if (b.aiModelDiagnosis || b.aiModelEconomic) setAiModels(b.aiModelDiagnosis, b.aiModelEconomic);
    if (b.maptilerKey !== undefined) setSetting('maptiler_key', b.maptilerKey.trim());
    if (b.mapStyle !== undefined && ['dark', 'satellite', 'streets'].includes(b.mapStyle)) setSetting('map_style', b.mapStyle);
    return { ok: true, hasApiKey: aiAvailable() };
  });

  /** Valida una clave (la enviada, o la configurada si no se envía) sin gastar tokens. */
  app.post('/api/settings/test-api-key', async (req) => {
    const b = (req.body ?? {}) as { key?: string };
    return testApiKey(b.key?.trim() || undefined);
  });

  // ---------- Telegram ----------
  app.put('/api/settings/telegram', async (req) => {
    const b = req.body as {
      enabled?: boolean; botToken?: string; chatId?: string; clear?: boolean;
      minSeverity?: 'info' | 'warning' | 'critical'; notifyResolved?: boolean; notifyDiagnosis?: boolean;
      criticalChatId?: string; quietStart?: number | null; quietEnd?: number | null;
      actionButtons?: boolean; groupWindowSec?: number; reminderMinutes?: number;
    };
    if (b.clear) { clearTelegramConfig(); stopTelegramPoller(); }
    else {
      saveTelegramConfig({
        enabled: b.enabled, botToken: b.botToken, chatId: b.chatId,
        minSeverity: b.minSeverity, notifyResolved: b.notifyResolved, notifyDiagnosis: b.notifyDiagnosis,
        criticalChatId: b.criticalChatId, quietStart: b.quietStart, quietEnd: b.quietEnd,
        actionButtons: b.actionButtons, groupWindowSec: b.groupWindowSec, reminderMinutes: b.reminderMinutes,
      });
      syncTelegramPoller();
    }
    return { ok: true, telegram: getTelegramConfigSafe() };
  });

  // Vigilancia dedicada de un equipo: sus alertas siempre notifican (ignora severidad mínima y horario silencioso).
  app.put('/api/nodes/:id/watch', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
    if (!node) return reply.code(404).send({ error: 'Nodo no encontrado' });
    const b = (req.body ?? {}) as { watch?: boolean };
    setWatched(id, Boolean(b.watch));
    return { ok: true, watched: isWatched(id) };
  });

  app.post('/api/settings/telegram/test', async (req) => {
    const b = (req.body ?? {}) as { botToken?: string; chatId?: string };
    return testTelegram(b);
  });

  /** Detecta el chat id automáticamente vía getUpdates (el usuario envía un mensaje al bot). */
  app.post('/api/settings/telegram/detect-chat', async (req) => {
    const b = (req.body ?? {}) as { botToken?: string };
    return detectChatIds(b.botToken?.trim() || undefined);
  });

  // ---------- Actualizaciones (GitHub) ----------
  app.get('/api/update/status', async () => getUpdateStatus());

  app.post('/api/update/apply', async () => applyUpdate());

  app.put('/api/update/auto', async (req) => {
    const b = (req.body ?? {}) as { enabled?: boolean };
    setAutoUpdate(Boolean(b.enabled));
    return { ok: true, autoUpdate: Boolean(b.enabled) };
  });
}
