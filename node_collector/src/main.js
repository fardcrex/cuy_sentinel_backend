'use strict';

const http = require('http');
const { newPostgresStorage } = require('./storage/postgresStorage');
const { collect } = require('./collector/snmpCollector');

// ─── Health state ────────────────────────────────────────────────────────────

const health = {
  status:        'starting', // 'starting' | 'ok' | 'error'
  dbConnected:   false,
  lastPollAt:    null,
  servicesCount: 0,
  startedAt:     new Date().toISOString(),
};

function startHealthServer(port) {
  http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = health.status === 'ok' ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...health, uptimeSeconds: Math.floor(process.uptime()) }));
  }).listen(port, () => console.log(`health server listening on :${port}`));
}

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const dsn = process.env.PG_DSN ||
    'postgres://app:app_secret_2025@localhost:5432/postgres?sslmode=disable';
  const seconds = parseInt(process.env.SNMP_INTERVAL || '300', 10);
  const healthPort = parseInt(process.env.HEALTH_PORT || '9090', 10);
  return { dsn, intervalMs: (seconds > 0 ? seconds : 300) * 1000, healthPort };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Event helpers ───────────────────────────────────────────────────────────

// Loads the current open event from DB the first time a service is seen,
// so the in-memory map survives process restarts.
async function syncActiveEvent(store, svc, activeEvents) {
  if (svc.id in activeEvents) return;
  const openId = await store.activeEvent(svc.id);
  activeEvents[svc.id] = openId;
}

async function handleDown(store, svc, collectErr, activeEvents) {
  if (activeEvents[svc.id]) return;

  const cause = collectErr ? (collectErr.message || 'SNMP unreachable') : 'SNMP unreachable';
  const eventId = await store.recordDown(svc.id, cause);
  activeEvents[svc.id] = eventId;
  console.log(`⚠ ${svc.name} DOWN — event ${eventId} opened`);
}

async function handleRecovered(store, svc, activeEvents) {
  const eventId = activeEvents[svc.id];
  if (!eventId) return;

  await store.recordRecovered(svc.id, eventId);
  console.log(`✓ ${svc.name} RECOVERED — event ${eventId} closed`);
  activeEvents[svc.id] = '';
}

async function processService(store, svc, activeEvents) {
  await syncActiveEvent(store, svc, activeEvents);

  let metrics = null;
  let collectErr = null;

  try {
    metrics = await collect({
      serviceId: svc.id,
      host:      svc.host,
      port:      svc.snmpPort,
      community: svc.community,
    });
  } catch (err) {
    collectErr = err;
  }

  const isDown = collectErr !== null || !metrics?.serviceUp;

  if (isDown) {
    await handleDown(store, svc, collectErr, activeEvents);
  } else {
    await handleRecovered(store, svc, activeEvents);
  }

  const status = isDown ? 'offline' : 'online';

  try {
    await store.saveMetric({
      serviceId:        svc.id,
      cpuUsagePercent:  metrics?.cpuUsagePercent  ?? 0,
      ramUsageMB:       metrics?.ramUsageMB       ?? 0,
      ramTotalMB:       metrics?.ramTotalMB       ?? 0,
      diskUsagePercent: metrics?.diskUsagePercent ?? 0,
      bandwidthInMB:    metrics?.bandwidthInMB    ?? 0,
      bandwidthOutMB:   metrics?.bandwidthOutMB   ?? 0,
      uptimeSeconds:    metrics?.uptimeSeconds    ?? 0,
      serviceStatus:    status,
      snmpLatencyMs:    metrics?.snmpLatencyMs    ?? 0,
      collectedAt:      new Date(),
    });
    console.log(`✓ ${svc.name} — ${status}`);
  } catch (err) {
    console.error(`save metric ${svc.name}: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();

  startHealthServer(cfg.healthPort);

  let store;
  try {
    store = await newPostgresStorage(cfg.dsn);
    health.dbConnected = true;
    health.status = 'ok';
  } catch (err) {
    health.status = 'error';
    throw err;
  }

  const activeEvents = {};

  console.log(`collector started — polling every ${cfg.intervalMs / 1000}s`);

  while (true) {
    let services;
    try {
      services = await store.getServices();
      health.servicesCount = services.length;
    } catch (err) {
      console.error(`get services: ${err.message}`);
      health.status = 'error';
      await sleep(cfg.intervalMs);
      continue;
    }

    const pollStart = Date.now();
    let pollError = null;

    for (const svc of services) {
      try {
        await processService(store, svc, activeEvents);
      } catch (err) {
        pollError = err.message;
        console.error(`process service ${svc.name}: ${err.message}`);
      }
    }

    const durationMs = Date.now() - pollStart;
    try {
      await store.saveCollectorRun({
        servicesPolled: services.length,
        success: pollError === null,
        errorMessage: pollError,
        durationMs,
      });
    } catch (err) {
      console.error(`save collector run: ${err.message}`);
    }

    health.lastPollAt = new Date().toISOString();
    health.status = 'ok';
    await sleep(cfg.intervalMs);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
