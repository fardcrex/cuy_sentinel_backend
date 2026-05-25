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

// GET /api/metrics/:serviceId?limit=50&from=<iso>&to=<iso>
router.get('/:serviceId', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 500);
  const { from, to } = req.query;
  try {
    let query, params;
    if (from && to) {
      query = `SELECT * FROM metrics WHERE service_id = $1
               AND collected_at BETWEEN $2 AND $3
               ORDER BY collected_at DESC LIMIT $4`;
      params = [req.params.serviceId, from, to, limit];
    } else {
      query = `SELECT * FROM metrics WHERE service_id = $1
               ORDER BY collected_at DESC LIMIT $2`;
      params = [req.params.serviceId, limit];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
