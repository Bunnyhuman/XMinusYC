// Одноразовая миграция data/db.json -> SQLite + перенос аудио из public/uploads в storage/audio
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const store = require('./store');

function run() {
  const jsonFile = path.join(cfg.DATA_DIR, 'db.json');
  const log = [];
  const db = store.db;
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;

  if (fs.existsSync(jsonFile) && !hasUsers) {
    const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const tx = db.transaction(() => {
      const insU = db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password_hash, is_admin, is_arranger, email_verified, avatar, display_name, bio, socials,
        google_id, yandex_id, vk_id, arranger_since, arranger_by, created_at) VALUES (@id,@username,@email,@password_hash,@is_admin,@is_arranger,@email_verified,@avatar,@display_name,@bio,@socials,@google_id,@yandex_id,@vk_id,@arranger_since,@arranger_by,@created_at)`);
      const seen = new Set();
      for (const u of j.users || []) {
        let email = u.email || null;
        if (email && /@oauth\.local$/i.test(email)) email = null;
        if (email && seen.has(email.toLowerCase())) email = null;
        if (email) seen.add(email.toLowerCase());
        insU.run({
          id: u.id, username: u.username, email, password_hash: u.password_hash || null,
          is_admin: u.is_admin ? 1 : 0, is_arranger: u.is_arranger ? 1 : 0,
          email_verified: (u.google_id || u.yandex_id || u.vk_id) ? 1 : 0,
          avatar: u.avatar || null, display_name: u.display_name || null, bio: u.bio || '',
          socials: JSON.stringify(u.socials || {}), google_id: u.google_id || null, yandex_id: u.yandex_id || null, vk_id: u.vk_id || null,
          arranger_since: u.arranger_since || null, arranger_by: u.arranger_by || null, created_at: u.created_at || new Date().toISOString()
        });
      }
      const { searchText } = require('../util/text');
      const insT = db.prepare(`INSERT OR IGNORE INTO tracks (id, title, artist, duration, type, type_extra, key, plays, downloads, likes_count, cover, file_path, file_size, bitrate,
        lyrics, lyrics_romaji, lyrics_cyrillic, lyrics_translation, tag_lang, tag_genre, tag_theme, note, uploaded_by, status, search_text, created_at)
        VALUES (@id,@title,@artist,@duration,@type,@type_extra,@key,@plays,@downloads,@likes_count,@cover,@file_path,@file_size,@bitrate,@lyrics,@lyrics_romaji,@lyrics_cyrillic,@lyrics_translation,@tag_lang,@tag_genre,@tag_theme,@note,@uploaded_by,@status,@search_text,@created_at)`);
      const userIds = new Set((j.users || []).map(u => u.id));
      for (const t of j.tracks || []) {
        insT.run({
          id: t.id, title: t.title, artist: t.artist, duration: t.duration || '0:00', type: t.type || 'ориг', type_extra: t.type_extra || null, key: t.key || 'C',
          plays: t.plays || 0, downloads: t.downloads || 0, likes_count: t.likes_count || 0, cover: t.cover || null, file_path: t.file_path || null,
          file_size: t.file_size || null, bitrate: t.bitrate || null, lyrics: t.lyrics || null, lyrics_romaji: t.lyrics_romaji || null,
          lyrics_cyrillic: t.lyrics_cyrillic || null, lyrics_translation: t.lyrics_translation || null, tag_lang: t.tag_lang || null,
          tag_genre: t.tag_genre || null, tag_theme: t.tag_theme || null, note: t.note || null,
          uploaded_by: userIds.has(t.uploaded_by) ? t.uploaded_by : null, status: t.status || 'approved',
          search_text: searchText(t.title, t.artist), created_at: t.created_at || new Date().toISOString()
        });
        store._syncTrackArtists(t.id, t.artist);
      }
      for (const a of j.artists || []) {
        const row = store.getOrCreateArtist(a.name);
        db.prepare('UPDATE artists SET photo = ?, bio = ?, photo_by = ?, bio_by = ? WHERE id = ?')
          .run(a.photo || null, a.bio || '', a.photo_by != null ? String(a.photo_by) : null, a.bio_by != null ? String(a.bio_by) : null, row.id);
      }
      const trackIds = new Set((j.tracks || []).map(t => t.id));
      for (const l of j.likes || []) if (userIds.has(l.user_id) && trackIds.has(l.track_id)) db.prepare('INSERT OR IGNORE INTO likes (user_id, track_id) VALUES (?, ?)').run(l.user_id, l.track_id);
      for (const c of j.collections || []) if (userIds.has(c.user_id)) db.prepare('INSERT OR IGNORE INTO collections (id, user_id, name, description, created_at) VALUES (?,?,?,?,?)').run(c.id, c.user_id, c.name, c.description || '', c.created_at || new Date().toISOString());
      const colIds = new Set((j.collections || []).map(c => c.id));
      for (const ct of j.collection_tracks || []) if (colIds.has(ct.collection_id) && trackIds.has(ct.track_id)) db.prepare('INSERT OR IGNORE INTO collection_tracks (collection_id, track_id) VALUES (?,?)').run(ct.collection_id, ct.track_id);
      for (const a of j.arranger_applications || []) if (userIds.has(a.user_id)) db.prepare(`INSERT OR IGNORE INTO arranger_applications (id, user_id, username, description, links, status, reject_reason, reviewed_by, created_at, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(a.id, a.user_id, a.username, a.description, a.links, a.status, a.reject_reason, a.reviewed_by, a.created_at, a.reviewed_at);
    });
    tx();
    fs.renameSync(jsonFile, jsonFile + '.migrated');
    log.push(`Данные перенесены из db.json в SQLite (${(j.users || []).length} польз., ${(j.tracks || []).length} треков). Старый файл: db.json.migrated`);
  }

  // Старые жалобы data/reports.json -> таблица reports
  const repFile = path.join(cfg.DATA_DIR, 'reports.json');
  if (fs.existsSync(repFile)) {
    try {
      const list = JSON.parse(fs.readFileSync(repFile, 'utf8'));
      for (const r of Array.isArray(list) ? list : []) {
        const wrong = Array.isArray(r.wrong) ? r.wrong : [];
        store.createReport({
          type: 'artist', artist: r.artist, message: r.message,
          wrong: { photo: wrong.some(x => /фото/i.test(x)), bio: wrong.some(x => /опис/i.test(x)) }
        });
      }
      fs.renameSync(repFile, repFile + '.migrated');
      log.push(`Жалобы перенесены в БД: ${Array.isArray(list) ? list.length : 0}`);
    } catch (e) { log.push('reports.json не перенесён: ' + e.message); }
  }

  // Перенос аудио из public/uploads (раньше было публичным) в storage/audio
  const oldDir = path.join(cfg.PUBLIC_DIR, 'uploads');
  if (fs.existsSync(oldDir)) {
    let moved = 0;
    for (const f of fs.readdirSync(oldDir)) {
      const src = path.join(oldDir, f);
      if (!fs.statSync(src).isFile() || !/\.(mp3|wav|ogg|m4a|flac)$/i.test(f)) continue;
      const dst = path.join(cfg.AUDIO_DIR, f);
      if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved++; }
    }
    if (moved) log.push(`Аудиофайлы перенесены в storage/audio: ${moved}`);
    try { if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir); } catch (_) {}
  }
  return log;
}
module.exports = { run };
