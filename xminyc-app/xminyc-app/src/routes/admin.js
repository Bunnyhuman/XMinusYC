const express = require('express');
const store = require('../db/store');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();
router.use(requireAdmin);

router.get('/stats', (_req, res) => res.json(store.getStats()));
router.get('/users', (req, res) => {
  res.json(store.listUsers({
    q: String(req.query.q || '').slice(0, 60),
    limit: Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200),
    offset: Math.max(parseInt(req.query.offset) || 0, 0)
  }));
});
router.post('/users/:id/ban', (req, res) => {
  const u = store.findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
  if (u.is_admin) return res.status(400).json({ error: 'Нельзя заблокировать администратора' });
  const banned = !!(req.body || {}).banned;
  store.setBanned(u.id, banned);
  if (banned) store.db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"userId":${u.id}%`);
  res.json({ ok: true, banned });
});
module.exports = router;
