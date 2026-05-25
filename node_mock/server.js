'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const JWT_SECRET = 'mock_secret_2025';
const PORT       = process.env.PORT || 3001;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.round(rand(min, max));
}

// ─── Seed data ───────────────────────────────────────────────────────────────

const SERVICES = [
  {
    id:             'svc-passbolt',
    service_name:   'Passbolt',
    container_name: 'passbolt',
    host_ip:        '127.0.0.1',
    snmp_port:      1161,
    slug:           'passbolt',
    description:    'Gestor de contraseñas corporativo',
    enabled:        true,
    created_at:     ts(60 * 24 * 30),
  },
  {
    id:             'svc-chkmonitor',
    service_name:   'ChkMonitor',
    container_name: 'chkmonitor',
    host_ip:        '127.0.0.1',
    snmp_port:      2161,
    slug:           'chkmonitor',
    description:    'Monitor de salud de sistemas',
    enabled:        true,
    created_at:     ts(60 * 24 * 30),
  },
];

// Passwords stored in plain text — this is a dev mock only
const USERS = [
  {
    id:           'usr-master',
    email:        'master@cuy.local',
    _password:    'sentinel2025',
    display_name: 'Master Admin',
    role:         'master',
    last_login:   ts(30),
    created_at:   ts(60 * 24 * 30),
  },
  {
    id:           'usr-admin',
    email:        'admin@cuy.local',
    _password:    'admin2025',
    display_name: 'Daniel Rojas',
    role:         'admin',
    last_login:   ts(90),
    created_at:   ts(60 * 24 * 20),
  },
  {
    id:           'usr-viewer',
    email:        'viewer@cuy.local',
    _password:    'viewer2025',
    display_name: 'Jheampierre Ralli',
    role:         'viewer',
    last_login:   ts(240),
    created_at:   ts(60 * 24 * 10),
  },
];

function makeMetric(serviceId, minutesAgo, overrides = {}) {
  const up = overrides.service_status !== 'offline' && Math.random() > 0.08;
  return {
    id:                 randomUUID(),
    service_id:         serviceId,
    cpu_usage_percent:  parseFloat(rand(12, up ? 72 : 93).toFixed(1)),
    ram_usage_mb:       randInt(512,  up ? 2200 : 3850),
    ram_total_mb:       4096,
    disk_usage_percent: parseFloat(rand(28, up ? 68 : 86).toFixed(1)),
    bandwidth_in_mb:    parseFloat(rand(0.1, 4).toFixed(2)),
    bandwidth_out_mb:   parseFloat(rand(0.05, 1.5).toFixed(2)),
    uptime_seconds:     up ? randInt(3600, 7 * 86400) : 0,
    service_status:     up ? 'online' : 'offline',
    snmp_latency_ms:    up ? randInt(4, 45) : null,
    snmp_loss_percent:  up ? 0 : 100,
    collected_at:       ts(minutesAgo),
    ...overrides,
  };
}

// 25 historical points per service (every 5 min)
let METRICS = [];
for (let i = 24; i >= 1; i--) {
  METRICS.push(makeMetric('svc-passbolt',    i * 5));
  METRICS.push(makeMetric('svc-chkmonitor',  i * 5));
}
// Add the most recent (t=0)
METRICS.push(makeMetric('svc-passbolt',   0));
METRICS.push(makeMetric('svc-chkmonitor', 0));

const THRESHOLDS = [
  { id: 'thr-cpu',     service_id: null, metric_name: 'cpu_usage_percent',  threshold_value: 80,   severity: 'warning',  enabled: true },
  { id: 'thr-ram',     service_id: null, metric_name: 'ram_usage_mb',       threshold_value: 3500, severity: 'critical', enabled: true },
  { id: 'thr-disk',    service_id: null, metric_name: 'disk_usage_percent',  threshold_value: 85,   severity: 'warning',  enabled: true },
  { id: 'thr-latency', service_id: null, metric_name: 'snmp_latency_ms',    threshold_value: 100,  severity: 'warning',  enabled: true },
];

let ALERTS = [
  {
    id:              'alert-1',
    service_id:      'svc-passbolt',
    service_name:    'Passbolt',
    metric_name:     'Uso de CPU',
    current_value:   87.3,
    threshold_value: 80,
    severity:        'warning',
    triggered_at:    ts(45),
    resolved:        false,
    resolved_at:     null,
  },
  {
    id:              'alert-2',
    service_id:      'svc-chkmonitor',
    service_name:    'ChkMonitor',
    metric_name:     'Uso de memoria (RAM)',
    current_value:   3720,
    threshold_value: 3500,
    severity:        'critical',
    triggered_at:    ts(20),
    resolved:        false,
    resolved_at:     null,
  },
  {
    id:              'alert-3',
    service_id:      'svc-chkmonitor',
    service_name:    'ChkMonitor',
    metric_name:     'Uso de disco',
    current_value:   86.1,
    threshold_value: 85,
    severity:        'warning',
    triggered_at:    ts(180),
    resolved:        true,
    resolved_at:     ts(160),
  },
];

let EVENTS = [
  {
    id:           'evt-1',
    service_id:   'svc-chkmonitor',
    service_name: 'ChkMonitor',
    event_type:   'down',
    started_at:   ts(180),
    ended_at:     ts(165),
    duration_s:   15 * 60,
    cause:        'SNMP timeout — puerto 2161 no respondió',
    resolved:     true,
    created_at:   ts(180),
  },
  {
    id:           'evt-2',
    service_id:   'svc-chkmonitor',
    service_name: 'ChkMonitor',
    event_type:   'recovered',
    started_at:   ts(165),
    ended_at:     ts(165),
    duration_s:   0,
    cause:        null,
    resolved:     true,
    created_at:   ts(165),
  },
  {
    id:           'evt-3',
    service_id:   'svc-passbolt',
    service_name: 'Passbolt',
    event_type:   'degraded',
    started_at:   ts(60),
    ended_at:     ts(45),
    duration_s:   15 * 60,
    cause:        'Latencia SNMP > 100 ms',
    resolved:     true,
    created_at:   ts(60),
  },
];

let COLLECTOR_RUNS = [];
for (let i = 9; i >= 0; i--) {
  const success = Math.random() > 0.1;
  COLLECTOR_RUNS.push({
    id:                randomUUID(),
    started_at:        ts(i * 5 + 0.3),
    finished_at:       ts(i * 5),
    duration_ms:       randInt(700, 2800),
    services_polled:   2,
    success,
    error_message:     success ? null : 'SNMP connection refused',
    collector_version: '1.0.0',
  });
}

let ACCESS_LOGS = [
  {
    id:              randomUUID(),
    user_id:         'usr-master',
    display_name:    'Master Admin',
    action:          'login',
    timestamp:       ts(30),
    ip_address:      '192.168.1.100',
    device_name:     'MacBook Pro',
    device_platform: 'macos',
  },
  {
    id:              randomUUID(),
    user_id:         'usr-admin',
    display_name:    'Daniel Rojas',
    action:          'login',
    timestamp:       ts(90),
    ip_address:      '192.168.1.101',
    device_name:     'iPhone 15',
    device_platform: 'ios',
  },
  {
    id:              randomUUID(),
    user_id:         'usr-viewer',
    display_name:    'Jheampierre Ralli',
    action:          'login',
    timestamp:       ts(240),
    ip_address:      '192.168.1.102',
    device_name:     'Pixel 8',
    device_platform: 'android',
  },
];

// ─── Express + Socket.IO ─────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sin token' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', mode: 'mock' }));

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email y password requeridos' });
  }
  const user = USERS.find(u => u.email === email && u._password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

  user.last_login = new Date().toISOString();
  ACCESS_LOGS.unshift({
    id: randomUUID(), user_id: user.id, display_name: user.display_name,
    action: 'login', timestamp: new Date().toISOString(),
    ip_address: req.ip, device_name: null, device_platform: null,
  });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' },
  );
  res.json({
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const user = USERS.find(u => u.id === req.user.id);
  ACCESS_LOGS.unshift({
    id: randomUUID(), user_id: req.user.id,
    display_name: user?.display_name ?? '',
    action: 'logout', timestamp: new Date().toISOString(),
    ip_address: req.ip, device_name: null, device_platform: null,
  });
  res.json({ ok: true });
});

// ─── Users ───────────────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, (_, res) => {
  res.json(USERS.map(({ _password, ...u }) => u));
});

app.get('/api/users/access-logs', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50'),  200);
  const userId = req.query.userId;
  let logs = ACCESS_LOGS;
  if (userId) logs = logs.filter(l => l.user_id === userId);
  res.json(logs.slice(0, limit));
});

app.post('/api/users/access-logs', requireAuth, (req, res) => {
  const { userId, displayName, action, deviceName, devicePlatform } = req.body ?? {};
  if (!userId || !displayName || !action) {
    return res.status(400).json({ error: 'userId, displayName y action requeridos' });
  }
  const log = {
    id: randomUUID(), user_id: userId, display_name: displayName,
    action, timestamp: new Date().toISOString(),
    ip_address: req.ip, device_name: deviceName ?? null,
    device_platform: devicePlatform ?? null,
  };
  ACCESS_LOGS.unshift(log);
  res.json(log);
});

app.patch('/api/users/:id/role', requireAuth, (req, res) => {
  if (!['admin', 'master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Sin permisos' });
  }
  const { role } = req.body ?? {};
  if (!['viewer', 'admin', 'master'].includes(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  const user = USERS.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  user.role = role;
  res.json({ ok: true });
});

// ─── Services ────────────────────────────────────────────────────────────────

app.get('/api/services', requireAuth, (_, res) => {
  res.json(SERVICES.filter(s => s.enabled));
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

app.get('/api/metrics/latest', requireAuth, (_, res) => {
  const seen = new Set();
  const latest = [];
  for (const m of [...METRICS].reverse()) {
    if (!seen.has(m.service_id)) {
      seen.add(m.service_id);
      latest.push(m);
    }
  }
  res.json(latest);
});

app.get('/api/metrics/:serviceId', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  const { from, to } = req.query;
  let rows = METRICS.filter(m => m.service_id === req.params.serviceId);
  if (from && to) {
    const f = new Date(from), t = new Date(to);
    rows = rows.filter(m => {
      const d = new Date(m.collected_at);
      return d >= f && d <= t;
    });
  }
  rows = [...rows].sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at));
  res.json(rows.slice(0, limit));
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

app.get('/api/alerts', requireAuth, (req, res) => {
  const { since } = req.query;
  let rows = ALERTS.filter(a => !a.resolved);
  if (since) {
    const sinceDate = new Date(since);
    rows = rows.filter(a => new Date(a.triggered_at) > sinceDate);
  }
  rows = [...rows].sort((a, b) => new Date(b.triggered_at) - new Date(a.triggered_at));
  res.json(rows.slice(0, 100));
});

app.get('/api/alerts/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  const rows = [...ALERTS].sort((a, b) => new Date(b.triggered_at) - new Date(a.triggered_at));
  res.json(rows.slice(0, limit));
});

app.get('/api/alerts/thresholds', requireAuth, (_, res) => {
  res.json(THRESHOLDS.filter(t => t.enabled));
});

app.patch('/api/alerts/:id/resolve', requireAuth, (req, res) => {
  if (!['admin', 'master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Sin permisos' });
  }
  const alert = ALERTS.find(a => a.id === req.params.id && !a.resolved);
  if (!alert) return res.status(404).json({ error: 'Alerta no encontrada o ya resuelta' });
  alert.resolved    = true;
  alert.resolved_at = new Date().toISOString();
  // Push lista actualizada a todos los clientes
  io.emit('active_alerts', ALERTS.filter(a => !a.resolved));
  res.json({ ok: true });
});

// ─── Monitoring ───────────────────────────────────────────────────────────────

function toEventRow({ service_name, ...event }) {
  return { ...event, monitored_services: service_name ? { service_name } : null };
}

app.get('/api/monitoring/events/active', requireAuth, (_, res) => {
  const active = EVENTS.filter(e => !e.resolved && !e.ended_at);
  res.json(active.map(toEventRow));
});

app.get('/api/monitoring/events/recent', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30'), 100);
  const rows  = [...EVENTS].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  res.json(rows.slice(0, limit).map(toEventRow));
});

app.get('/api/monitoring/events', requireAuth, (req, res) => {
  const { serviceId } = req.query;
  if (!serviceId) return res.status(400).json({ error: 'serviceId requerido' });
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  const rows  = EVENTS
    .filter(e => e.service_id === serviceId)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, limit);
  res.json(rows.map(toEventRow));
});

app.get('/api/monitoring/collector', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  res.json(COLLECTOR_RUNS.slice(0, limit));
});

// ─── Database health ──────────────────────────────────────────────────────────

app.get('/api/db/health', requireAuth, (req, res) => {
  const instanceId = req.query.instanceId || 'postgresql-primary-phase2';
  res.json({
    instance_id:        instanceId,
    latency_ms:         randInt(2, 12),
    storage_mb:         randInt(180, 320),
    active_connections: randInt(3, 18),
    cache_hit_percent:  parseFloat(rand(96, 99.9).toFixed(1)),
    total_tables:       8,
    total_rows:         randInt(800, 2000),
    last_write_at:      ts(randInt(0, 6)),
    collected_at:       new Date().toISOString(),
  });
});

const TABLE_NAMES = [
  'alert_events', 'alert_thresholds', 'collector_runs',
  'metrics', 'monitored_services', 'service_events',
  'user_access_logs', 'users',
];

app.get('/api/db/tables', requireAuth, (req, res) => {
  const instanceId = req.query.instanceId || 'postgresql-primary-phase2';
  const now = new Date().toISOString();
  const APPROX_ROWS = { metrics: 1200, user_access_logs: 80, collector_runs: 150,
    alert_events: 25, service_events: 18, monitored_services: 2,
    users: 3, alert_thresholds: 4 };
  res.json(TABLE_NAMES.map(name => ({
    instance_id:   instanceId,
    table_name:    name,
    live_rows:     APPROX_ROWS[name] ?? 0,
    dead_rows:     randInt(0, 5),
    size_mb:       name === 'metrics' ? randInt(8, 20) : 0,
    seq_scans:     randInt(10, 200),
    index_scans:   randInt(50, 500),
    last_analyzed: ts(randInt(30, 120)),
    last_vacuumed: ts(randInt(60, 240)),
    collected_at:  now,
  })));
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[ws] cliente conectado: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[ws] desconectado: ${socket.id}`));
});

// ─── Helpers de emisión server-side ──────────────────────────────────────────

function emitDbHealth() {
  io.emit('db_health', {
    instance_id:        'postgresql-primary-phase2',
    latency_ms:         randInt(2, 12),
    storage_mb:         randInt(180, 320),
    active_connections: randInt(3, 18),
    cache_hit_percent:  parseFloat(rand(96, 99.9).toFixed(1)),
    total_tables:       8,
    total_rows:         randInt(800, 2000),
    last_write_at:      ts(randInt(0, 6)),
    collected_at:       new Date().toISOString(),
  });
}

function emitActiveAlerts() {
  io.emit('active_alerts', ALERTS.filter(a => !a.resolved));
}

function emitActiveEvents() {
  io.emit('active_events', EVENTS
    .filter(e => !e.resolved && !e.ended_at)
    .map(toEventRow));
}

// ─── Intervalos server-side (cada 30 s) ──────────────────────────────────────

setInterval(() => {
  // 1. Metric por cada servicio
  for (const svc of SERVICES) {
    const metric = makeMetric(svc.id, 0);
    metric.collected_at = new Date().toISOString();
    METRICS.push(metric);
    if (METRICS.length > 200) METRICS.splice(0, METRICS.length - 200);
    io.emit('metric', metric);
    console.log(`[mock] metric → ${svc.service_name} cpu=${metric.cpu_usage_percent}%`);
  }

  // 2. DB health
  emitDbHealth();

  // 3. Lista activa de alertas y eventos
  emitActiveAlerts();
  emitActiveEvents();

  // 4. Nueva alerta aleatoria (10 % de probabilidad)
  if (Math.random() < 0.10) {
    const svc = SERVICES[randInt(0, 1)];
    const alert = {
      id:              randomUUID(),
      service_id:      svc.id,
      service_name:    svc.service_name,
      metric_name:     'Uso de CPU',
      current_value:   parseFloat(rand(81, 95).toFixed(1)),
      threshold_value: 80,
      severity:        'warning',
      triggered_at:    new Date().toISOString(),
      resolved:        false,
      resolved_at:     null,
    };
    ALERTS.unshift(alert);
    io.emit('alert', alert);           // evento individual (watchAlertInserts)
    emitActiveAlerts();                // lista completa actualizada
    console.log(`[mock] alerta → ${svc.service_name}`);
  }

  // 5. Nuevo collector run
  const success = Math.random() > 0.08;
  const run = {
    id:                randomUUID(),
    started_at:        ts(0.05),
    finished_at:       new Date().toISOString(),
    duration_ms:       randInt(600, 2500),
    services_polled:   2,
    success,
    error_message:     success ? null : 'SNMP connection refused',
    collector_version: '1.0.0',
  };
  COLLECTOR_RUNS.unshift(run);
  if (COLLECTOR_RUNS.length > 100) COLLECTOR_RUNS.pop();
  io.emit('collector_run', run);       // evento individual (watchLastCollectorRun)

}, 30_000);

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  Cuy Sentinel MOCK API  →  :${PORT}       ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Credenciales de prueba:                 ║');
  console.log('║    master@cuy.local  / sentinel2025      ║');
  console.log('║    admin@cuy.local   / admin2025         ║');
  console.log('║    viewer@cuy.local  / viewer2025        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Métricas emitidas vía Socket.IO c/30 s  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
