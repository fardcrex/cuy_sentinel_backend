const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/alerts?since=<iso>
router.get('/', requireAuth, async (req, res) => {
  const { since } = req.query;
  try {
    const params = [];
    let query = 'SELECT * FROM alert_events WHERE resolved = false';
    if (since) {
      params.push(since);
      query += ` AND triggered_at > $${params.length}`;
    }
    query += ' ORDER BY triggered_at DESC LIMIT 100';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/history?limit=50
router.get('/history', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/thresholds
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

    // Push lista actualizada a todos los clientes conectados
    const { rows } = await pool.query(
      `SELECT * FROM alert_events WHERE resolved=false ORDER BY triggered_at DESC LIMIT 100`
    );
    req.app.locals.io.emit('active_alerts', rows);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
