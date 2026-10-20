const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');

const helmetMw = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'blob:'],
      'font-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'manifest-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: cfg.SECURE_COOKIE
});

// CSRF: изменяющие запросы должны приходить с нашего же origin
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const src = origin || req.get('referer');
  if (!src) return next(); // не-браузерные клиенты (curl) — у них нет куки жертвы
  try {
    if (new URL(src).host !== req.get('host')) return res.status(403).json({ error: 'Запрос с чужого origin отклонён' });
  } catch (_) { return res.status(403).json({ error: 'Некорректный origin' }); }
  next();
}

const mk = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: message || 'Слишком много запросов, попробуйте позже' }
});
module.exports = {
  helmetMw, sameOrigin,
  apiLimiter: mk(60 * 1000, 300),
  loginLimiter: mk(15 * 60 * 1000, 20, 'Слишком много попыток входа. Подождите 15 минут.'),
  registerLimiter: mk(60 * 60 * 1000, 10, 'Слишком много регистраций с этого адреса'),
  mailLimiter: mk(60 * 60 * 1000, 5, 'Слишком много запросов писем. Попробуйте через час.'),
  reportLimiter: mk(60 * 60 * 1000, 10, 'Слишком много жалоб с этого адреса'),
  uploadLimiter: mk(60 * 60 * 1000, 40, 'Слишком много загрузок за час')
};
