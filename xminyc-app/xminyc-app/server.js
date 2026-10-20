const express = require('express');
const session = require('express-session');
const path = require('path');
const cfg = require('./src/config');
const store = require('./src/db/store');

// миграция со старого db.json + безопасный админ
require('./src/db/migrate').run().forEach(l => console.log('[migrate]', l));
store.ensureAdmin().forEach(l => console.warn('\n[admin] ' + l + '\n'));

const SqliteStore = require('./src/sessionStore');
const { attachUser } = require('./src/middleware/auth');
const sec = require('./src/middleware/security');
const seo = require('./src/seo');

const app = express();
app.disable('x-powered-by');
if (cfg.TRUST_PROXY) app.set('trust proxy', 1);

app.use(sec.helmetMw);
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  name: 'xminyc.sid',
  secret: cfg.SESSION_SECRET,
  store: new SqliteStore(store.db),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: cfg.SECURE_COOKIE }
}));
app.use(attachUser);

app.use('/api', sec.sameOrigin, sec.apiLimiter);
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/tracks', require('./src/routes/tracks'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/collections', require('./src/routes/collections'));
app.use('/api/artists', require('./src/routes/artists'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/arrangers', require('./src/routes/arrangers'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

app.use(require('./src/routes/media')); // /uploads/:file — аудио из приватного хранилища

app.get('/sitemap.xml', (_req, res) => res.type('application/xml').send(seo.sitemap()));
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(seo.robots()));

app.use(express.static(cfg.PUBLIC_DIR, {
  index: false,
  setHeaders(res, file) {
    if (/[\\/](vendor|fonts|icons|flags)[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (/\.(js|css|html|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// SPA: все остальные GET отдают index.html с мета-тегами под конкретную страницу
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).end();
  res.type('html').send(seo.render(req.path, req.user));
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api')) return res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Внутренняя ошибка сервера' });
  res.status(500).send('Внутренняя ошибка сервера');
});

app.listen(cfg.PORT, () => {
  console.log(`\n🎹  ${cfg.SITE_NAME} → ${cfg.BASE_URL}`);
  console.log(`   OAuth Google: ${process.env.GOOGLE_CLIENT_ID ? 'ON' : 'OFF'} | Yandex: ${process.env.YANDEX_CLIENT_ID ? 'ON' : 'OFF'}`);
  console.log(`   SMTP: ${require('./src/mail').isConfigured() ? 'ON' : 'OFF (письма не отправляются, ссылки пишутся в консоль)'}\n`);
  require('./src/backup').schedule();
});
