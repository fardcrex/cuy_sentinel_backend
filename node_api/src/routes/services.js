const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/services
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ms.*,
             COALESCE(m.service_status, 'unknown') AS current_status,
             m.collected_at AS last_metric_at
      FROM monitored_services ms
      LEFT JOIN LATERAL (
        SELECT service_status, collected_at
        FROM metrics
        WHERE service_id = ms.id
        ORDER BY collected_at DESC
        LIMIT 1
      ) m ON true
      WHERE ms.enabled = true
      ORDER BY ms.service_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
