const express = require('express');
const path = require('path');
const store = require('../db/store');
const cfg = require('../config');
const { requireAuth } = require('../middleware/auth');
const U = require('../util/uploads');

const router = express.Router();
const avatarUpload = U.multerFor({ audio: false, imageFields: ['avatar'] });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.put('/me', requireAuth, (req, res) => {
  const { bio, socials, email, password, display_name } = req.body || {};
  const fields = {};
  if (display_name !== undefined) { const dn = String(display_name || '').trim().slice(0, 40); fields.display_name = dn || null; }
  if (bio !== undefined) fields.bio = String(bio || '').slice(0, 500);
  if (socials !== undefined && socials && typeof socials === 'object') {
    fields.socials = {};
    for (const k of ['telegram', 'vk', 'youtube', 'instagram']) fields.socials[k] = String(socials[k] || '').slice(0, 200);
  }
  if (email !== undefined && String(email).trim() !== (req.user.email || '')) {
    const e = String(email).trim().toLowerCase();
    if (e && !EMAIL_RE.test(e)) return res.status(400).json({ error: 'Некорректный email' });
    fields.email = e;
  }
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    fields.password = String(password);
  }
  try {
    const updated = store.updateUser(req.user.id, fields);
    if (!updated) return res.status(404).json({ error: 'Не найден' });
    res.json({ ok: true, user: { ...store.publicUser(updated), email: updated.email, socials: updated.socials, bio: updated.bio } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/me/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const avatarPath = U.storeImage(req.file, path.join(cfg.PUBLIC_DIR, 'avatars'), '/avatars');
    if (!avatarPath) return res.status(400).json({ error: 'Файл не является изображением' });
    U.removePublicFile(req.user.avatar);
    store.updateUser(req.user.id, { avatar: avatarPath });
    res.json({ ok: true, avatar: avatarPath });
  });
});

router.get('/:username', (req, res) => {
  if (req.params.username === 'me') {
    if (!req.user) return res.status(401).json({ error: 'Нужно войти' });
    return res.json({ user: store.publicUser(req.user) });
  }
  const user = store.findUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: store.publicUser(user) });
});

module.exports = router;
