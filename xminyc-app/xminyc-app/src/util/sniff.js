// Определение реального типа файла по сигнатуре (не доверяем расширению и MIME от клиента)
const fs = require('fs');

function head(file, n = 16) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
}
const ascii = (b, s, e) => b.toString('latin1', s, e);

function sniffAudio(file) {
  const b = head(file);
  if (b.length < 12) return null;
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'wav';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (ascii(b, 4, 8) === 'ftyp') return 'm4a';
  return null;
}
function sniffImage(file) {
  const b = head(file);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  return null;
}
// Проверяет файл, приводит расширение к реальному. Возвращает {path, ext} или null (файл удалён).
function finalize(file, kind) {
  const ext = kind === 'audio' ? sniffAudio(file.path) : sniffImage(file.path);
  if (!ext) { try { fs.unlinkSync(file.path); } catch (_) {} return null; }
  const base = file.path.replace(/\.[^./\\]+$/, '');
  const next = base + '.' + ext;
  if (next !== file.path) fs.renameSync(file.path, next);
  return { path: next, ext, filename: next.split(/[\\/]/).pop() };
}
module.exports = { sniffAudio, sniffImage, finalize };
