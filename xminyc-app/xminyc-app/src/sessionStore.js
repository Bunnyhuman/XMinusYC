// Хранилище сессий в SQLite: сессии переживают перезапуск и не копятся в памяти
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db, ttlMs = 30 * 24 * 3600 * 1000) {
    super();
    this.db = db; this.ttl = ttlMs;
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
    this._get = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this._set = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires');
    this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._clean = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    setInterval(() => { try { this._clean.run(Date.now()); } catch (_) {} }, 3600 * 1000).unref();
  }
  get(sid, cb) {
    try { const r = this._get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl;
      this._set.run(sid, JSON.stringify(sess), exp); cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this._del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
module.exports = SqliteStore;
