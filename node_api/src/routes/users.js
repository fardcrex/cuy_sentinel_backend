const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

// GET /api/users
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, display_name, role, last_login, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/access-logs?limit=50&userId=<id>
router.get('/access-logs', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  const { userId } = req.query;
  try {
    let query, params;
    if (userId) {
      query = `SELECT * FROM user_access_logs WHERE user_id = $1
               ORDER BY timestamp DESC LIMIT $2`;
      params = [userId, limit];
    } else {
      query = `SELECT * FROM user_access_logs ORDER BY timestamp DESC LIMIT $1`;
      params = [limit];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/access-logs
router.post('/access-logs', requireAuth, async (req, res) => {
  const { userId, displayName, action, deviceName, devicePlatform } = req.body;
  if (!userId || !displayName || !action) {
    return res.status(400).json({ error: 'userId, displayName y action requeridos' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO user_access_logs
         (user_id, display_name, action, device_name, device_platform, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, displayName, action, deviceName ?? null, devicePlatform ?? null, req.ip]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id/role
router.patch('/:id/role', requireAuth, async (req, res) => {
  if (!['admin', 'master'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Sin permisos' });
  }
  const { role } = req.body;
  if (!['viewer', 'admin', 'master'].includes(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2',
      [role, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
