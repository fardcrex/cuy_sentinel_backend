const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/db/health?instanceId=<id>
router.get('/health', requireAuth, async (req, res) => {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - start;

    const { rows } = await pool.query(`
      SELECT
        (pg_database_size(current_database()) / 1048576)::int          AS storage_mb,
        (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active')
                                                                        AS active_connections,
        (SELECT round(blks_hit * 100.0 / nullif(blks_hit + blks_read, 0), 1)
         FROM pg_stat_database WHERE datname = current_database())      AS cache_hit_percent,
        (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema = 'public')                                 AS total_tables,
        (SELECT coalesce(sum(n_live_tup), 0)::int
         FROM pg_stat_user_tables)                                      AS total_rows,
        (SELECT max(collected_at) FROM metrics)                         AS last_write_at
    `);
    const h = rows[0];
    res.json({
      instance_id:        req.query.instanceId || 'postgresql-primary-phase2',
      latency_ms:         latencyMs,
      storage_mb:         h.storage_mb         || 0,
      active_connections: h.active_connections  || 0,
      cache_hit_percent:  parseFloat(h.cache_hit_percent) || 0,
      total_tables:       h.total_tables        || 0,
      total_rows:         h.total_rows          || 0,
      last_write_at:      h.last_write_at       || null,
      collected_at:       new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/db/tables?instanceId=<id>
router.get('/tables', requireAuth, async (req, res) => {
  const instanceId = req.query.instanceId || 'postgresql-primary-phase2';
  const now = new Date().toISOString();
  try {
    const { rows } = await pool.query(`
      SELECT
        t.table_name,
        coalesce(s.n_live_tup, 0)::int                                    AS live_rows,
        coalesce(s.n_dead_tup, 0)::int                                    AS dead_rows,
        (pg_total_relation_size(quote_ident(t.table_name)) / 1048576)::int AS size_mb,
        coalesce(s.seq_scan, 0)::int                                       AS seq_scans,
        coalesce(s.idx_scan,  0)::int                                      AS index_scans,
        s.last_analyze  AS last_analyzed,
        s.last_vacuum   AS last_vacuumed
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      WHERE t.table_schema = 'public'
      ORDER BY t.table_name
    `);
    res.json(rows.map(r => ({
      instance_id:   instanceId,
      table_name:    r.table_name,
      live_rows:     r.live_rows,
      dead_rows:     r.dead_rows,
      size_mb:       r.size_mb,
      seq_scans:     r.seq_scans,
      index_scans:   r.index_scans,
      last_analyzed: r.last_analyzed  || null,
      last_vacuumed: r.last_vacuumed  || null,
      collected_at:  now,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
