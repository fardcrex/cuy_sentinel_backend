const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/metrics/latest
router.get('/latest', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (service_id) *
      FROM metrics
      ORDER BY service_id, collected_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metrics/:serviceId?limit=50
router.get('/:serviceId', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM metrics WHERE service_id = $1
       ORDER BY collected_at DESC LIMIT $2`,
      [req.params.serviceId, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
