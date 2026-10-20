const express = require('express');
const store = require('../db/store');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router = express.Router();

router.get('/', (req, res) => {
  const sort = req.query.sort === 'plays' ? 'plays' : 'tracks';
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  res.json(store.listArrangers({ sort, limit, offset }));
});
router.get('/application/me', requireAuth, (req, res) => res.json({ application: store.getUserArrangerApplication(req.user.id) }));
router.post('/application', requireAuth, (req, res) => {
  const { description, links } = req.body || {};
  if (!description || String(description).trim().length < 20) return res.status(400).json({ error: 'Опишите свою деятельность (минимум 20 символов)' });
  try { res.json({ ok: true, application: store.submitArrangerApplication({ userId: req.user.id, description, links }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/applications', requireAdmin, (req, res) => res.json({ applications: store.listArrangerApplications(req.query.status || null) }));
router.post('/applications/:id/review', requireAdmin, (req, res) => {
  const { approve, reason } = req.body || {};
  const result = store.reviewArrangerApplication(req.params.id, { approve: !!approve, reason, adminId: req.user.id });
  if (!result) return res.status(404).json({ error: 'Заявка не найдена' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, application: result });
});
router.post('/users/:id/role', requireAdmin, (req, res) => {
  const u = store.setArrangerRole(req.params.id, !!(req.body || {}).is_arranger, req.user.id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ ok: true, user: store.publicUser(u) });
});
module.exports = router;
