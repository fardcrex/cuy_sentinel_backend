const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

function toEventRow({ service_name, ...event }) {
  return {
    ...event,
    monitored_services: service_name ? { service_name } : null,
  };
}

// GET /api/monitoring/events/active
router.get('/events/active', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT se.*, ms.service_name
      FROM service_events se
      JOIN monitored_services ms ON ms.id = se.service_id
      WHERE se.resolved = false AND se.ended_at IS NULL
      ORDER BY se.started_at DESC
    `);
    res.json(rows.map(toEventRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/events/recent?limit=30
router.get('/events/recent', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30'), 100);
  try {
    const { rows } = await pool.query(`
      SELECT se.*, ms.service_name
      FROM service_events se
      JOIN monitored_services ms ON ms.id = se.service_id
      ORDER BY se.started_at DESC LIMIT $1
    `, [limit]);
    res.json(rows.map(toEventRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/events?serviceId=<id>&limit=20
router.get('/events', requireAuth, async (req, res) => {
  const { serviceId } = req.query;
  if (!serviceId) return res.status(400).json({ error: 'serviceId requerido' });
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  try {
    const { rows } = await pool.query(`
      SELECT se.*, ms.service_name
      FROM service_events se
      JOIN monitored_services ms ON ms.id = se.service_id
      WHERE se.service_id = $1
      ORDER BY se.started_at DESC LIMIT $2
    `, [serviceId, limit]);
    res.json(rows.map(toEventRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitoring/collector?limit=50
router.get('/collector', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM collector_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
