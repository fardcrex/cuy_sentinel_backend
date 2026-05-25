const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Exponer io a las rutas para emit post-mutación (e.g. resolve alert)
app.locals.io = io;

// Routes
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/users',      require('./routes/users'));
app.use('/api/services',   require('./routes/services'));
app.use('/api/metrics',    require('./routes/metrics'));
app.use('/api/alerts',     require('./routes/alerts'));
app.use('/api/monitoring', require('./routes/monitoring'));
app.use('/api/db',         require('./routes/databases'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── pg connection (compartida para LISTEN y queries de intervalos) ───────────

const pgCfg = {
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'postgres',
  user:     process.env.PG_USER     || 'app',
  password: process.env.PG_PASSWORD || 'app_secret_2025',
};

const listenerPool = new Pool(pgCfg);
const queryPool    = new Pool(pgCfg);   // pool separado para los intervalos

// ─── Helpers de emisión server-side ──────────────────────────────────────────

async function emitDbHealth() {
  const start = Date.now();
  try {
    await queryPool.query('SELECT 1');
    const latencyMs = Date.now() - start;
    const { rows } = await queryPool.query(`
      SELECT
        (pg_database_size(current_database()) / 1048576)::int          AS storage_mb,
        (SELECT count(*)::int FROM pg_stat_activity WHERE state='active') AS active_connections,
        (SELECT round(blks_hit*100.0/nullif(blks_hit+blks_read,0),1)
         FROM pg_stat_database WHERE datname=current_database())        AS cache_hit_percent,
        (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema='public')                                    AS total_tables,
        (SELECT coalesce(sum(n_live_tup),0)::int FROM pg_stat_user_tables) AS total_rows,
        (SELECT max(collected_at) FROM metrics)                          AS last_write_at
    `);
    const h = rows[0];
    io.emit('db_health', {
      instance_id:        'postgresql-primary-phase2',
      latency_ms:         latencyMs,
      storage_mb:         h.storage_mb         || 0,
      active_connections: h.active_connections  || 0,
      cache_hit_percent:  parseFloat(h.cache_hit_percent) || 0,
      total_tables:       h.total_tables        || 0,
      total_rows:         h.total_rows          || 0,
      last_write_at:      h.last_write_at       || null,
      collected_at:       new Date().toISOString(),
    });
  } catch (_) {}
}

async function emitActiveAlerts() {
  try {
    const { rows } = await queryPool.query(
      `SELECT * FROM alert_events WHERE resolved=false ORDER BY triggered_at DESC LIMIT 100`
    );
    io.emit('active_alerts', rows);
  } catch (_) {}
}

async function emitActiveEvents() {
  try {
    const { rows } = await queryPool.query(`
      SELECT se.*, ms.service_name
      FROM service_events se
      JOIN monitored_services ms ON ms.id = se.service_id
      WHERE se.resolved=false AND se.ended_at IS NULL
      ORDER BY se.started_at DESC
    `);
    io.emit('active_events', rows.map(({ service_name, ...e }) => ({
      ...e, monitored_services: service_name ? { service_name } : null,
    })));
  } catch (_) {}
}

// ─── pg LISTEN/NOTIFY → Socket.IO ────────────────────────────────────────────

listenerPool.connect().then(client => {
  client.query('LISTEN new_metric');
  client.query('LISTEN new_alert');
  client.query('LISTEN new_collector_run');
  client.query('LISTEN new_service_event');

  client.on('notification', msg => {
    const payload = JSON.parse(msg.payload);
    switch (msg.channel) {
      case 'new_metric':        io.emit('metric',        payload); break;
      case 'new_alert':         io.emit('alert',         payload);
                                emitActiveAlerts();      break;  // refresca lista completa
      case 'new_collector_run': io.emit('collector_run', payload); break;
      case 'new_service_event': io.emit('service_event', payload);
                                emitActiveEvents();      break;  // refresca lista activa
    }
  });
}).catch(err => console.error('LISTEN error:', err.message));

// ─── Intervalos server-side (push cada 30 s a todos los clientes) ─────────────

setInterval(emitDbHealth,     30_000);
setInterval(emitActiveAlerts, 30_000);
setInterval(emitActiveEvents, 30_000);

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`API listening on :${PORT}`));
