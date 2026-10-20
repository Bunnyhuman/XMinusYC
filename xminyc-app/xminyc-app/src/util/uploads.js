const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cfg = require('../config');
const sniff = require('./sniff');

// Все загрузки сначала попадают во временную папку, затем проверяются по сигнатуре и переносятся.
const tmpStorage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, cfg.TMP_DIR),
  filename: (_r, _f, cb) => cb(null, uuidv4() + '.upload')
});
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.flac'];
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function multerFor({ audio = false, imageFields = ['cover'], maxAudio = 50 * 1024 * 1024, maxImage = 5 * 1024 * 1024 } = {}) {
  return multer({
    storage: tmpStorage,
    limits: { fileSize: Math.max(audio ? maxAudio : 0, maxImage), files: 3 },
    fileFilter: (_r, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (audio && file.fieldname === 'audio') return cb(AUDIO_EXT.includes(ext) ? null : new Error('Только аудио (mp3, wav, ogg, m4a, flac)'), AUDIO_EXT.includes(ext));
      if (imageFields.includes(file.fieldname)) return cb(IMG_EXT.includes(ext) ? null : new Error('Только изображения (jpg, png, webp, gif)'), IMG_EXT.includes(ext));
      cb(new Error('Неожиданное поле файла'), false);
    }
  });
}

function cleanup(files) {
  for (const f of [].concat(...Object.values(files || {}).map(v => Array.isArray(v) ? v : [v]))) {
    if (f && f.path) fs.unlink(f.path, () => {});
  }
}
// Проверяет изображение по сигнатуре и кладёт в публичную папку. Возвращает URL или null.
function storeImage(file, dir, urlPrefix) {
  if (!file) return null;
  const r = sniff.finalize(file, 'image');
  if (!r) return null;
  const name = uuidv4() + '.' + r.ext;
  fs.renameSync(r.path, path.join(dir, name));
  return `${urlPrefix}/${name}`;
}
// Проверяет аудио, читает длительность/битрейт, кладёт в storage/audio.
async function storeAudio(file) {
  const r = sniff.finalize(file, 'audio');
  if (!r) throw new Error('Файл не является поддерживаемым аудио');
  let meta = {};
  try {
    const mm = require('music-metadata');
    const m = await mm.parseFile(r.path, { duration: true });
    meta.duration = m.format.duration ? fmtDur(m.format.duration) : null;
    meta.bitrate = m.format.bitrate ? Math.round(m.format.bitrate / 1000) + ' kbps' : null;
  } catch (_) {
    try { fs.unlinkSync(r.path); } catch (__) {}
    throw new Error('Не удалось прочитать аудиофайл — он повреждён или в неподдерживаемом формате');
  }
  const name = uuidv4() + '.' + r.ext;
  fs.renameSync(r.path, path.join(cfg.AUDIO_DIR, name));
  return { filename: name, size: fs.statSync(path.join(cfg.AUDIO_DIR, name)).size, ...meta };
}
function fmtDur(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function removePublicFile(urlPath) {
  if (!urlPath || !/^\/(covers|avatars|artists)\/[\w.-]+$/.test(urlPath)) return;
  fs.unlink(path.join(cfg.PUBLIC_DIR, urlPath), () => {});
}
function removeAudio(filePath) {
  if (!filePath) return;
  const f = path.basename(filePath);
  fs.unlink(path.join(cfg.AUDIO_DIR, f), () => {});
}
module.exports = { multerFor, cleanup, storeImage, storeAudio, removePublicFile, removeAudio };
