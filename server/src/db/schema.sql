-- Esquema de MonitorCt
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Tipos válidos ('monitor','gateway-isp','mikrotik','ptp-mimosa','ap-ubiquiti','cliente'),
  -- validados en la capa API (sin CHECK aquí para poder añadir tipos sin recrear la tabla).
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  -- JSON cifrado: { routerosUser, routerosPass, snmpCommunity }
  credentials_enc TEXT NOT NULL DEFAULT '',
  -- JSON: lista de IPs externas a sondear desde este nodo (solo aplica a mikrotik) y desde el PC
  probe_targets TEXT NOT NULL DEFAULT '[]',
  -- Para mikrotik: IPs de origen alternativas para /ping (src-address), JSON array
  probe_src_addresses TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Ubicación geográfica para el modo mapa (null = sin ubicar)
  lat REAL,
  lng REAL
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  -- Capacidad real del enlace en Mbps (para % de utilización)
  capacity_mbps REAL,
  -- Interfaz del equipo origen que transporta este enlace (ej. ether1, wlan1) para mapear tráfico
  source_interface TEXT NOT NULL DEFAULT ''
);

-- Series de tiempo. node_id o edge_id según a qué pertenece la métrica.
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  edge_id INTEGER REFERENCES edges(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,           -- cpu_pct, mem_pct, latency_ms, loss_pct, signal_dbm, noise_dbm, ccq_pct,
                                  -- airmax_capacity_mbps, stations, rx_mbps, tx_mbps, utilization_pct,
                                  -- tx_drops, rx_errors, queue_drops, snr_db, phy_rx_mbps, phy_tx_mbps
  value REAL NOT NULL,
  extra TEXT,                     -- JSON opcional (ej. nombre de interfaz)
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(node_id, metric, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_edge ON metrics(edge_id, metric, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

-- Resultados de sondas externas: pérdida por par origen -> destino
CREATE TABLE IF NOT EXISTS probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,           -- 'pc' o 'node:<id>' (MikroTik vía API)
  src_address TEXT NOT NULL DEFAULT '',  -- src-address usada en /ping de RouterOS ('' = por defecto)
  target TEXT NOT NULL,           -- IP destino (8.8.8.8, gateway público, etc.)
  sent INTEGER NOT NULL,
  received INTEGER NOT NULL,
  loss_pct REAL NOT NULL,
  avg_ms REAL,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_probe_pair ON probe_results(origin, target, ts);
CREATE INDEX IF NOT EXISTS idx_probe_ts ON probe_results(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  edge_id INTEGER REFERENCES edges(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  type TEXT NOT NULL,             -- node_down, high_cpu, low_signal, high_loss, saturation_loss, ...
  message TEXT NOT NULL,
  ai_diagnosis TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(resolved_at, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- user | assistant
  content TEXT NOT NULL,          -- JSON de bloques de contenido (para reenviar historial a la API)
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, ts);
