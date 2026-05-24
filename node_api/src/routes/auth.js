const router = require('express').Router();
const bcrypt = require('bcrypt');
const pool = require('../db');
const { signToken, requireAuth } = require('../auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email y password requeridos' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, display_name, role FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    await pool.query(
      `INSERT INTO user_access_logs (user_id, display_name, action, ip_address)
       VALUES ($1, $2, 'login', $3)`,
      [user.id, user.display_name, req.ip]
    );
    await pool.query(
      'UPDATE users SET last_login = now() WHERE id = $1',
      [user.id]
    );
    res.json({
      token,
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT display_name FROM users WHERE id = $1',
      [req.user.id]
    );
    await pool.query(
      `INSERT INTO user_access_logs (user_id, display_name, action, ip_address)
       VALUES ($1, $2, 'logout', $3)`,
      [req.user.id, rows[0]?.display_name ?? '', req.ip]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
