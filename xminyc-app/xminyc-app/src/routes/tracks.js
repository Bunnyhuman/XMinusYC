const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('../db/store');
const cfg = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/security');
const U = require('../util/uploads');
const { makeDedupe } = require('../util/dedupe');

const router = express.Router();
const upload = U.multerFor({ audio: true, imageFields: ['cover'] });
const coverOnly = U.multerFor({ audio: false, imageFields: ['cover'] });
const playOnce = makeDedupe(30 * 60 * 1000);
const downloadOnce = makeDedupe(10 * 60 * 1000);

const str = (v, max) => (v === undefined || v === null) ? undefined : String(v).trim().slice(0, max);
function cleanFields(b) {
  const o = {
    title: str(b.title, 200), artist: str(b.artist, 300), duration: str(b.duration, 10), type: str(b.type, 40), type_extra: str(b.type_extra, 40),
    key: str(b.key, 12), bitrate: str(b.bitrate, 20),
    lyrics: str(b.lyrics, 20000), lyrics_romaji: str(b.lyrics_romaji, 20000), lyrics_cyrillic: str(b.lyrics_cyrillic, 20000),
    lyrics_translation: str(b.lyrics_translation, 20000), lyrics_lrc: str(b.lyrics_lrc, 40000),
    tag_lang: str(b.tag_lang, 60), tag_genre: str(b.tag_genre, 60), tag_theme: str(b.tag_theme, 60), note: str(b.note, 500)
  };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
const canSee = (track, user) => (track.status !== 'rejected') || (user && (user.is_admin || track.uploaded_by === user.id));

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const sort = String(req.query.sort || 'latest');
  const days = req.query.days ? Number(req.query.days) : null;
  const userId = req.query.user_id || null;
  const artist = req.query.artist || null;
  const viewerId = req.user ? req.user.id : null;
  const isAdmin = !!(req.user && req.user.is_admin);
  let mode = ['public', 'artist', 'profile', 'moderation'].includes(req.query.mode) ? req.query.mode : 'public';
  if (mode === 'moderation' && !isAdmin) return res.status(403).json({ error: 'Только админ' });
  if (userId) mode = 'profile';
  if (artist) {
    const list = store.listTracksByArtist(artist, sort === 'top' ? 'popular' : sort);
    return res.json({ tracks: list.slice(offset, offset + limit), total: list.length });
  }
  res.json(store.listTracks({
    q, sort, limit, offset, userId, days, mode, viewerId, isAdmin,
    key: String(req.query.key || '').slice(0, 12), genre: String(req.query.genre || '').slice(0, 60),
    lang: String(req.query.lang || '').slice(0, 60), type: String(req.query.type || '').slice(0, 40)
  }));
});

router.get('/filters', (_req, res) => res.json(store.filterOptions()));

router.get('/:id/download', (req, res) => {
  const track = store.findTrack(req.params.id);
  if (!track || !track.file_path || !canSee(track, req.user)) return res.status(404).json({ error: 'Файл не найден' });
  const full = path.join(cfg.AUDIO_DIR, path.basename(track.file_path));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл отсутствует' });
  const ext = path.extname(full) || '.mp3';
  const safeName = `${track.artist} - ${track.title} (minus)${ext}`.replace(/[<>:"/\\|?*\r\n]/g, '');
  if (downloadOnce(`${req.ip}|${track.id}`)) store.incrementDownloads(track.id);
  res.download(full, safeName);
});

// Засчитывает прослушивание (вызывается плеером, когда воспроизведение реально началось)
router.post('/:id/play', (req, res) => {
  const track = store.findTrack(req.params.id);
  if (!track || !canSee(track, req.user)) return res.status(404).json({ error: 'Трек не найден' });
  const key = `${req.user ? 'u' + req.user.id : req.ip}|${track.id}`;
  if (!playOnce(key)) return res.json({ counted: false, plays: track.plays });
  res.json({ counted: true, plays: store.incrementPlays(track.id).plays });
});

router.get('/:id', (req, res) => {
  const track = store.findTrack(req.params.id);
  if (!track || !canSee(track, req.user)) return res.status(404).json({ error: 'Трек не найден' });
  const uploader = store.findUserById(track.uploaded_by);
  const liked = req.user ? store.isLiked(req.user.id, track.id) : false;
  res.json({ ...track, liked, uploader: uploader ? store.publicUser(uploader) : null });
});

router.post('/', requireAuth, uploadLimiter, (req, res) => {
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой' : err.message });
    try {
      const user = req.user;
      if (cfg.REQUIRE_VERIFIED_EMAIL && !user.is_admin && !user.email_verified) {
        U.cleanup(req.files); return res.status(403).json({ error: 'Подтвердите email, чтобы загружать треки' });
      }
      const f = cleanFields(req.body || {});
      if (!f.title || !f.artist) { U.cleanup(req.files); return res.status(400).json({ error: 'Название и исполнитель обязательны' }); }
      const tNorm = String(f.type || '').toLowerCase();
      if ((tNorm === 'демо' || tNorm === 'demo') && !user.is_arranger && !user.is_admin) {
        U.cleanup(req.files); return res.status(403).json({ error: 'Тип «Демо» доступен только аранжировщикам' });
      }
      const audioFile = req.files && req.files.audio && req.files.audio[0];
      const coverFile = req.files && req.files.cover && req.files.cover[0];
      if (!audioFile) { U.cleanup(req.files); return res.status(400).json({ error: 'Нужен аудиофайл' }); }
      const audio = await U.storeAudio(audioFile);
      let cover = null;
      if (coverFile) {
        cover = U.storeImage(coverFile, path.join(cfg.PUBLIC_DIR, 'covers'), '/covers');
        if (!cover) { U.removeAudio(audio.filename); return res.status(400).json({ error: 'Обложка не является изображением' }); }
      }
      const wanted = req.body && req.body.status;
      const track = store.createTrack({
        ...f,
        duration: audio.duration || f.duration, bitrate: audio.bitrate || f.bitrate,
        file_path: `/uploads/${audio.filename}`, file_size: audio.size, cover,
        uploaded_by: user.id,
        status: user.is_admin ? (wanted === 'pending' ? 'pending' : 'approved') : 'pending'
      });
      res.json({ ok: true, track });
    } catch (e) {
      U.cleanup(req.files);
      res.status(400).json({ error: e.message });
    }
  });
});

router.put('/:id', requireAuth, (req, res) => {
  const result = store.updateTrack(req.params.id, cleanFields(req.body || {}), req.user.id, req.user.is_admin);
  if (result === null) return res.status(404).json({ error: 'Не найден' });
  if (result === false) return res.status(403).json({ error: 'Нет прав' });
  res.json({ ok: true, track: result });
});

router.post('/:id/cover', requireAuth, (req, res) => {
  coverOnly.single('cover')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const coverPath = U.storeImage(req.file, path.join(cfg.PUBLIC_DIR, 'covers'), '/covers');
    if (!coverPath) return res.status(400).json({ error: 'Файл не является изображением' });
    const before = store.findTrack(req.params.id);
    const result = store.setTrackCover(req.params.id, coverPath, req.user.id, req.user.is_admin);
    if (result === null) { U.removePublicFile(coverPath); return res.status(404).json({ error: 'Трек не найден' }); }
    if (result === false) { U.removePublicFile(coverPath); return res.status(403).json({ error: 'Менять обложку может только автор или админ' }); }
    if (before && before.cover) U.removePublicFile(before.cover);
    res.json({ ok: true, cover: coverPath });
  });
});

router.post('/:id/like', requireAuth, (req, res) => {
  const result = store.toggleLike(req.user.id, Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'Трек не найден' });
  res.json(result);
});

router.delete('/:id', requireAuth, (req, res) => {
  const track = store.findTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Не найден' });
  if (!req.user.is_admin && track.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Нет прав' });
  store.deleteTrack(track.id);
  U.removeAudio(track.file_path);
  U.removePublicFile(track.cover);
  res.json({ ok: true });
});

router.put('/:id/status', requireAdmin, (req, res) => {
  const t = store.setTrackStatus(req.params.id, (req.body || {}).status);
  if (t === false) return res.status(400).json({ error: 'Неверный статус' });
  if (!t) return res.status(404).json({ error: 'Трек не найден' });
  res.json({ ok: true, track: t });
});

module.exports = router;
