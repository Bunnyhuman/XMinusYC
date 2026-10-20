const express = require('express');
const store = require('../db/store');
const cfg = require('../config');
const mail = require('../mail');
const { requireAdmin } = require('../middleware/auth');
const { reportLimiter } = require('../middleware/security');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Жалоба на данные исполнителя (фото / описание)
router.post('/artist', reportLimiter, async (req, res) => {
  const { artist, wrong_photo, wrong_bio, message } = req.body || {};
  if (!artist || !String(artist).trim()) return res.status(400).json({ error: 'Не указан исполнитель' });
  if (!wrong_photo && !wrong_bio) return res.status(400).json({ error: 'Отметьте: неверное фото и/или описание' });
  const r = store.createReport({
    type: 'artist', artist: s(artist, 200), wrong: { photo: !!wrong_photo, bio: !!wrong_bio },
    message: s(message, 2000), from_user: req.user ? req.user.id : null
  });
  notify(`Жалоба #${r.id}: исполнитель «${r.artist}»`,
    `Исполнитель: ${r.artist}\nНеверное фото: ${wrong_photo ? 'да' : 'нет'}\nНеверное описание: ${wrong_bio ? 'да' : 'нет'}\nОт: ${req.user ? req.user.username : 'гость'}\n\n${r.message || '(без комментария)'}`);
  res.json({ ok: true, id: r.id });
});

// Заявление правообладателя о нарушении авторских прав
router.post('/copyright', reportLimiter, async (req, res) => {
  const b = req.body || {};
  const name = s(b.name, 200), email = s(b.email, 200).toLowerCase(), message = s(b.message, 3000);
  const trackUrl = s(b.track_url, 500);
  if (!name || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Укажите имя и корректный email' });
  if (!trackUrl && !b.track_id) return res.status(400).json({ error: 'Укажите ссылку на трек' });
  if (message.length < 20) return res.status(400).json({ error: 'Опишите, какое произведение и ваши права на него (минимум 20 символов)' });
  if (!b.confirm) return res.status(400).json({ error: 'Необходимо подтвердить достоверность заявления' });
  const m = trackUrl.match(/\/track\/(\d+)/);
  const trackId = Number(b.track_id) || (m ? Number(m[1]) : null);
  const r = store.createReport({
    type: 'copyright', track_id: trackId, track_url: trackUrl, message, from_user: req.user ? req.user.id : null,
    contact_name: name, contact_email: email
  });
  notify(`Заявление правообладателя #${r.id}`, `Заявитель: ${name} <${email}>\nТрек: ${trackUrl || '#' + trackId}\n\n${message}`, email);
  res.json({ ok: true, id: r.id });
});

function notify(subject, text, replyTo) {
  if (!cfg.REPORT_EMAIL) return;
  mail.send({ to: cfg.REPORT_EMAIL, subject: `[${cfg.SITE_NAME}] ${subject}`, text, replyTo }).catch(() => {});
}

// Очередь жалоб для админа
router.get('/', requireAdmin, (req, res) => res.json({ reports: store.listReports(req.query.status || null) }));
router.post('/:id/resolve', requireAdmin, (req, res) => {
  const ok = store.resolveReport(req.params.id, req.user.id, (req.body || {}).status === 'dismissed' ? 'dismissed' : 'done');
  if (!ok) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});
module.exports = router;
