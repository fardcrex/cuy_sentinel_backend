const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/alerts
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM alert_events
       WHERE resolved = false
       ORDER BY triggered_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/alerts/:id/resolve
router.patch('/:id/resolve', requireAuth, async (req, res) => {
  if (!['admin', 'master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Sin permisos' });
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE alert_events SET resolved = true, resolved_at = now()
       WHERE id = $1 AND resolved = false`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Alerta no encontrada o ya resuelta' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/thresholds
router.get('/thresholds', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM alert_thresholds WHERE enabled = true ORDER BY metric_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
