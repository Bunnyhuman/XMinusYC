const express = require('express');
const store = require('../db/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const list = store.listCollections(req.user.id).map(c => ({ ...c, tracks_count: store.getCollectionTracks(c.id).length }));
  res.json({ collections: list });
});
router.get('/:id', (req, res) => {
  const c = store.findCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'Не найден' });
  res.json({ collection: c, tracks: store.getCollectionTracks(c.id) });
});
router.post('/', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Название обязательно' });
  res.json({ ok: true, collection: store.createCollection(req.user.id, String(name).trim(), description || '') });
});
router.post('/:id/tracks', requireAuth, (req, res) => {
  const { track_id } = req.body || {};
  if (!track_id) return res.status(400).json({ error: 'track_id обязателен' });
  if (!store.addToCollection(req.params.id, track_id, req.user.id)) return res.status(403).json({ error: 'Нет прав или не найден' });
  res.json({ ok: true });
});
router.delete('/:id/tracks/:trackId', requireAuth, (req, res) => {
  if (!store.removeFromCollection(req.params.id, req.params.trackId, req.user.id)) return res.status(403).json({ error: 'Нет прав' });
  res.json({ ok: true });
});
router.delete('/:id', requireAuth, (req, res) => {
  if (!store.deleteCollection(req.params.id, req.user.id)) return res.status(403).json({ error: 'Нет прав' });
  res.json({ ok: true });
});
module.exports = router;
