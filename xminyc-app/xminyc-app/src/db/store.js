const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { searchText, searchVariants } = require('../util/text');

const DB_FILE = path.join(cfg.DATA_DIR, 'xminyc.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT COLLATE NOCASE,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_arranger INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT, display_name TEXT, bio TEXT DEFAULT '',
  socials TEXT DEFAULT '{}',
  google_id TEXT, yandex_id TEXT, vk_id TEXT,
  arranger_since TEXT, arranger_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '';
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, artist TEXT NOT NULL,
  duration TEXT DEFAULT '0:00', type TEXT DEFAULT 'ориг', type_extra TEXT,
  key TEXT DEFAULT 'C',
  plays INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, likes_count INTEGER NOT NULL DEFAULT 0,
  cover TEXT, file_path TEXT, file_size INTEGER, bitrate TEXT DEFAULT '320 kbps',
  lyrics TEXT, lyrics_romaji TEXT, lyrics_cyrillic TEXT, lyrics_translation TEXT, lyrics_lrc TEXT,
  tag_lang TEXT, tag_genre TEXT, tag_theme TEXT, note TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tracks_user ON tracks(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_tracks_file ON tracks(file_path);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, track_id)
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_tracks (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, track_id)
);
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  photo TEXT, bio TEXT DEFAULT '', photo_by TEXT, bio_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS track_artists (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX IF NOT EXISTS idx_ta_artist ON track_artists(artist_id);
CREATE TABLE IF NOT EXISTS arranger_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT, description TEXT, links TEXT,
  status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT,
  reviewed_by INTEGER, created_at TEXT NOT NULL, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- artist | copyright
  artist TEXT, track_id INTEGER, track_url TEXT,
  wrong TEXT, message TEXT,
  from_user INTEGER, contact_name TEXT, contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by INTEGER, handled_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`);
// мягкие миграции для колонок, добавленных позже
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('tracks').includes('lyrics_lrc')) db.exec('ALTER TABLE tracks ADD COLUMN lyrics_lrc TEXT');

const now = () => new Date().toISOString();
const EMPTY_SOCIALS = () => ({ telegram: '', vk: '', youtube: '', instagram: '' });

function rowToUser(r) {
  if (!r) return undefined;
  let socials; try { socials = JSON.parse(r.socials || '{}'); } catch (_) { socials = {}; }
  return { ...r, is_admin: !!r.is_admin, is_arranger: !!r.is_arranger, is_banned: !!r.is_banned, email_verified: !!r.email_verified, socials: { ...EMPTY_SOCIALS(), ...socials } };
}
function rowToTrack(r) {
  if (!r) return undefined;
  const { search_text, ...t } = r;
  return t;
}
const likeEsc = (s) => String(s).replace(/[\\%_]/g, m => '\\' + m);

const store = {
  db,
  DB_FILE,
  save() {}, // совместимость: SQLite сохраняет сам
  reload() { return true; },

  // ---------- Users ----------
  findUserByLogin(login) {
    return rowToUser(db.prepare('SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1').get(login, login));
  },
  findUserById(id) { return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id))); },
  findUserByUsername(username) { return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(String(username))); },
  createUser({ username, email, password, emailVerified = false }) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(username, email || '')) {
      throw new Error('Имя или email уже заняты');
    }
    const info = db.prepare(`INSERT INTO users (username, email, password_hash, email_verified, socials, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(username, email || null, bcrypt.hashSync(password, 10), emailVerified ? 1 : 0, JSON.stringify(EMPTY_SOCIALS()), now());
    return this.findUserById(info.lastInsertRowid);
  },
  updateUser(id, fields) {
    const u = this.findUserById(id);
    if (!u) return null;
    const sets = []; const vals = [];
    for (const k of ['bio', 'avatar', 'display_name']) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    if (fields.socials !== undefined) { sets.push('socials = ?'); vals.push(JSON.stringify(fields.socials || {})); }
    if (fields.email !== undefined && fields.email !== u.email) {
      const dup = db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(fields.email, u.id);
      if (dup) throw new Error('Email уже используется');
      sets.push('email = ?', 'email_verified = 0'); vals.push(fields.email || null);
    }
    if (fields.password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(fields.password, 10)); }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);
    return this.findUserById(u.id);
  },
  setPassword(id, password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), Number(id));
  },
  markEmailVerified(id) { db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(Number(id)); },
  setBanned(id, banned) {
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, Number(id));
    return this.findUserById(id);
  },
  findUserByOAuth(provider, providerId) {
    if (!['google', 'yandex', 'vk'].includes(provider)) return undefined;
    return rowToUser(db.prepare(`SELECT * FROM users WHERE ${provider}_id = ?`).get(String(providerId)));
  },
  findUserByEmail(email) {
    if (!email) return null;
    return rowToUser(db.prepare('SELECT * FROM users WHERE email = ?').get(String(email))) || null;
  },
  createOAuthUser({ provider, providerId, username, email, avatar, emailVerified = false }) {
    if (!['google', 'yandex', 'vk'].includes(provider)) throw new Error('bad provider');
    const base = (username || email || provider + '_user').replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]/g, '').slice(0, 24) || (provider + 'user');
    let uname = base, i = 1;
    while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) { uname = (base.slice(0, 20) + i).slice(0, 24); i++; }
    const info = db.prepare(`INSERT INTO users (username, email, password_hash, avatar, socials, ${provider}_id, email_verified, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(uname, email || null, avatar || null, JSON.stringify(EMPTY_SOCIALS()), String(providerId), emailVerified ? 1 : 0, now());
    return this.findUserById(info.lastInsertRowid);
  },
  linkOAuth(userId, provider, providerId) {
    if (!['google', 'yandex', 'vk'].includes(provider)) return null;
    db.prepare(`UPDATE users SET ${provider}_id = ? WHERE id = ?`).run(String(providerId), Number(userId));
    return this.findUserById(userId);
  },
  publicUser(u) {
    if (!u) return null;
    const s = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(plays),0) p FROM tracks WHERE uploaded_by = ?').get(u.id);
    return {
      id: u.id, username: u.username, display_name: u.display_name || null, avatar: u.avatar,
      bio: u.bio || '', socials: u.socials || {}, created_at: u.created_at,
      tracks_count: s.c, total_plays: s.p, is_admin: !!u.is_admin, is_arranger: !!u.is_arranger
    };
  },
  listUsers({ q = '', limit = 50, offset = 0 } = {}) {
    const like = '%' + likeEsc(q) + '%';
    const where = q ? "WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'" : '';
    const args = q ? [like, like] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM users ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM tracks t WHERE t.uploaded_by = u.id) tracks_count
      FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, users: rows.map(r => { const { password_hash, ...u } = rowToUser(r); return u; }) };
  },
  ensureAdmin() {
    const log = [];
    const adminRow = db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
    const newPass = () => cfg.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    if (!adminRow) {
      const pass = newPass();
      db.prepare(`INSERT INTO users (username, email, password_hash, is_admin, email_verified, bio, socials, created_at)
        VALUES (?, ?, ?, 1, 1, 'Администратор сайта', ?, ?)`).run(cfg.ADMIN_USERNAME, null, bcrypt.hashSync(pass, 10), JSON.stringify(EMPTY_SOCIALS()), now());
      log.push(`Создан администратор: ${cfg.ADMIN_USERNAME} / ${pass}  (запишите пароль — он больше не будет показан)`);
    } else if (!adminRow.password_hash && cfg.ADMIN_PASSWORD) {
      this.setPassword(adminRow.id, cfg.ADMIN_PASSWORD);
      log.push(`Администратору «${adminRow.username}» задан пароль из ADMIN_PASSWORD`);
    } else if (adminRow.password_hash && bcrypt.compareSync('admin123', adminRow.password_hash)) {
      // старый небезопасный пароль по умолчанию — заменяем
      const pass = newPass();
      this.setPassword(adminRow.id, pass);
      log.push(`Пароль администратора «${adminRow.username}» был небезопасным (admin123) и заменён: ${pass}  (запишите — больше не будет показан)`);
    }
    return log;
  },

  // ---------- Tokens (подтверждение email / сброс пароля) ----------
  createToken(userId, kind, ttlMs) {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(Number(userId), kind);
    db.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)').run(hash, Number(userId), kind, Date.now() + ttlMs);
    return raw;
  },
  consumeToken(raw, kind) {
    const hash = crypto.createHash('sha256').update(String(raw || '')).digest('hex');
    const r = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(hash, kind);
    if (!r) return null;
    db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash);
    if (r.expires_at < Date.now()) return null;
    return r.user_id;
  },

  // ---------- Tracks ----------
  findTrack(id) { return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(Number(id))); },
  findTrackByFile(filePath) { return rowToTrack(db.prepare('SELECT * FROM tracks WHERE file_path = ?').get(filePath)); },
  _visibility({ viewerId, isAdmin, mode, userId }) {
    if (mode === 'moderation') return { sql: "t.status = 'pending'", args: [] };
    if (mode === 'artist') return { sql: "t.status = 'approved'", args: [] };
    if (mode === 'profile') {
      if (isAdmin || (viewerId && Number(userId) === Number(viewerId))) return { sql: '1=1', args: [] };
      return { sql: "t.status IN ('pending','approved')", args: [] };
    }
    if (viewerId) return { sql: "(t.status IN ('pending','approved') OR (t.status = 'rejected' AND t.uploaded_by = ?))", args: [Number(viewerId)] };
    return { sql: "t.status IN ('pending','approved')", args: [] };
  },
  listTracks({ q = '', sort = 'latest', limit = 50, offset = 0, userId = null, days = null, mode = 'public', viewerId = null, isAdmin = false,
    key = '', genre = '', lang = '', type = '' } = {}) {
    const where = []; const args = [];
    if (userId) { where.push('t.uploaded_by = ?'); args.push(Number(userId)); }
    const vis = this._visibility({ viewerId, isAdmin, mode, userId });
    where.push(vis.sql); args.push(...vis.args);
    if (q) {
      const vs = searchVariants(q);
      if (vs.length) {
        where.push('(' + vs.map(() => "t.search_text LIKE ? ESCAPE '\\'").join(' OR ') + ')');
        args.push(...vs.map(v => '%' + likeEsc(v) + '%'));
      }
    }
    if (days) { where.push('t.created_at >= ?'); args.push(new Date(Date.now() - Number(days) * 86400000).toISOString()); }
    if (key) { where.push('t.key = ?'); args.push(String(key)); }
    if (genre) { where.push("t.tag_genre LIKE ? ESCAPE '\\'"); args.push('%' + likeEsc(genre) + '%'); }
    if (lang) { where.push("t.tag_lang LIKE ? ESCAPE '\\'"); args.push('%' + likeEsc(lang) + '%'); }
    if (type) { where.push('t.type = ?'); args.push(String(type)); }
    const order = {
      top: '(t.likes_count + t.plays) DESC, t.id DESC', popular: '(t.likes_count + t.plays) DESC, t.id DESC',
      downloads: 't.downloads DESC, t.id DESC', title: 't.title COLLATE NOCASE ASC', artist: 't.artist COLLATE NOCASE ASC'
    }[sort] || 't.created_at DESC, t.id DESC';
    const W = 'WHERE ' + where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM tracks t ${W}`).get(...args).c;
    const rows = db.prepare(`SELECT t.* FROM tracks t ${W} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, Number(limit), Number(offset));
    return { tracks: rows.map(rowToTrack), total };
  },
  // значения для фильтров (только одобренные/видимые треки)
  filterOptions() {
    const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} v FROM tracks WHERE status IN ('pending','approved') AND ${col} IS NOT NULL AND ${col} != '' ORDER BY ${col} COLLATE NOCASE`).all().map(r => r.v);
    return { keys: distinct('key'), genres: distinct('tag_genre'), langs: distinct('tag_lang'), types: distinct('type') };
  },
  _syncTrackArtists(trackId, artistStr) {
    db.prepare('DELETE FROM track_artists WHERE track_id = ?').run(trackId);
    const names = [...new Set(String(artistStr || '').split(',').map(s => s.trim()).filter(Boolean))];
    for (const n of names) {
      const a = this.getOrCreateArtist(n);
      db.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id) VALUES (?, ?)').run(trackId, a.id);
    }
  },
  createTrack(data) {
    const tx = db.transaction(() => {
      const info = db.prepare(`INSERT INTO tracks (title, artist, duration, type, type_extra, key, cover, file_path, file_size, bitrate,
        lyrics, lyrics_romaji, lyrics_cyrillic, lyrics_translation, lyrics_lrc, tag_lang, tag_genre, tag_theme, note, uploaded_by, status, search_text, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        data.title, data.artist, data.duration || '0:00', data.type || 'ориг', data.type_extra || null, data.key || 'C',
        data.cover || null, data.file_path || null, data.file_size || null, data.bitrate || '320 kbps',
        data.lyrics || null, data.lyrics_romaji || null, data.lyrics_cyrillic || null, data.lyrics_translation || null, data.lyrics_lrc || null,
        data.tag_lang || null, data.tag_genre || null, data.tag_theme || null, data.note || null,
        data.uploaded_by || null, data.status || 'pending', searchText(data.title, data.artist), now());
      this._syncTrackArtists(info.lastInsertRowid, data.artist);
      return info.lastInsertRowid;
    });
    return this.findTrack(tx());
  },
  updateTrack(id, fields, userId, isAdmin) {
    const t = this.findTrack(id);
    if (!t) return null;
    if (!isAdmin && t.uploaded_by !== userId) return false;
    const allowed = ['title', 'artist', 'duration', 'type', 'type_extra', 'key', 'lyrics', 'lyrics_romaji', 'lyrics_cyrillic', 'lyrics_translation', 'lyrics_lrc', 'tag_lang', 'tag_genre', 'tag_theme', 'bitrate', 'note'];
    const merged = { ...t };
    const sets = []; const vals = [];
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); merged[k] = fields[k]; }
    if (!sets.length) return t;
    sets.push('search_text = ?'); vals.push(searchText(merged.title, merged.artist));
    db.transaction(() => {
      db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, t.id);
      if (fields.artist !== undefined) this._syncTrackArtists(t.id, merged.artist);
    })();
    return this.findTrack(t.id);
  },
  setTrackStatus(id, status) {
    if (!['pending', 'approved', 'rejected'].includes(status)) return false;
    const r = db.prepare('UPDATE tracks SET status = ? WHERE id = ?').run(status, Number(id));
    return r.changes ? this.findTrack(id) : null;
  },
  setTrackCover(id, coverPath, userId, isAdmin) {
    const t = this.findTrack(id);
    if (!t) return null;
    if (!isAdmin && t.uploaded_by !== Number(userId)) return false;
    db.prepare('UPDATE tracks SET cover = ? WHERE id = ?').run(coverPath, t.id);
    return this.findTrack(id);
  },
  incrementDownloads(id) {
    db.prepare('UPDATE tracks SET downloads = downloads + 1 WHERE id = ?').run(Number(id));
    return this.findTrack(id) || null;
  },
  incrementPlays(id) {
    db.prepare('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(Number(id));
    return this.findTrack(id);
  },
  deleteTrack(id) {
    const t = this.findTrack(id);
    if (!t) return null;
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id); // likes/collection_tracks/track_artists — каскадом
    return t;
  },

  // ---------- Likes ----------
  toggleLike(userId, trackId) {
    return db.transaction(() => {
      const t = this.findTrack(trackId);
      if (!t) return null;
      const ex = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(userId, t.id);
      if (ex) {
        db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(userId, t.id);
        db.prepare('UPDATE tracks SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').run(t.id);
      } else {
        db.prepare('INSERT INTO likes (user_id, track_id) VALUES (?, ?)').run(userId, t.id);
        db.prepare('UPDATE tracks SET likes_count = likes_count + 1 WHERE id = ?').run(t.id);
      }
      return { liked: !ex, likes_count: this.findTrack(t.id).likes_count };
    })();
  },
  isLiked(userId, trackId) { return !!db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(userId, trackId); },

  // ---------- Collections ----------
  listCollections(userId) { return db.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY id').all(Number(userId)); },
  findCollection(id) { return db.prepare('SELECT * FROM collections WHERE id = ?').get(Number(id)); },
  createCollection(userId, name, description = '') {
    const info = db.prepare('INSERT INTO collections (user_id, name, description, created_at) VALUES (?, ?, ?, ?)').run(userId, String(name).slice(0, 100), String(description).slice(0, 500), now());
    return this.findCollection(info.lastInsertRowid);
  },
  deleteCollection(id, userId) {
    const c = this.findCollection(id);
    if (!c || c.user_id !== userId) return false;
    db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
    return true;
  },
  addToCollection(collectionId, trackId, userId) {
    const c = this.findCollection(collectionId);
    if (!c || c.user_id !== userId) return false;
    if (!this.findTrack(trackId)) return false;
    db.prepare('INSERT OR IGNORE INTO collection_tracks (collection_id, track_id) VALUES (?, ?)').run(c.id, Number(trackId));
    return true;
  },
  removeFromCollection(collectionId, trackId, userId) {
    const c = this.findCollection(collectionId);
    if (!c || c.user_id !== userId) return false;
    db.prepare('DELETE FROM collection_tracks WHERE collection_id = ? AND track_id = ?').run(c.id, Number(trackId));
    return true;
  },
  getCollectionTracks(collectionId) {
    return db.prepare(`SELECT t.* FROM tracks t JOIN collection_tracks ct ON ct.track_id = t.id
      WHERE ct.collection_id = ? AND t.status != 'rejected' ORDER BY t.id`).all(Number(collectionId)).map(rowToTrack);
  },

  // ---------- Artists ----------
  findArtist(name) { return db.prepare('SELECT * FROM artists WHERE name = ?').get(String(name)); },
  getOrCreateArtist(name) {
    name = String(name).trim();
    let a = this.findArtist(name);
    if (a) return a;
    const info = db.prepare('INSERT INTO artists (name, created_at) VALUES (?, ?)').run(name, now());
    return db.prepare('SELECT * FROM artists WHERE id = ?').get(info.lastInsertRowid);
  },
  updateArtist(name, fields, { isAdmin = false, userId = null } = {}) {
    const a = this.getOrCreateArtist(name);
    const sets = []; const vals = [];
    if (fields.photo !== undefined && (isAdmin || !a.photo)) { sets.push('photo = ?', 'photo_by = ?'); vals.push(fields.photo, String(userId || (isAdmin ? 'admin' : 'user'))); }
    if (fields.bio !== undefined && (isAdmin || !a.bio)) { sets.push('bio = ?', 'bio_by = ?'); vals.push(String(fields.bio).slice(0, 500), String(userId || (isAdmin ? 'admin' : 'user'))); }
    if (sets.length) db.prepare(`UPDATE artists SET ${sets.join(', ')} WHERE id = ?`).run(...vals, a.id);
    return db.prepare('SELECT * FROM artists WHERE id = ?').get(a.id);
  },
  listTracksByArtist(artistName, sort = 'latest') {
    const a = this.findArtist(artistName);
    if (!a) return [];
    const order = sort === 'popular' ? 't.plays DESC, t.id DESC' : 't.created_at DESC, t.id DESC';
    return db.prepare(`SELECT t.* FROM tracks t JOIN track_artists ta ON ta.track_id = t.id
      WHERE ta.artist_id = ? AND t.status = 'approved' ORDER BY ${order}`).all(a.id).map(rowToTrack);
  },
  listArtistsByLetter(letter) {
    const rows = db.prepare(`SELECT a.name, COALESCE(SUM(CASE WHEN t.status = 'approved' THEN 1 ELSE 0 END), 0) tracks_count
      FROM artists a JOIN track_artists ta ON ta.artist_id = a.id JOIN tracks t ON t.id = ta.track_id GROUP BY a.id`).all();
    const L = String(letter || '').toLowerCase();
    const isHash = L === '#' || L === '0-9';
    return rows.filter(r => {
      const ch = r.name.charAt(0).toLowerCase();
      return isHash ? !/[a-zа-яё]/i.test(ch) : ch === L;
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  },

  // ---------- Arrangers ----------
  setArrangerRole(userId, isArranger, adminId) {
    db.prepare('UPDATE users SET is_arranger = ?, arranger_since = ?, arranger_by = ? WHERE id = ?')
      .run(isArranger ? 1 : 0, isArranger ? now() : null, isArranger ? (adminId || null) : null, Number(userId));
    return this.findUserById(userId) || null;
  },
  listArrangers({ sort = 'tracks', limit = 50, offset = 0 } = {}) {
    const order = sort === 'plays' ? 'total_plays DESC' : 'tracks_count DESC';
    const total = db.prepare('SELECT COUNT(*) c FROM users WHERE is_arranger = 1').get().c;
    const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM tracks t WHERE t.uploaded_by = u.id) tracks_count,
      (SELECT COALESCE(SUM(plays),0) FROM tracks t WHERE t.uploaded_by = u.id) total_plays
      FROM users u WHERE u.is_arranger = 1 ORDER BY ${order}, u.id LIMIT ? OFFSET ?`).all(limit, offset);
    return { arrangers: rows.map(r => ({ ...this.publicUser(rowToUser(r)), tracks_count: r.tracks_count, total_plays: r.total_plays })), total };
  },
  submitArrangerApplication({ userId, description, links }) {
    const user = this.findUserById(userId);
    if (!user) throw new Error('Пользователь не найден');
    if (user.is_arranger) throw new Error('Вы уже аранжировщик');
    if (db.prepare("SELECT 1 FROM arranger_applications WHERE user_id = ? AND status = 'pending'").get(userId)) throw new Error('Заявка уже на проверке');
    const info = db.prepare('INSERT INTO arranger_applications (user_id, username, description, links, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, user.username, String(description || '').slice(0, 2000), String(links || '').slice(0, 1000), now());
    return db.prepare('SELECT * FROM arranger_applications WHERE id = ?').get(info.lastInsertRowid);
  },
  listArrangerApplications(status) {
    return status
      ? db.prepare('SELECT * FROM arranger_applications WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM arranger_applications ORDER BY created_at DESC').all();
  },
  reviewArrangerApplication(id, { approve, reason, adminId }) {
    const app = db.prepare('SELECT * FROM arranger_applications WHERE id = ?').get(Number(id));
    if (!app) return null;
    if (app.status !== 'pending') return { error: 'Заявка уже рассмотрена' };
    db.transaction(() => {
      db.prepare('UPDATE arranger_applications SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', approve ? null : String(reason || '').slice(0, 500), adminId || null, now(), app.id);
      if (approve) this.setArrangerRole(app.user_id, true, adminId);
    })();
    return db.prepare('SELECT * FROM arranger_applications WHERE id = ?').get(app.id);
  },
  getUserArrangerApplication(userId) {
    return db.prepare('SELECT * FROM arranger_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(Number(userId)) || null;
  },

  // ---------- Reports ----------
  createReport(r) {
    const info = db.prepare(`INSERT INTO reports (type, artist, track_id, track_url, wrong, message, from_user, contact_name, contact_email, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(r.type, r.artist || null, r.track_id || null, r.track_url || null,
      r.wrong ? JSON.stringify(r.wrong) : null, String(r.message || '').slice(0, 3000), r.from_user || null,
      r.contact_name ? String(r.contact_name).slice(0, 200) : null, r.contact_email ? String(r.contact_email).slice(0, 200) : null, now());
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid);
  },
  listReports(status) {
    const rows = status
      ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 500').all(status)
      : db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 500').all();
    return rows.map(r => ({ ...r, wrong: r.wrong ? JSON.parse(r.wrong) : null }));
  },
  resolveReport(id, adminId, status = 'done') {
    const r = db.prepare('UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(status, adminId, now(), Number(id));
    return r.changes > 0;
  },

  // ---------- Stats / backup ----------
  getStats() {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const daily = (table) => db.prepare(`SELECT substr(created_at,1,10) d, COUNT(*) c FROM ${table} WHERE substr(created_at,1,10) >= ? GROUP BY d ORDER BY d`).all(since);
    return {
      users: one('SELECT COUNT(*) c FROM users').c,
      arrangers: one('SELECT COUNT(*) c FROM users WHERE is_arranger = 1').c,
      banned: one('SELECT COUNT(*) c FROM users WHERE is_banned = 1').c,
      tracks: db.prepare('SELECT status, COUNT(*) c FROM tracks GROUP BY status').all().reduce((o, r) => (o[r.status] = r.c, o), {}),
      plays: one('SELECT COALESCE(SUM(plays),0) c FROM tracks').c,
      downloads: one('SELECT COALESCE(SUM(downloads),0) c FROM tracks').c,
      likes: one('SELECT COUNT(*) c FROM likes').c,
      artists: one('SELECT COUNT(*) c FROM artists').c,
      reports_open: one("SELECT COUNT(*) c FROM reports WHERE status = 'open'").c,
      registrations: daily('users'),
      uploads: daily('tracks'),
      top_tracks: db.prepare("SELECT id, title, artist, plays, downloads, likes_count FROM tracks WHERE status='approved' ORDER BY plays DESC LIMIT 10").all()
    };
  },
  backupTo(file) { return db.backup(file); },
  sitemapData() {
    return {
      tracks: db.prepare("SELECT id, created_at FROM tracks WHERE status = 'approved' ORDER BY id DESC LIMIT 40000").all(),
      artists: db.prepare(`SELECT DISTINCT a.name FROM artists a JOIN track_artists ta ON ta.artist_id = a.id JOIN tracks t ON t.id = ta.track_id WHERE t.status = 'approved'`).all().map(r => r.name),
      users: db.prepare("SELECT username FROM users WHERE is_arranger = 1").all().map(r => r.username)
    };
  }
};

module.exports = store;
