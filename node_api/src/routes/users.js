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
