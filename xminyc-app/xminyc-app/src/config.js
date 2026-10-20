const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(ROOT, 'storage');
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = path.join(STORAGE_DIR, 'audio');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
for (const d of [DATA_DIR, STORAGE_DIR, AUDIO_DIR, TMP_DIR, BACKUP_DIR,
  path.join(PUBLIC_DIR, 'covers'),
  path.join(PUBLIC_DIR, 'avatars'),
  path.join(PUBLIC_DIR, 'artists')]) {
  fs.mkdirSync(d, { recursive: true });
}

// Секрет сессий: из .env, иначе генерируется один раз и хранится в data/
function persistedSecret(name) {
  const file = path.join(DATA_DIR, '.' + name);
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
  const v = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const bool = (v, d = false) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v));

module.exports = {
  ROOT, DATA_DIR, STORAGE_DIR, PUBLIC_DIR, AUDIO_DIR, TMP_DIR, BACKUP_DIR,
  PORT, BASE_URL,
  IS_PROD: process.env.NODE_ENV === 'production',
  SECURE_COOKIE: BASE_URL.startsWith('https://'),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  SESSION_SECRET: process.env.SESSION_SECRET || persistedSecret('session_secret'),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  REQUIRE_VERIFIED_EMAIL: bool(process.env.REQUIRE_VERIFIED_EMAIL, false),
  SITE_NAME: process.env.SITE_NAME || 'XMinusYC',
  REPORT_EMAIL: process.env.REPORT_EMAIL || '',
  BACKUP_KEEP: Number(process.env.BACKUP_KEEP) || 7,
  SMTP: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
  }
};
