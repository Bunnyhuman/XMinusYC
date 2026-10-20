const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('../db/store');
const cfg = require('../config');
const mail = require('../mail');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, registerLimiter, mailLimiter } = require('../middleware/security');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const USERNAME_RE = /^[\p{L}\p{N}._-]{2,24}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASS = 8;

const oauthBase = () => (process.env.OAUTH_BASE_URL || cfg.BASE_URL).replace(/\/$/, '');
const sessionUser = (u) => ({
  id: u.id, username: u.username, display_name: u.display_name || null,
  isAdmin: !!u.is_admin, isArranger: !!u.is_arranger, avatar: u.avatar,
  bio: u.bio, socials: u.socials, email: u.email, emailVerified: !!u.email_verified
});

// Новая сессия при входе (защита от session fixation)
function loginSession(req, user, cb) {
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    req.session.save(cb);
  });
}

async function sendVerification(user) {
  if (!user.email || user.email_verified) return { ok: false, reason: 'n/a' };
  const token = store.createToken(user.id, 'verify', 48 * 3600 * 1000);
  const link = `${cfg.BASE_URL}/api/auth/verify?token=${token}`;
  const r = await mail.send({
    to: user.email, subject: `${cfg.SITE_NAME}: подтвердите email`,
    text: `Здравствуйте, ${user.username}!\n\nПодтвердите адрес электронной почты по ссылке (действует 48 часов):\n${link}\n\nЕсли вы не регистрировались — просто проигнорируйте письмо.`
  });
  if (!r.ok && r.reason === 'smtp_not_configured') console.log('[mail] SMTP не настроен. Ссылка подтверждения для', user.username + ':', link);
  return r;
}

router.post('/register', registerLimiter, (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!username || !email || !password) return res.status(400).json({ error: 'Все поля обязательны' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Логин: 2–24 символа (буквы, цифры, . _ -)' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Некорректный email' });
  if (password.length < MIN_PASS) return res.status(400).json({ error: `Пароль минимум ${MIN_PASS} символов` });
  if (password.length > 200) return res.status(400).json({ error: 'Пароль слишком длинный' });
  try {
    const user = store.createUser({ username, email, password });
    loginSession(req, user, (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка сессии' });
      sendVerification(user).catch(() => {});
      res.json({ ok: true, user: sessionUser(user) });
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  const user = store.findUserByLogin(String(username).trim());
  const ok = bcrypt.compareSync(String(password), (user && user.password_hash) || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
  if (user.is_banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  loginSession(req, user, (err) => {
    if (err) return res.status(500).json({ error: 'Ошибка сессии' });
    res.json({ ok: true, user: sessionUser(user) });
  });
});

router.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

router.get('/me', (req, res) => res.json({ user: req.user ? sessionUser(req.user) : null }));

// ----- подтверждение email -----
router.get('/verify', (req, res) => {
  const uid = store.consumeToken(req.query.token, 'verify');
  if (!uid) return res.redirect('/?verify=fail');
  store.markEmailVerified(uid);
  res.redirect('/?verify=ok');
});
router.post('/resend-verification', requireAuth, mailLimiter, async (req, res) => {
  if (!req.user.email) return res.status(400).json({ error: 'У аккаунта нет email' });
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  const r = await sendVerification(req.user);
  res.json({ ok: true, sent: r.ok });
});

// ----- сброс пароля -----
router.post('/forgot', mailLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'Если такой email зарегистрирован, мы отправили на него ссылку для сброса пароля.' };
  if (!EMAIL_RE.test(email)) return res.json(generic);
  const user = store.findUserByEmail(email);
  if (user && !user.is_banned) {
    const token = store.createToken(user.id, 'reset', 3600 * 1000);
    const link = `${cfg.BASE_URL}/reset?token=${token}`;
    const r = await mail.send({
      to: user.email, subject: `${cfg.SITE_NAME}: сброс пароля`,
      text: `Здравствуйте, ${user.username}!\n\nЧтобы задать новый пароль, перейдите по ссылке (действует 1 час):\n${link}\n\nЕсли вы не запрашивали сброс — проигнорируйте письмо, пароль не изменится.`
    });
    if (!r.ok && r.reason === 'smtp_not_configured') console.log('[mail] SMTP не настроен. Ссылка сброса для', user.username + ':', link);
  }
  res.json(generic);
});
router.post('/reset', loginLimiter, (req, res) => {
  const password = String((req.body || {}).password || '');
  if (password.length < MIN_PASS || password.length > 200) return res.status(400).json({ error: `Пароль минимум ${MIN_PASS} символов` });
  const uid = store.consumeToken((req.body || {}).token, 'reset');
  if (!uid) return res.status(400).json({ error: 'Ссылка недействительна или устарела' });
  store.setPassword(uid, password);
  store.markEmailVerified(uid); // владение почтой подтверждено самим фактом сброса
  res.json({ ok: true });
});

// ----- OAuth (с защитой state) -----
router.get('/oauth-status', (_req, res) => {
  res.json({
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    yandex: !!(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET),
    smtp: mail.isConfigured()
  });
});

function oauthErr(res, provider, detail) {
  console.error('[oauth]', provider, detail);
  res.redirect('/?auth_error=' + encodeURIComponent(provider) + '&msg=' + encodeURIComponent(String(detail).slice(0, 120)));
}
function newState(req) {
  const s = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = s;
  return s;
}
function checkState(req) {
  const ok = req.session.oauthState && req.query.state && String(req.query.state) === req.session.oauthState;
  delete req.session.oauthState;
  return !!ok;
}
function finishOAuth(req, res, { provider, providerId, username, email, emailVerified, avatar }) {
  try {
    if (!providerId) return oauthErr(res, provider, 'no_id');
    let user = store.findUserByOAuth(provider, providerId);
    // Привязка к существующему аккаунту по email — только если провайдер подтвердил этот email
    if (!user && email && emailVerified) {
      user = store.findUserByEmail(email);
      if (user) store.linkOAuth(user.id, provider, providerId);
    }
    if (!user) {
      const safeEmail = email && !store.findUserByEmail(email) ? email : null;
      user = store.createOAuthUser({ provider, providerId, username, email: safeEmail, avatar, emailVerified: !!(safeEmail && emailVerified) });
    } else if (avatar && !user.avatar) {
      store.updateUser(user.id, { avatar });
    }
    if (user.is_banned) return oauthErr(res, provider, 'banned');
    loginSession(req, user, (err) => {
      if (err) return oauthErr(res, provider, 'session');
      res.redirect('/');
    });
  } catch (e) { oauthErr(res, provider, e.message); }
}

router.get('/google', (req, res) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) return res.status(503).send('Google OAuth не настроен');
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(id)
    + '&redirect_uri=' + encodeURIComponent(oauthBase() + '/api/auth/google/callback')
    + '&response_type=code&scope=' + encodeURIComponent('openid email profile')
    + '&access_type=online&prompt=select_account&state=' + newState(req));
});
router.get('/google/callback', async (req, res) => {
  try {
    if (req.query.error) return oauthErr(res, 'google', req.query.error);
    if (!checkState(req)) return oauthErr(res, 'google', 'bad_state');
    if (!req.query.code) return oauthErr(res, 'google', 'no_code');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: oauthBase() + '/api/auth/google/callback', grant_type: 'authorization_code'
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) return oauthErr(res, 'google', token.error_description || token.error || 'token_fail');
    const profile = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } })).json();
    if (!profile.id) return oauthErr(res, 'google', 'no_profile');
    finishOAuth(req, res, {
      provider: 'google', providerId: profile.id,
      username: (profile.name || profile.email || 'google').split('@')[0].replace(/\s+/g, '_'),
      email: profile.email ? String(profile.email).toLowerCase() : null, emailVerified: !!profile.verified_email, avatar: profile.picture || null
    });
  } catch (e) { oauthErr(res, 'google', e.message); }
});

router.get('/yandex', (req, res) => {
  const id = process.env.YANDEX_CLIENT_ID;
  if (!id) return res.status(503).send('Yandex OAuth не настроен');
  res.redirect('https://oauth.yandex.ru/authorize?response_type=code'
    + '&client_id=' + encodeURIComponent(id)
    + '&redirect_uri=' + encodeURIComponent(oauthBase() + '/api/auth/yandex/callback')
    + '&state=' + newState(req));
});
router.get('/yandex/callback', async (req, res) => {
  try {
    if (req.query.error) return oauthErr(res, 'yandex', req.query.error);
    if (!checkState(req)) return oauthErr(res, 'yandex', 'bad_state');
    if (!req.query.code) return oauthErr(res, 'yandex', 'no_code');
    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(req.query.code),
        client_id: process.env.YANDEX_CLIENT_ID, client_secret: process.env.YANDEX_CLIENT_SECRET
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) return oauthErr(res, 'yandex', token.error_description || token.error || 'token_fail');
    const profile = await (await fetch('https://login.yandex.ru/info?format=json', { headers: { Authorization: 'OAuth ' + token.access_token } })).json();
    if (!profile.id) return oauthErr(res, 'yandex', 'no_profile');
    const email = profile.default_email || (profile.emails && profile.emails[0]) || null;
    finishOAuth(req, res, {
      provider: 'yandex', providerId: String(profile.id), username: profile.login || profile.display_name || 'yandex',
      email: email ? String(email).toLowerCase() : null, emailVerified: !!email, // Яндекс отдаёт только подтверждённые адреса
      avatar: profile.default_avatar_id ? 'https://avatars.yandex.net/get-yapic/' + profile.default_avatar_id + '/islands-200' : null
    });
  } catch (e) { oauthErr(res, 'yandex', e.message); }
});

module.exports = router;
