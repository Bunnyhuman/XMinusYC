// Отдача аудио из приватного хранилища: только для существующих и видимых треков, с поддержкой Range
const express = require('express');
const path = require('path');
const store = require('../db/store');
const cfg = require('../config');

const router = express.Router();
router.get('/uploads/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[0-9a-f-]{36}\.(mp3|wav|ogg|m4a|flac)$/i.test(file)) return res.status(404).end();
  const track = store.findTrackByFile('/uploads/' + file);
  if (!track) return res.status(404).end();
  if (track.status === 'rejected' && !(req.user && (req.user.is_admin || req.user.id === track.uploaded_by))) return res.status(404).end();
  res.sendFile(file, {
    root: cfg.AUDIO_DIR, acceptRanges: true,
    headers: {
      'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': track.status === 'approved' ? 'public, max-age=86400' : 'private, max-age=0'
    }
  }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
module.exports = router;
