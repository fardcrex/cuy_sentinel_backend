const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/services
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM monitored_services WHERE enabled = true ORDER BY service_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
