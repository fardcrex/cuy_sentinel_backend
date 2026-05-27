'use strict';

const { Pool } = require('pg');

class PostgresStorage {
  constructor(pool) {
    this.pool = pool;
  }

  async getServices() {
    const { rows } = await this.pool.query(
      `SELECT id, service_name, host_ip, snmp_port, 'public' AS community
       FROM monitored_services WHERE enabled = true`,
    );
    return rows.map((r) => ({
      id:        r.id,
      name:      r.service_name,
      host:      r.host_ip,
      snmpPort:  r.snmp_port,
      community: r.community,
    }));
  }

  async saveMetric(record) {
    await this.pool.query(
      `INSERT INTO metrics
         (service_id, cpu_usage_percent, ram_usage_mb, ram_total_mb,
          disk_usage_percent, bandwidth_in_mb, bandwidth_out_mb,
          uptime_seconds, service_status, snmp_latency_ms, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.serviceId,       record.cpuUsagePercent,
        record.ramUsageMB,      record.ramTotalMB,
        record.diskUsagePercent, record.bandwidthInMB,
        record.bandwidthOutMB,  record.uptimeSeconds,
        record.serviceStatus,   record.snmpLatencyMs,
        record.collectedAt,
      ],
    );
  }

  async activeEvent(serviceId) {
    const { rows } = await this.pool.query(
      `SELECT id FROM service_events
       WHERE service_id = $1 AND event_type = 'down' AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [serviceId],
    );
    return rows.length > 0 ? rows[0].id : '';
  }

  async recordDown(serviceId, cause) {
    const existing = await this.activeEvent(serviceId);
    if (existing) return existing;

    const { rows } = await this.pool.query(
      `INSERT INTO service_events (service_id, event_type, started_at, cause)
       VALUES ($1, 'down', now(), $2) RETURNING id`,
      [serviceId, cause],
    );
    return rows[0].id;
  }

  async recordRecovered(serviceId, openEventId) {
    if (openEventId) {
      await this.pool.query(
        `UPDATE service_events SET ended_at = now(), resolved = true WHERE id = $1`,
        [openEventId],
      );
    }
    await this.pool.query(
      `INSERT INTO service_events (service_id, event_type, started_at, resolved)
       VALUES ($1, 'recovered', now(), true)`,
      [serviceId],
    );
  }

  async saveCollectorRun({ servicesPolled, success, errorMessage, durationMs }) {
    const startedAt = new Date(Date.now() - durationMs);
    await this.pool.query(
      `INSERT INTO collector_runs
         (started_at, finished_at, services_polled, success, error_message)
       VALUES ($1, now(), $2, $3, $4)`,
      [startedAt, servicesPolled, success, errorMessage ?? null],
    );
  }

  async close() {
    await this.pool.end();
  }
}

// Backoff schedule: 2s, 4s, 8s, 16s, 30s, 30s, 30s → ~2 min total before giving up
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 30000, 30000];

async function newPostgresStorage(dsn) {
  const pool = new Pool({
    connectionString: dsn,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log('db connected');
      return new PostgresStorage(pool);
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) {
        await pool.end().catch(() => {});
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      console.log(`db connect attempt ${attempt + 1} failed (${err.message}), retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { newPostgresStorage };
