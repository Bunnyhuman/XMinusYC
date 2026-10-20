const store = require('../db/store');

// Подгружает пользователя из БД на каждый запрос (роль/бан всегда актуальны)
function attachUser(req, _res, next) {
  req.user = null;
  const id = req.session && req.session.userId;
  if (id) {
    const u = store.findUserById(id);
    if (!u || u.is_banned) {
      req.session.destroy(() => next());
      return;
    }
    req.user = u;
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только админ' });
  next();
}
module.exports = { attachUser, requireAuth, requireAdmin };
