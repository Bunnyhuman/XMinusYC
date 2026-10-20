const express = require('express');
const path = require('path');
const store = require('../db/store');
const cfg = require('../config');
const { requireAuth } = require('../middleware/auth');
const U = require('../util/uploads');

const router = express.Router();
const photoUpload = U.multerFor({ audio: false, imageFields: ['photo'] });

router.get('/letter/:letter', (req, res) => {
  const letter = req.params.letter;
  const artists = store.listArtistsByLetter(letter);
  res.json({ letter, artists, total: artists.length });
});
router.get('/:name', (req, res) => {
  const name = req.params.name;
  const artist = store.findArtist(name) || { name, photo: null, bio: '' }; // не создаём записи по произвольным запросам
  const tracks = store.listTracksByArtist(name);
  res.json({ artist, tracks, total: tracks.length });
});
router.put('/:name', requireAuth, (req, res) => {
  const { bio } = req.body || {};
  if (bio !== undefined && String(bio).length > 500) return res.status(400).json({ error: 'Описание максимум 500 символов' });
  if (!store.findArtist(req.params.name)) return res.status(404).json({ error: 'Исполнитель не найден' });
  res.json({ ok: true, artist: store.updateArtist(req.params.name, { bio }, { isAdmin: req.user.is_admin, userId: req.user.id }) });
});
router.post('/:name/photo', requireAuth, (req, res) => {
  if (!store.findArtist(req.params.name)) return res.status(404).json({ error: 'Исполнитель не найден' });
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const photo = U.storeImage(req.file, path.join(cfg.PUBLIC_DIR, 'artists'), '/artists');
    if (!photo) return res.status(400).json({ error: 'Файл не является изображением' });
    const before = store.findArtist(req.params.name);
    const result = store.updateArtist(req.params.name, { photo }, { isAdmin: req.user.is_admin, userId: req.user.id });
    if (result.photo !== photo) { U.removePublicFile(photo); return res.status(403).json({ error: 'Фото уже задано — менять может только админ' }); }
    if (before && before.photo) U.removePublicFile(before.photo);
    res.json({ ok: true, artist: result });
  });
});
module.exports = router;
