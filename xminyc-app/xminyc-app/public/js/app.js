const API = '/api';

let currentUser = null;
let tracks = [];
let currentTrack = null;
let currentIndex = -1;
let isPlaying = false;
let pitch = 0, tempo = 100, pendingPitch = 0, pendingTempo = 100;
let audioCtx = null, sourceNode = null, audioBuffer = null;
let startTime = 0, pauseOffset = 0, progressTimer = null, durationSec = 0;
let seeking = false, addToCollTrackId = null;

function normPath(h) {
  h = String(h || '/');
  if (h.startsWith('#')) h = h.slice(1);
  if (!h.startsWith('/')) h = '/' + h;
  return h;
}
function navigate(to) {
  const target = normPath(to);
  if (location.pathname + location.search === target) render();
  else { history.pushState(null, '', target); render(); window.scrollTo(0, 0); }
}
function getRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  return { parts, params };
}
// Старые ссылки вида /#/track/1 превращаются в /track/1
(function migrateLegacyHash() {
  if (location.hash && location.hash.startsWith('#/')) history.replaceState(null, '', normPath(location.hash));
})();
window.addEventListener('popstate', () => render());

// Перехват внутренних ссылок: навигация без перезагрузки страницы
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || href === '#') return;
  let url; try { url = new URL(href, location.origin); } catch (_) { return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || /\.[a-z0-9]{2,5}$/i.test(url.pathname)) return;
  e.preventDefault();
  const pm = document.getElementById('profile-menu'); if (pm) pm.hidden = true;
  navigate(url.pathname + url.search);
});

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** Отображаемое имя: ник или @username */
function userLabel(u) {
  if (!u) return '';
  const dn = (u.display_name || '').trim();
  return dn || ('@' + (u.username || ''));
}
function userLinkHTML(u) {
  if (!u || !u.username) return '—';
  return `<a href="/user/${encodeURIComponent(u.username)}" data-link class="user-link">${esc(userLabel(u))}</a>${arrangerBadgeHTML(u)}`;
}
function arrangerBadgeHTML(u) {
  if (!u || !(u.is_arranger || u.isArranger)) return '';
  return `<span class="arranger-badge" title="${window.I18N.t('arranger') || 'Аранжировщик'}">${window.I18N.t('arranger_badge') || 'АРАНЖИРОВЩИК'}</span>`;
}
function isArrangerUser(u) {
  return !!(u && (u.isArranger || u.is_arranger || u.isAdmin || u.is_admin));
}
const TYPE_KEYS = {
  'мастер': 'type_master', 'master': 'type_master',
  'ориг': 'type_orig', 'orig': 'type_orig',
  'нарезка': 'type_cut', 'cut': 'type_cut',
  'нарезка + подпись': 'type_cut_sig', 'cut + signature': 'type_cut_sig',
  'нейроминус': 'type_neuro', 'neuro': 'type_neuro',
  'демо': 'type_demo', 'demo': 'type_demo',
  'с бэк вокалом': 'type_back', 'back': 'type_back',
  'минус для гитары': 'type_guitar',
  'минус для скрипки': 'type_violin',
  'минус для саксафона': 'type_sax',
  'минус для аккордеона': 'type_accordion',
  'минус для флейты': 'type_flute',
  'минус для барабанов': 'type_drums',
  'минус для пианино': 'type_piano'
};
const TYPE_PRIMARY = ['мастер', 'ориг', 'нарезка', 'нарезка + подпись', 'нейроминус'];
const TYPE_DEMO = 'демо';
const TYPE_EXTRA = [
  'с бэк вокалом', 'минус для гитары', 'минус для скрипки', 'минус для саксафона',
  'минус для аккордеона', 'минус для флейты', 'минус для барабанов', 'минус для пианино'
];
function typeLabel(type) {
  if (!type) return '';
  const key = TYPE_KEYS[type] || TYPE_KEYS[String(type).toLowerCase()];
  return key ? window.I18N.t(key) : type;
}
function typeOptionsHtml(selected) {
  const vals = [...TYPE_PRIMARY];
  if (currentUser && (currentUser.isArranger || currentUser.is_arranger || currentUser.isAdmin || currentUser.is_admin)) {
    vals.push(TYPE_DEMO || 'демо');
  }
  return vals.map(v => `<option value="${v}" ${selected===v?'selected':''}>${typeLabel(v)}</option>`).join('');
}
function typeExtraOptionsHtml(selected) {
  const none = `<option value="" ${!selected?'selected':''}>—</option>`;
  return none + TYPE_EXTRA.map(v => `<option value="${v}" ${selected===v?'selected':''}>${typeLabel(v)}</option>`).join('');
}
/** Display: one type OR "primary + extra" with short forms */
function formatTrackType(t) {
  if (!t) return '';
  const primary = (typeof t === 'object' ? (t.type || '') : String(t)).trim();
  const extra = (typeof t === 'object' ? (t.type_extra || '') : '').trim();
  if (!primary && !extra) return '';
  if (!extra) return typeLabel(primary) || primary;
  let p;
  if (primary === 'нейроминус' || primary === 'neuro') p = 'AI';
  else p = typeLabel(primary) || primary;
  let e;
  if (extra === 'с бэк вокалом' || extra === 'back') e = window.I18N.t('type_back_short') || 'бэк';
  else e = typeLabel(extra) || extra;
  return p + ' + ' + e;
}
function statusLabel(status) {
  if (status === 'pending') return window.I18N.t('status_pending') || 'Ожидает модерации';
  if (status === 'rejected') return window.I18N.t('status_rejected') || 'Отклонено';
  if (status === 'approved') return window.I18N.t('status_approved') || 'Одобрено';
  return '';
}
function trackTitleDisplay(t) {
  const st = t.status || 'approved';
  let title = t.title || '';
  if (st === 'rejected') {
    const pref = window.I18N.t('status_rejected_prefix') || '[ОТКЛОНЕНО]';
    if (!title.startsWith(pref) && !title.startsWith('[ОТКЛОНЕНО]')) title = pref + ' ' + title;
  }
  return title;
}
function moderationHintHTML(t, inline) {
  const st = t.status || 'approved';
  if (st === 'pending') {
    const cls = inline ? 'mod-hint mod-hint-inline' : 'mod-hint';
    return `<span class="${cls}" title="${esc(statusLabel('pending'))}"><span class="mod-hint-icon">⚠</span>${esc(statusLabel('pending'))}</span>`;
  }
  if (st === 'rejected') {
    return `<span class="mod-hint mod-hint-rejected${inline ? ' mod-hint-inline' : ''}">${esc(statusLabel('rejected'))}</span>`;
  }
  return '';
}
function formatPlays(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function formatSize(b) {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function formatDate(iso) {
  if (!iso) return '—';
  const lang = (window.I18N && window.I18N.lang) || 'ru';
  const localeMap = {
    ru: 'ru-RU', en: 'en-US', be: 'be-BY', uk: 'uk-UA', es: 'es-ES', fr: 'fr-FR',
    zh: 'zh-CN', pl: 'pl-PL', tr: 'tr-TR', pt: 'pt-BR', ro: 'ro-RO', it: 'it-IT',
    ka: 'ka-GE', ja: 'ja-JP', ko: 'ko-KR', kk: 'kk-KZ'
  };
  const loc = localeMap[lang] || 'ru-RU';
  try {
    return new Date(iso).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) {
    return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));

function artistLinks(artistStr) {
  return String(artistStr || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(n => `<a href="/artist/${encodeURIComponent(n)}" class="artist-link" data-artist="${esc(n)}">${esc(n)}</a>`)
    .join(', ');
}
function bindArtistLinks(root) {
  (root || document).querySelectorAll('[data-artist]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigate('/artist/' + encodeURIComponent(a.dataset.artist));
    });
  });
}

// ===== Auth =====
async function checkAuth() {
  try {
    const res = await fetch(`${API}/auth/me`, { credentials: 'include' });
    currentUser = (await res.json()).user;
  } catch { currentUser = null; }
  updateAuthUI();
}
function isCurrentAdmin() {
  return !!(currentUser && (currentUser.isAdmin || currentUser.is_admin));
}
function updateAuthUI() {
  const btnAuth = document.getElementById('btn-auth');
  const btnUpload = document.getElementById('btn-upload');
  const wrap = document.getElementById('profile-wrap');
  const navColl = document.getElementById('nav-collections');
  if (currentUser) {
    btnAuth.hidden = true;
    btnUpload.hidden = false;
    wrap.hidden = false;
    navColl.hidden = false;
    const modLink = document.getElementById('menu-moderation');
    if (modLink) modLink.hidden = !isCurrentAdmin();
    const arrApps = document.getElementById('menu-arranger-apps');
    if (arrApps) arrApps.hidden = !isCurrentAdmin();
    const admLink = document.getElementById('menu-admin');
    if (admLink) admLink.hidden = !isCurrentAdmin();
    const arrApply = document.getElementById('menu-arranger-apply');
    if (arrApply) {
      arrApply.hidden = !!(currentUser.isArranger || currentUser.is_arranger);
    }
    const menuMy = document.getElementById('menu-my-page');
    menuMy.href = `/user/${encodeURIComponent(currentUser.username)}`;
    menuMy.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('profile-menu').hidden = true;
      navigate(`/user/${encodeURIComponent(currentUser.username)}`);
    };
    const img = document.getElementById('header-avatar');
    const fb = document.getElementById('header-avatar-fallback');
    if (currentUser.avatar) { img.src = currentUser.avatar; img.hidden = false; fb.hidden = true; }
    else { img.hidden = true; fb.hidden = false; }
  } else {
    btnAuth.hidden = false;
    btnAuth.textContent = window.I18N.t('nav_login');
    btnAuth.onclick = () => openModal('auth-modal');
    btnUpload.hidden = true;
    wrap.hidden = true;
    navColl.hidden = true;
    const modLink = document.getElementById('menu-moderation');
    if (modLink) modLink.hidden = true;
    const arrApps = document.getElementById('menu-arranger-apps');
    if (arrApps) arrApps.hidden = true;
    const admLink = document.getElementById('menu-admin');
    if (admLink) admLink.hidden = true;
    const arrApply = document.getElementById('menu-arranger-apply');
    if (arrApply) arrApply.hidden = true;
  }
}
document.getElementById('avatar-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = document.getElementById('profile-menu');
  m.hidden = !m.hidden;
});
document.addEventListener('click', () => { document.getElementById('profile-menu').hidden = true; });
document.getElementById('menu-logout').addEventListener('click', async () => {
  await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' });
  currentUser = null;
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  updateAuthUI();
  navigate('/');
});

let isRegister = false;
function updateAuthToggleUI() {
  document.getElementById('auth-email').hidden = !isRegister;
  document.getElementById('auth-title').textContent = isRegister
    ? (window.I18N.t('auth_register') || 'Регистрация')
    : window.I18N.t('auth_login');
  document.getElementById('auth-submit').textContent = isRegister
    ? (window.I18N.t('auth_register_btn') || window.I18N.t('auth_submit'))
    : window.I18N.t('nav_login');
  document.getElementById('auth-toggle').textContent = isRegister
    ? (window.I18N.t('auth_have_account') || 'Уже есть аккаунт? Войти')
    : window.I18N.t('auth_toggle');
}
document.getElementById('auth-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  isRegister = !isRegister;
  updateAuthToggleUI();
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const email = document.getElementById('auth-email').value.trim();
  const errEl = document.getElementById('auth-error');
  if (window.XM_EXTRA && await window.XM_EXTRA.authIntercept()) return;
  try {
    const res = await fetch(isRegister ? `${API}/auth/register` : `${API}/auth/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isRegister ? { username, email, password } : { username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    currentUser = data.user;
    const si = document.getElementById('search-input');
    if (si) si.value = '';
    updateAuthUI(); closeModal('auth-modal'); render();
  } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
});

// ===== Player (Tone.js GrainPlayer — independent pitch & tempo) =====
let htmlAudio = null;
let grainPlayer = null;
let toneBuffer = null;
let progressRaf = null;

function ensureTone() {
  if (typeof Tone === 'undefined') throw new Error('Tone.js не загружен');
  return Tone;
}

async function resumeTone() {
  const Tone = ensureTone();
  if (Tone.context.state !== 'running') {
    await Tone.start();
  }
}

function getElapsed() {
  if (grainPlayer && isPlaying) {
    // GrainPlayer has no currentTime; estimate from wall clock
    const rate = tempo / 100;
    const elapsed = (performance.now() - startTime) / 1000 * rate;
    return Math.min(durationSec || 0, pauseOffset + elapsed);
  }
  return pauseOffset;
}

function updateProgressUI(elapsed) {
  if (window.XM_EXTRA) window.XM_EXTRA.onTime(elapsed);
  if (!durationSec) return;
  const pct = Math.min(100, (elapsed / durationSec) * 100);
  const fill = document.getElementById('p-fill');
  const thumb = document.getElementById('p-thumb');
  if (fill) fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';
  const cur = document.getElementById('p-current');
  if (cur) cur.textContent = formatTime(elapsed);
}

function stopGrain() {
  if (progressRaf) { cancelAnimationFrame(progressRaf); progressRaf = null; }
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  if (grainPlayer) {
    try { grainPlayer.stop(); } catch (_) {}
    try { grainPlayer.dispose(); } catch (_) {}
    grainPlayer = null;
  }
  isPlaying = false;
  const btn = document.getElementById('p-play');
  if (btn) btn.textContent = '▶';
}

function stopAllAudio(clearBuffer = true) {
  stopGrain();
  if (htmlAudio) {
    try { htmlAudio.pause(); htmlAudio.src = ''; } catch (_) {}
    htmlAudio = null;
  }
  if (clearBuffer) {
    toneBuffer = null;
    audioBuffer = null;
  }
}

async function playTrackById(id, index, opts = {}) {
  const keepFx = !!(opts && opts.keepFx);
  const res = await fetch(`${API}/tracks/${id}`, { credentials: 'include' });
  if (!res.ok) return;
  const track = await res.json();
  currentTrack = track;
  currentIndex = index ?? tracks.findIndex(t => t.id === id);
  document.getElementById('p-title').textContent = track.title;
  document.getElementById('p-artist').textContent = track.artist;
  const art = document.getElementById('p-art');
  if (track.cover) {
    art.innerHTML = '<img src="' + esc(track.cover) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:12px">';
  } else {
    art.textContent = '🎵';
  }
  document.getElementById('player').hidden = false;
  if (!keepFx) {
    pitch = pendingPitch = 0;
    tempo = pendingTempo = 100;
  }
  pauseOffset = 0;
  updateFxUI();

  stopAllAudio(true);
  if (!track.file_path) {
    alert('У этого трека нет аудиофайла. Загрузите MP3.');
    return;
  }
  await loadAndPlayTone(track.file_path);
  if (isPlaying && window.XM_EXTRA) window.XM_EXTRA.onTrackStart(track);
  // если keepFx — применить pitch/tempo после старта
  if (keepFx && (pitch !== 0 || tempo !== 100)) {
    pendingPitch = pitch;
    pendingTempo = tempo;
    await applyFx();
  }
}

async function loadAndPlayTone(url) {
  stopAllAudio();
  try {
    await resumeTone();
    const Tone = ensureTone();
    // Load into Tone buffer
    toneBuffer = new Tone.ToneAudioBuffer();
    await toneBuffer.load(url);
    durationSec = toneBuffer.duration;
    document.getElementById('p-total').textContent = formatTime(durationSec);
    await startGrainPlayback(0);
  } catch (e) {
    console.error('Tone load failed', e);
    // Fallback: plain HTMLAudio (no independent pitch/tempo)
    try {
      htmlAudio = new Audio(url);
      await new Promise((res, rej) => {
        htmlAudio.onloadedmetadata = res;
        htmlAudio.onerror = rej;
        setTimeout(res, 5000);
      });
      durationSec = htmlAudio.duration || 0;
      document.getElementById('p-total').textContent = formatTime(durationSec);
      htmlAudio.currentTime = 0;
      await htmlAudio.play();
      isPlaying = true;
      document.getElementById('p-play').textContent = '⏸';
      progressTimer = setInterval(() => {
        if (!seeking && htmlAudio && isPlaying) {
          pauseOffset = htmlAudio.currentTime;
          updateProgressUI(htmlAudio.currentTime);
        }
      }, 100);
    } catch (e2) {
      alert('Не удалось загрузить аудио');
    }
  }
}

async function startGrainPlayback(offset) {
  stopGrain();
  if (!toneBuffer) return;
  await resumeTone();
  const Tone = ensureTone();

  grainPlayer = new Tone.GrainPlayer({
    url: toneBuffer,
    loop: false,
    grainSize: 0.1,
    overlap: 0.05,
    playbackRate: Math.max(0.5, Math.min(1.5, tempo / 100)),
    detune: pitch * 100, // cents: ±1200 = ±12 semitones
    onstop: () => {
      isPlaying = false;
      const btn = document.getElementById('p-play');
      if (btn) btn.textContent = '▶';
    }
  }).toDestination();

  const startAt = Math.max(0, Math.min(offset || 0, durationSec - 0.05));
  pauseOffset = startAt;
  // Track wall-clock for progress (GrainPlayer doesn't expose position reliably)
  startTime = performance.now();
  grainPlayer.start(undefined, startAt);

  isPlaying = true;
  document.getElementById('p-play').textContent = '⏸';

  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (seeking || !isPlaying) return;
    const rate = tempo / 100;
    const elapsed = pauseOffset + (performance.now() - startTime) / 1000 * rate;
    if (elapsed >= durationSec) {
      stopGrain();
      pauseOffset = 0;
      updateProgressUI(0);
      if (window.XM_EXTRA) window.XM_EXTRA.onEnded();
      return;
    }
    updateProgressUI(elapsed);
  }, 50);
}

function stopAudio() {
  if (isPlaying) {
    if (grainPlayer) {
      const rate = tempo / 100;
      pauseOffset = Math.min(durationSec, pauseOffset + (performance.now() - startTime) / 1000 * rate);
    } else if (htmlAudio) {
      pauseOffset = htmlAudio.currentTime;
    }
  }
  stopGrain();
  if (htmlAudio) try { htmlAudio.pause(); } catch (_) {}
  isPlaying = false;
  document.getElementById('p-play').textContent = '▶';
  updateProgressUI(pauseOffset);
  if (window.XM_EXTRA) window.XM_EXTRA.onPause();
}

function togglePlay() {
  if (!currentTrack) return;
  if (isPlaying) {
    stopAudio();
  } else {
    if (toneBuffer) startGrainPlayback(pauseOffset);
    else if (htmlAudio) {
      htmlAudio.currentTime = pauseOffset;
      htmlAudio.play();
      isPlaying = true;
      document.getElementById('p-play').textContent = '⏸';
    }
  }
}

function showApply() {
  const el = document.getElementById('fx-apply') || document.getElementById('tp-fx-apply');
  if (!el) return;
  el.hidden = !(pendingPitch !== pitch || pendingTempo !== tempo);
}
function hideApply() {
  const el = document.getElementById('fx-apply') || document.getElementById('tp-fx-apply');
  if (el) el.hidden = true;
}

function changePendingPitch(d) {
  pendingPitch = Math.max(-12, Math.min(12, +(pendingPitch + d).toFixed(1)));
  updateFxUI();
  showApply();
}
function changePendingTempo(d) {
  pendingTempo = Math.max(50, Math.min(150, pendingTempo + d));
  updateFxUI();
  showApply();
}

async function applyFx() {
  const was = isPlaying;
  let elapsed = pauseOffset;
  if (was && grainPlayer) {
    const rate = Math.max(0.5, Math.min(1.5, tempo / 100));
    elapsed = Math.min(durationSec || 0, pauseOffset + (performance.now() - startTime) / 1000 * rate);
  } else if (was && htmlAudio) {
    elapsed = htmlAudio.currentTime;
  }
  pitch = pendingPitch;
  tempo = pendingTempo;
  hideApply();
  updateFxUI();
  pauseOffset = elapsed;

  // Перезапуск с новыми pitch/tempo (GrainPlayer надёжнее пересоздать)
  if (toneBuffer && was) {
    await startGrainPlayback(elapsed);
  } else if (htmlAudio && was) {
    // fallback HTML: только tempo через playbackRate (pitch недоступен)
    htmlAudio.playbackRate = Math.max(0.5, Math.min(1.5, tempo / 100));
  }
}

function resetFx() {
  pendingPitch = 0;
  pendingTempo = 100;
  applyFx();
}

function updateFxUI() {
  const pv = document.getElementById('pitch-val') || document.getElementById('tp-pitch-val');
  const tv = document.getElementById('tempo-val') || document.getElementById('tp-tempo-val');
  if (pv) pv.textContent = (pendingPitch > 0 ? '+' : '') + pendingPitch.toFixed(1);
  if (tv) tv.textContent = pendingTempo + '%';
}

// Seek bar
const bar = document.getElementById('p-bar');
function seekFromEvent(e) {
  if (!durationSec) return 0;
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const offset = pct * durationSec;
  updateProgressUI(offset);
  return offset;
}
if (bar) {
  bar.addEventListener('pointerdown', (e) => {
    seeking = true;
    seekFromEvent(e);
    const onMove = (ev) => seekFromEvent(ev);
    const onUp = async (ev) => {
      seeking = false;
      const off = seekFromEvent(ev);
      pauseOffset = off;
      if (isPlaying && toneBuffer) await startGrainPlayback(off);
      else if (htmlAudio) htmlAudio.currentTime = off;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

document.getElementById('p-play').onclick = togglePlay;
document.getElementById('p-close').onclick = () => {
  stopAllAudio();
  document.getElementById('player').hidden = true;
  currentTrack = null;
};
document.getElementById('p-prev').onclick = () => {
  if (currentIndex > 0) playTrackById(tracks[currentIndex - 1].id, currentIndex - 1);
};
document.getElementById('p-next').onclick = () => {
  if (currentIndex < tracks.length - 1) playTrackById(tracks[currentIndex + 1].id, currentIndex + 1);
};




/** MP3 encode (lamejs) */
function audioBufferToMp3Blob(buffer) {
  if (typeof lamejs === 'undefined') throw new Error('lamejs не загружен');
  const numChan = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const right = numChan > 1 ? buffer.getChannelData(1) : left;
  const toInt16 = (f32) => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  };
  const leftI = toInt16(left);
  const rightI = toInt16(right);
  const enc = new lamejs.Mp3Encoder(numChan > 1 ? 2 : 1, sampleRate, 192);
  const block = 1152;
  const parts = [];
  for (let i = 0; i < leftI.length; i += block) {
    const l = leftI.subarray(i, i + block);
    const r = rightI.subarray(i, i + block);
    const mp3buf = numChan > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (mp3buf.length) parts.push(new Uint8Array(mp3buf));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/**
 * Быстрый offline-рендер: playbackRate (темп) + detune (тональность).
 * Не трогает Tone.js / живой плеер.
 */
async function renderBufferWithFx(audioBuf, pitchSemis, tempoPct) {
  const rate = Math.max(0.5, Math.min(1.5, (Number(tempoPct) || 100) / 100));
  const pitch = Number(pitchSemis) || 0;
  // playbackRate меняет и темп, и высоту → компенсируем detune
  const rateSemis = 12 * Math.log2(rate);
  const detuneCents = (pitch - rateSemis) * 100;
  const outFrames = Math.max(1, Math.ceil(audioBuf.length / rate) + 64);
  const offline = new OfflineAudioContext(
    audioBuf.numberOfChannels || 2,
    outFrames,
    audioBuf.sampleRate || 44100
  );
  const src = offline.createBufferSource();
  src.buffer = audioBuf;
  src.playbackRate.value = rate;
  try { src.detune.value = detuneCents; } catch (_) {}
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

async function downloadTrackProcessed(track, pitchSemis, tempoPct) {
  if (!track || !track.file_path) {
    alert('Нет файла');
    return;
  }
  const pitch = Number(pitchSemis) || 0;
  const tempo = Number(tempoPct) || 100;
  const unchanged = Math.abs(pitch) < 0.05 && Math.abs(tempo - 100) < 0.5;

  if (unchanged) {
    window.location.href = `${API}/tracks/${track.id}/download`;
    return;
  }

  const btn = document.getElementById('tp-download');
  const oldLabel = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ ' + (window.I18N.t('download_processing') || 'Обработка…');
  }

  // не останавливаем живой плеер жёстко
  try {
    const res = await fetch(track.file_path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const arr = await res.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmpCtx.decodeAudioData(arr.slice(0));
    try { await tmpCtx.close(); } catch (_) {}

    const rendered = await renderBufferWithFx(decoded, pitch, tempo);
    const blob = audioBufferToMp3Blob(rendered);

    const pitchTag = pitch === 0 ? '' : (pitch > 0 ? `+${pitch}` : `${pitch}`);
    const tempoTag = tempo === 100 ? '' : `${tempo}pct`;
    const tags = [pitchTag && `pitch${pitchTag}`, tempoTag].filter(Boolean).join('_');
    const safe = `${track.artist || 'track'} - ${track.title || 'minus'} (minus${tags ? ' ' + tags : ''}).mp3`
      .replace(/[<>:"/\\|?*]/g, '');
    triggerBlobDownload(blob, safe);
  } catch (e) {
    console.error(e);
    alert((window.I18N.t('download_fx_error') || 'Не удалось обработать аудио') + ': ' + (e.message || e));
    window.location.href = `${API}/tracks/${track.id}/download`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldLabel;
    }
  }
}

// ===== Render =====
async function render() {
  const { parts, params } = getRoute();
  const app = document.getElementById('app');
  document.title = 'XMinusYC';
  if (window.XM_EXTRA && await window.XM_EXTRA.route(parts, params, app)) return;
  if (parts[0] === 'track' && parts[1]) await renderTrackPage(app, parts[1]);
  else if (parts[0] === 'user' && parts[1]) await renderUserPage(app, decodeURIComponent(parts[1]), params.sort || 'latest');
  else if (parts[0] === 'artist' && parts[1]) await renderArtistPage(app, decodeURIComponent(parts[1]));
  else if (parts[0] === 'artists' && parts[1]) await renderArtistsLetterPage(app, decodeURIComponent(parts[1]));
  else if (parts[0] === 'top50') await renderTopPage(app, params.tab || 'popular');
  else if (parts[0] === 'novinki') await renderTopPage(app, 'novinki');
  else if (parts[0] === 'downloads') await renderTopPage(app, 'downloads');
  else if (parts[0] === 'collections') await renderCollectionsPage(app);
  else if (parts[0] === 'collection' && parts[1]) await renderCollectionPage(app, parts[1]);
  else if (parts[0] === 'settings') await renderSettingsPage(app);
  else if (parts[0] === 'upload') renderUploadPage(app);
  else if (parts[0] === 'moderation') await renderModerationPage(app);
  else if (parts[0] === 'arrangers') await renderArrangersPage(app);
  else if (parts[0] === 'arranger-apply') await renderArrangerApplyPage(app);
  else if (parts[0] === 'arranger-apps') await renderArrangerAppsAdmin(app);
  else if (parts[0] === 'search') await renderSearchPage(app, params.q || '');
  else await renderHome(app, '', params.sort || 'latest');
}

function trackRowHTML(t, i) {
  const title = trackTitleDisplay(t);
  const typeStr = formatTrackType(t);
  const st = t.status || 'approved';
  return `<div class="track" data-id="${t.id}" data-play="${t.id}" data-idx="${i}">
    <div class="track-num">${i + 1}</div>
    <div class="track-info">
      <div class="track-title-line">
        <a class="track-title" href="/track/${t.id}" data-link>${esc(title)}</a>
        ${typeStr ? `<span class="track-badge">${esc(typeStr)}</span>` : ''}
      </div>
      ${st === 'pending' ? `<div class="mod-hint mod-hint-under"><span class="mod-hint-icon">⚠</span>${esc(statusLabel('pending'))}</div>` : ''}
      <div class="track-sub">${artistLinks(t.artist)}</div>
    </div>
    <div class="track-meta">
      <span class="track-likes" title="Лайки">♥ ${t.likes_count || 0}</span>
      <span class="track-plays tooltip" data-tooltip="Рейтинг трека за всё время"><i class="icon-chart-bar"></i><span class="track-plays-n">${formatPlays(t.plays)}</span></span>
      <span class="track-dur">${esc(t.duration || '')}</span>
      <button type="button" class="track-play-icon" data-play="${t.id}" data-idx="${i}" aria-label="Play">▶</button>
    </div>
  </div>`;
}
function bindPlayButtons(app) {
  app.querySelectorAll('[data-play]').forEach(b => {
    b.addEventListener('click', (e) => {
      if (e.target.closest('a[href], a[data-link], .artist-link')) return;
      e.preventDefault();
      e.stopPropagation();
      const id = +b.dataset.play;
      const idx = b.dataset.idx !== undefined ? +b.dataset.idx : tracks.findIndex(t => t.id === id);
      playTrackById(id, idx >= 0 ? idx : tracks.findIndex(t => t.id === id));
    });
  });
}


async function renderSearchPage(app, q) {
  q = (q || '').trim();
  const { params } = getRoute();
  const f = { key: params.key || '', genre: params.genre || '', lang: params.lang || '', type: params.type || '' };
  const hasFilter = Object.values(f).some(Boolean);
  const title = window.I18N.t('search_results');
  const bar = window.XM_EXTRA ? await window.XM_EXTRA.filtersBarHTML(f) : '';
  if (!q && !hasFilter) {
    app.innerHTML = `<div class="container"><h1 class="page-title">${title}</h1>${bar}<p class="empty">${window.I18N.t('filter_hint')}</p></div>`;
    if (window.XM_EXTRA) window.XM_EXTRA.bindFilters(app, q);
    return;
  }
  const top = document.getElementById('search-input');
  if (top && q) top.value = q;
  const sp = new URLSearchParams({ limit: 100, sort: 'latest', q, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
  const data = await (await fetch(`${API}/tracks?${sp}`, { credentials: 'include' })).json();
  tracks = data.tracks || [];
  const found = window.I18N.t('search_found');
  app.innerHTML = `<div class="container">
    <h1 class="page-title">${title}</h1>
    ${bar}
    <p class="search-query-line">${q ? `«${esc(q)}» — ` : ''}${found}: ${data.total ?? tracks.length}</p>
    <div class="tracks">${tracks.map((tr, i) => trackRowHTML(tr, i)).join('') || `<p class="empty">${window.I18N.t('search_none')}</p>`}</div>
  </div>`;
  bindPlayButtons(app); bindArtistLinks(app);
  if (window.XM_EXTRA) window.XM_EXTRA.bindFilters(app, q);
}

async function renderHome(app, q, sort) {
  const homeTab = sort === 'top' || sort === 'popular' ? 'popular' : 'novinki';
  const params = homeTab === 'popular'
    ? new URLSearchParams({ limit: 10, sort: 'popular' })
    : new URLSearchParams({ limit: 30, sort: 'latest', days: 14 });
  // home page never uses search query — search goes to #/search
  const [data, arrData] = await Promise.all([
    (await fetch(`${API}/tracks?${params}`, { credentials: 'include' })).json(),
    (await fetch(`${API}/arrangers?sort=tracks&limit=5`, { credentials: 'include' })).json().catch(() => ({ arrangers: [] }))
  ]);
  tracks = data.tracks || [];
  const topArrangers = arrData.arrangers || [];

  const en = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const ru = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.split('');

  app.innerHTML = `<div class="container home-page">
    <section class="home-hero">
      <img src="/logo.png" alt="XMinusYC" class="home-logo">
      <h1 class="home-slogan">${window.I18N.t('hero_title')}</h1>
      <p class="home-sub">${window.I18N.t('hero_sub')}</p>
    </section>

    <section class="home-search-block">
      <h2 class="home-search-title">${window.I18N.t('what_search')}</h2>
      <div class="home-search">
        <input type="text" id="home-search-input" placeholder="${window.I18N.t('search_ph')}" value="" autocomplete="off">
        <button type="button" id="home-search-btn"><img src="/icons/search.png" alt="" class="icon icon-search"></button>
      </div>
    </section>

    <section class="letter-block">
      <div class="letter-row letter-en">
        ${en.map(L => `<a href="/artists/${L}" data-link class="letter-chip">${L}</a>`).join('')}
        <a href="/artists/%23" data-link class="letter-chip">#</a>
      </div>
      <div class="letter-row letter-ru">
        ${ru.map(L => `<a href="/artists/${encodeURIComponent(L)}" data-link class="letter-chip">${L}</a>`).join('')}
      </div>
    </section>

    <div class="home-main-grid">
      <div class="home-main-col">
        <div class="home-tabs">
          <button type="button" class="home-tab ${homeTab==='novinki'?'active':''}" data-home-tab="novinki">${window.I18N.t('novinki')}</button>
          <button type="button" class="home-tab ${homeTab==='popular'?'active':''}" data-home-tab="popular">${window.I18N.t('popular')}</button>
        </div>
        <div class="tracks">${tracks.map((tr,i)=>trackRowHTML(tr,i)).join('')||'<p class="empty">Пока нет треков</p>'}</div>
        ${homeTab==='popular' ? `<div class="home-more"><a href="/top50" data-link class="btn btn-primary btn-full-list">${window.I18N.t('full_list')} →</a></div>` : ''}
      </div>
      <aside class="home-side">
        <div class="arrangers-card">
          <h3 class="arrangers-title">${window.I18N.t('arrangers') || 'Аранжировщики'}</h3>
          <div class="arrangers-list">
            ${topArrangers.map(u => `
              <a href="/user/${encodeURIComponent(u.username)}" data-link class="arranger-row">
                <div class="arranger-av">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : '<span>👤</span>'}</div>
                <div class="arranger-meta">
                  <div class="arranger-name">${esc(userLabel(u))}</div>
                  <div class="arranger-count">${window.I18N.t('tracks_count') || 'треков'}: ${u.tracks_count || 0}</div>
                </div>
              </a>
            `).join('') || `<p class="empty-side">${window.I18N.t('arrangers_empty') || 'Пока нет'}</p>`}
          </div>
          <a href="/arrangers" data-link class="arrangers-all">⋯ ${window.I18N.t('all_arrangers') || 'Все аранжировщики'}</a>
        </div>
      </aside>
    </div>
  </div>`;

  bindPlayButtons(app); bindArtistLinks(app);
  app.querySelectorAll('[data-home-tab]').forEach(b => {
    b.onclick = () => {
      const tab = b.dataset.homeTab;
      navigate(tab === 'popular' ? '/?sort=popular' : '/');
    };
  });
  const hi = document.getElementById('home-search-input');
  const hb = document.getElementById('home-search-btn');
  const doSearch = () => {
    const v = (hi.value || '').trim();
    if (!v) return;
    // clear header search so they stay independent
    const top = document.getElementById('search-input');
    if (top) top.value = '';
    navigate(`/search?q=${encodeURIComponent(v)}`);
  };
  hb.onclick = doSearch;
  hi.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
}

async function renderTrackPage(app, id) {
  const res = await fetch(`${API}/tracks/${id}`, { credentials: 'include' });
  if (!res.ok) { app.innerHTML = '<div class="container"><p class="empty">Трек не найден</p></div>'; return; }
  const t = await res.json();
  const isOwner = currentUser && (currentUser.id === t.uploaded_by || currentUser.isAdmin);
  const coverHtml = t.cover
    ? `<img class="track-hero-cover" src="${esc(t.cover)}" alt="">`
    : `<div class="track-hero-art">🎵</div>`;
  const tags = [t.tag_lang, t.tag_genre, t.tag_theme].filter(Boolean);
  document.title = `${t.artist} — ${t.title} | XMinusYC`;

  app.innerHTML = `<div class="container track-page">
    <a href="/" data-link class="back-link">← ${window.I18N.t('back')}</a>
    <div class="track-hero">
      ${coverHtml}
      <div class="track-hero-info">
        ${t.status === 'pending' ? `<div class="mod-hint mod-hint-above"><span class="mod-hint-icon">⚠</span>${esc(statusLabel('pending'))}</div>` : ''}
        <h1>${esc(trackTitleDisplay(t))}</h1>
        <p class="track-hero-artist">${artistLinks(t.artist)}</p>
        <div class="track-actions">
          <button class="btn btn-primary" id="tp-play">▶ ${window.I18N.t('play')}</button>
          ${t.file_path ? `<button type="button" class="btn btn-outline" id="tp-download"><img src="/icons/download.png" class="icon" alt=""> ${window.I18N.t('download')}</button>` : ''}
          <button class="btn btn-outline" id="tp-like"><img src="/icons/heart.png" class="icon icon-heart ${t.liked ? 'liked' : ''}" alt=""> <span id="like-count">${t.likes_count || 0}</span></button>
          <button class="btn btn-outline" id="tp-add-coll" ${currentUser ? '' : 'hidden'}>+ ${window.I18N.t('add_coll')}</button>
          ${isOwner ? `<button class="btn btn-outline" id="tp-edit"><img src="/icons/edit.png" class="icon" alt=""> ${window.I18N.t('edit')}</button>` : ''}
          ${isOwner ? `<button class="btn btn-outline btn-danger" id="tp-delete">${window.I18N.t('del')}</button>` : ''}
        </div>
        <div class="cover-upload-row">
          ${(currentUser && (currentUser.id === t.uploaded_by || currentUser.isAdmin || currentUser.is_admin))
            ? `<label class="btn btn-outline file-btn">${window.I18N.t('cover')}
            <input type="file" id="cover-input" accept="image/*" hidden>
          </label>` : ''}
          <a class="btn btn-outline" href="https://uvronline.app/ai" target="_blank" rel="noopener">${window.I18N.t('nav_vocal')}</a>
        </div>
      </div>
    </div>

    <div class="fx-panel">
      <h3>Pitch & Tempo</h3>
      <p class="fx-hint">${window.I18N.t('download_fx_hint')}</p>
      <p class="fx-keyline" id="tp-keyline"></p>
      <div class="fx-panel-row">
        <div class="fx-item">
          <span class="fx-label">Pitch</span>
          <div class="fx-row">
            <button type="button" class="fx-btn" id="tp-pitch-down">−</button>
            <span class="fx-val" id="tp-pitch-val">0.0</span>
            <button type="button" class="fx-btn" id="tp-pitch-up">+</button>
          </div>
        </div>
        <div class="fx-item">
          <span class="fx-label">Tempo</span>
          <div class="fx-row">
            <button type="button" class="fx-btn" id="tp-tempo-down">−</button>
            <span class="fx-val" id="tp-tempo-val">100%</span>
            <button type="button" class="fx-btn" id="tp-tempo-up">+</button>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="tp-fx-apply" hidden>${window.I18N.t('apply')}</button>
        <button type="button" class="btn btn-outline" id="tp-fx-reset">${window.I18N.t('reset')}</button>
      </div>
    </div>

    <div class="info-table">
      <div class="info-row"><span>${window.I18N.t('type')}</span><span>${esc((t.type || t.type_extra) ? formatTrackType(t) : '—')}</span></div>
      <div class="info-row"><span>${window.I18N.t('key')}</span><span>${esc(t.key || '—')}</span></div>
      <div class="info-row"><span>${window.I18N.t('duration')}</span><span>${esc(t.duration || '—')}</span></div>
      <div class="info-row"><span>${window.I18N.t('bitrate')}</span><span>${esc(t.bitrate || '—')}</span></div>
      <div class="info-row"><span>${window.I18N.t('size')}</span><span>${formatSize(t.file_size)}</span></div>
      <div class="info-row"><span>${window.I18N.t('plays_label')}</span><span class="tooltip" data-tooltip="Рейтинг трека за всё время"><i class="icon-chart-bar"></i> ${formatPlays(t.plays)}</span></div>
      <div class="info-row"><span>${window.I18N.t('likes')}</span><span id="info-likes">${t.likes_count || 0}</span></div>
      ${tags.length ? `<div class="info-row"><span>${window.I18N.t('tags')}</span><span>${tags.map(x=>esc(x)).join(' · ')}</span></div>` : ''}
      <div class="info-row"><span>${window.I18N.t('uploaded')}</span><span>
        ${t.uploader ? userLinkHTML(t.uploader) : '—'}
        · ${formatDate(t.created_at)}
      </span></div>
    </div>

    ${t.note ? `<div class="track-note"><h3>${window.I18N.t('note')}</h3><p>${esc(t.note)}</p></div>` : ''}
    ${t.lyrics_lrc ? `<div class="karaoke-block" id="karaoke"><h3>${window.I18N.t('karaoke')}</h3><p class="field-hint">${window.I18N.t('karaoke_hint')}</p><div id="karaoke-lines" class="karaoke-lines"></div></div>` : ''}
    <p class="copyright-link"><a href="/copyright?track=${t.id}">${window.I18N.t('report_copyright')}</a></p>
    ${t.lyrics ? `<div class="lyrics-block"><h3>${window.I18N.t('lyrics')}</h3><pre>${esc(t.lyrics)}</pre></div>` : ''}
    ${t.lyrics_romaji ? `<div class="lyrics-block"><h3>${window.I18N.t('romaji')}</h3><pre>${esc(t.lyrics_romaji)}</pre></div>` : ''}
    ${t.lyrics_cyrillic ? `<div class="lyrics-block"><h3>${window.I18N.t('cyrillic')}</h3><pre>${esc(t.lyrics_cyrillic)}</pre></div>` : ''}
    ${t.lyrics_translation ? `<div class="lyrics-block"><h3>${window.I18N.t('translation')}</h3><pre>${esc(t.lyrics_translation)}</pre></div>` : ''}

    <div id="edit-form" class="edit-form" style="display:none">
      <h3>${window.I18N.t('edit')}</h3>
      <input id="ed-title" value="${esc(t.title)}" placeholder="Название">
      <input id="ed-artist" value="${esc(t.artist)}" placeholder="Исполнители">
      <select id="ed-type">${typeOptionsHtml(t.type)}</select>
      <select id="ed-type-extra">${typeExtraOptionsHtml(t.type_extra || '')}</select>
      <input id="ed-key" value="${esc(t.key || '')}" placeholder="Тональность">
      <input id="ed-duration" value="${esc(t.duration || '')}" placeholder="Длительность">
      <textarea id="ed-lyrics" rows="4" placeholder="Текст">${esc(t.lyrics || '')}</textarea>
      <textarea id="ed-romaji" rows="3" placeholder="Романизация">${esc(t.lyrics_romaji || '')}</textarea>
      <textarea id="ed-cyr" rows="3" placeholder="Кириллизация">${esc(t.lyrics_cyrillic || '')}</textarea>
      <textarea id="ed-tr" rows="3" placeholder="Перевод">${esc(t.lyrics_translation || '')}</textarea>
      <input id="ed-lang" value="${esc(t.tag_lang || '')}" placeholder="Язык (метка)">
      <input id="ed-genre" value="${esc(t.tag_genre || '')}" placeholder="Жанр">
      <input id="ed-theme" value="${esc(t.tag_theme || '')}" placeholder="Тематика">
      <textarea id="ed-note" rows="2" placeholder="${window.I18N.t('note_ph')}">${esc(t.note || '')}</textarea>
      <label class="field-label">${window.I18N.t('lrc_label')}</label>
      <textarea id="ed-lrc" rows="6" placeholder="${esc(window.I18N.t('lrc_hint'))}">${esc(t.lyrics_lrc || '')}</textarea>
      <label class="btn btn-outline file-btn">${window.I18N.t('lrc_load')}<input type="file" id="ed-lrc-file" accept=".lrc,.txt" hidden></label>
      <button class="btn btn-primary" id="ed-save">${window.I18N.t('save')}</button>
    </div>
  </div>`;

  bindArtistLinks(app);
  if (window.XM_EXTRA) { window.XM_EXTRA.mountKaraoke(t); window.XM_EXTRA.bindLrcFile(document.getElementById('ed-lrc-file'), document.getElementById('ed-lrc')); }
  document.getElementById('tp-play').onclick = async () => {
    pendingPitch = pagePitch;
    pendingTempo = pageTempo;
    pitch = pagePitch;
    tempo = pageTempo;
    await playTrackById(t.id, undefined, { keepFx: true });
  };
  document.getElementById('tp-like').onclick = async () => {
    if (!currentUser) return openModal('auth-modal');
    const r = await fetch(`${API}/tracks/${t.id}/like`, { method: 'POST', credentials: 'include' });
    const d = await r.json();
    if (!r.ok) return alert(d.error || 'Ошибка');
    document.getElementById('tp-like').innerHTML = `<img src="/icons/heart.png" class="icon icon-heart ${d.liked ? 'liked' : ''}" alt=""> <span id="like-count">${d.likes_count}</span>`;
    const il = document.getElementById('info-likes'); if (il) il.textContent = d.likes_count;
  };
  document.getElementById('tp-add-coll').onclick = () => openCollModal(t.id);
  document.getElementById('tp-edit')?.addEventListener('click', () => {
    const f = document.getElementById('edit-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('tp-delete')?.addEventListener('click', async () => {
    if (!confirm('Удалить трек навсегда?')) return;
    const r = await fetch(`${API}/tracks/${t.id}`, { method: 'DELETE', credentials: 'include' });
    if (r.ok) navigate('/');
    else alert((await r.json()).error || 'Ошибка');
  });
  // Pitch/tempo on track page
  let pagePitch = pitch, pageTempo = tempo;
  const syncFxLabels = () => {
    document.getElementById('tp-pitch-val').textContent = (pagePitch > 0 ? '+' : '') + pagePitch.toFixed(1);
    document.getElementById('tp-tempo-val').textContent = pageTempo + '%';
    const changed = pagePitch !== pitch || pageTempo !== tempo;
    document.getElementById('tp-fx-apply').hidden = !changed;
    const kl = document.getElementById('tp-keyline');
    if (kl && window.XM_EXTRA) kl.textContent = window.XM_EXTRA.keyLine(t.key, pagePitch);
  };
  syncFxLabels();
  document.getElementById('tp-pitch-up').onclick = () => { pagePitch = Math.min(12, +(pagePitch + 0.5).toFixed(1)); syncFxLabels(); };
  document.getElementById('tp-pitch-down').onclick = () => { pagePitch = Math.max(-12, +(pagePitch - 0.5).toFixed(1)); syncFxLabels(); };
  document.getElementById('tp-tempo-up').onclick = () => { pageTempo = Math.min(150, pageTempo + 5); syncFxLabels(); };
  document.getElementById('tp-tempo-down').onclick = () => { pageTempo = Math.max(50, pageTempo - 5); syncFxLabels(); };
  document.getElementById('tp-fx-apply').onclick = () => {
    pendingPitch = pagePitch;
    pendingTempo = pageTempo;
    applyFx();
    pagePitch = pitch;
    pageTempo = tempo;
    syncFxLabels();
  };
  document.getElementById('tp-fx-reset').onclick = () => {
    pagePitch = 0;
    pageTempo = 100;
    pendingPitch = 0;
    pendingTempo = 100;
    applyFx();
    syncFxLabels();
  };
  document.getElementById('tp-download')?.addEventListener('click', async (e) => {
    e.preventDefault();
    // скачать с текущими pitch/tempo со страницы (даже если ещё не нажали «Применить»)
    await downloadTrackProcessed(t, pagePitch, pageTempo);
  });
  document.getElementById('ed-save')?.addEventListener('click', async () => {
    const body = {
      title: document.getElementById('ed-title').value,
      artist: document.getElementById('ed-artist').value,
      type: document.getElementById('ed-type').value,
      type_extra: (document.getElementById('ed-type-extra') || {}).value || '',
      key: document.getElementById('ed-key').value,
      duration: document.getElementById('ed-duration').value,
      lyrics: document.getElementById('ed-lyrics').value,
      lyrics_romaji: document.getElementById('ed-romaji').value,
      lyrics_cyrillic: document.getElementById('ed-cyr').value,
      lyrics_translation: document.getElementById('ed-tr').value,
      tag_lang: document.getElementById('ed-lang').value,
      tag_genre: document.getElementById('ed-genre').value,
      tag_theme: document.getElementById('ed-theme').value,
      note: (document.getElementById('ed-note') || {}).value || '',
      lyrics_lrc: (document.getElementById('ed-lrc') || {}).value || ''
    };
    const r = await fetch(`${API}/tracks/${t.id}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r.ok) renderTrackPage(app, id);
    else alert((await r.json()).error || 'Ошибка');
  });
  document.getElementById('cover-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('cover', file);
    const r = await fetch(`${API}/tracks/${t.id}/cover`, { method: 'POST', credentials: 'include', body: fd });
    if (r.ok) renderTrackPage(app, id);
    else alert((await r.json()).error || 'Ошибка');
  });
}

async function renderUserPage(app, username, sort) {
  const res = await fetch(`${API}/users/${encodeURIComponent(username)}`);
  if (!res.ok) { app.innerHTML = '<div class="container"><p class="empty">Пользователь не найден</p></div>'; return; }
  const { user } = await res.json();
  const td = await (await fetch(`${API}/tracks?user_id=${user.id}&sort=${sort}&limit=100&mode=profile`, { credentials: 'include' })).json();
  tracks = td.tracks || [];
  const socials = user.socials || {};
  const socialLinks = [
    socials.telegram && `<a href="https://t.me/${esc(socials.telegram.replace('@',''))}" target="_blank" rel="noopener">Telegram</a>`,
    socials.vk && `<a href="${esc(socials.vk)}" target="_blank" rel="noopener">VK</a>`,
    socials.youtube && `<a href="${esc(socials.youtube)}" target="_blank" rel="noopener">YouTube</a>`,
    socials.instagram && `<a href="${esc(socials.instagram)}" target="_blank" rel="noopener">Instagram</a>`
  ].filter(Boolean).join(' · ');

  const isAdminProfile = !!(user.is_admin || user.isAdmin || String(user.username || '').toLowerCase() === 'admin');
  const themeKey = 'xminyc_admin_theme';
  const themes = {
    purple: { accent: '#B39DDB', glow: 'rgba(179,157,219,0.35)', crown: '#C9B6E4' },
    gold: { accent: '#F5D76E', glow: 'rgba(245,215,110,0.4)', crown: '#E8C547' },
    red: { accent: '#FF6B8A', glow: 'rgba(255,107,138,0.35)', crown: '#FF8FA3' },
    neon: { accent: '#39FF14', glow: 'rgba(57,255,20,0.35)', crown: '#7CFF6B' }
  };
  const savedTheme = localStorage.getItem(themeKey) || 'purple';
  const th = themes[savedTheme] || themes.purple;

  const verifyBadge = isAdminProfile ? `
    <span class="admin-verify no-save" title="Официальный создатель сайта" aria-label="Verified">
      <img src="/icons/verified.png" alt="" class="admin-verify-img" draggable="false">
    </span>` : '';

  const crownHtml = isAdminProfile ? `
    <div class="admin-crown no-save" aria-hidden="true">
      <img src="/icons/crown.png" alt="" class="admin-crown-img" draggable="false">
    </div>` : '';

  const themeBtn = isAdminProfile ? `
    <div class="admin-theme-wrap">
      <button type="button" class="admin-theme-btn" id="admin-theme-btn" title="Тема профиля"><img src="/icons/palette.png" alt="" class="admin-palette-img" draggable="false"></button>
      <div class="admin-theme-menu" id="admin-theme-menu" hidden>
        <button type="button" data-theme="purple" class="theme-swatch" style="--sw:#B39DDB" title="Фиолетовый"></button>
        <button type="button" data-theme="gold" class="theme-swatch" style="--sw:#F5D76E" title="Золотой"></button>
        <button type="button" data-theme="red" class="theme-swatch" style="--sw:#FF6B8A" title="Красный"></button>
        <button type="button" data-theme="neon" class="theme-swatch" style="--sw:#39FF14" title="Неон"></button>
      </div>
    </div>` : '';

  app.innerHTML = `<div class="container ${isAdminProfile ? 'admin-profile-page' : ''}" id="profile-root"
      style="${isAdminProfile ? `--admin-accent:${th.accent};--admin-glow:${th.glow};--admin-crown:${th.crown}` : ''}">
    <div class="profile-header ${isAdminProfile ? 'admin-profile-header' : ''}">
      <div class="profile-avatar-wrap ${isAdminProfile ? 'admin-avatar-wrap' : ''}">
        ${crownHtml}
        <div class="profile-avatar ${isAdminProfile ? 'admin-avatar' : ''}" id="profile-avatar-click">
          ${user.avatar ? `<img src="${esc(user.avatar)}" alt="" draggable="false">` : '<span>👤</span>'}
        </div>
      </div>
      <div class="profile-info">
        <h1 class="profile-name">${esc((user.display_name || '').trim() || user.username)}${verifyBadge}${arrangerBadgeHTML(user)}</h1>
        ${(user.display_name || '').trim() ? `<p class="profile-username">@${esc(user.username)}</p>` : `<p class="profile-username">@${esc(user.username)}</p>`}
        ${isAdminProfile ? `<p class="admin-badge-label no-save">Официальный создатель сайта</p>` : ''}
        ${user.bio ? `<p class="profile-bio">${esc(user.bio)}</p>` : ''}
        ${socialLinks ? `<div class="profile-socials">${socialLinks}</div>` : ''}
        <div class="profile-stats">
          <span><b>${user.tracks_count}</b> ${window.I18N.t('tracks')}</span>
          <span><b>${formatPlays(user.total_plays)}</b> ${window.I18N.t('plays')}</span>
        </div>
        ${themeBtn}
      </div>
    </div>
    <div class="sort-bar"><select id="user-sort">
      <option value="latest" ${sort==='latest'?'selected':''}>${window.I18N.t('sort_newest')}</option>
      <option value="popular" ${sort==='popular'?'selected':''}>${window.I18N.t('sort_popular')}</option>
      <option value="title" ${sort==='title'?'selected':''}>${window.I18N.t('sort_title')}</option>
      <option value="artist" ${sort==='artist'?'selected':''}>${window.I18N.t('sort_artist')}</option>
    </select></div>
    <div class="tracks">${tracks.map((t,i)=>trackRowHTML(t,i)).join('')||'<p class="empty">Нет треков</p>'}</div>
  </div>`;

  document.getElementById('user-sort').onchange = (e) => navigate(`/user/${encodeURIComponent(username)}?sort=${e.target.value}`);
  bindPlayButtons(app); bindArtistLinks(app);

  // Block save/drag on admin badges
  app.querySelectorAll('.no-save').forEach(el => {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
  });

  if (isAdminProfile) {
    // Theme switcher
    const themeBtnEl = document.getElementById('admin-theme-btn');
    const themeMenu = document.getElementById('admin-theme-menu');
    themeBtnEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      themeMenu.hidden = !themeMenu.hidden;
    });
    themeMenu?.querySelectorAll('[data-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.theme;
        localStorage.setItem(themeKey, key);
        themeMenu.hidden = true;
        renderUserPage(app, username, sort);
      });
    });
    document.addEventListener('click', () => { if (themeMenu) themeMenu.hidden = true; }, { once: true });

    // Avatar 5-click confetti
    let clicks = 0;
    let clickTimer = null;
    const av = document.getElementById('profile-avatar-click');
    av?.addEventListener('click', () => {
      clicks++;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clicks = 0; }, 1200);
      if (clicks >= 5) {
        clicks = 0;
        spawnNoteConfetti();
      }
    });
  }
}

function spawnNoteConfetti() {
  const notes = ['♪', '♫', '♩', '♬', '🎵', '🎶'];
  const layer = document.createElement('div');
  layer.className = 'note-confetti-layer';
  document.body.appendChild(layer);
  for (let i = 0; i < 40; i++) {
    const n = document.createElement('span');
    n.className = 'note-confetti';
    n.textContent = notes[i % notes.length];
    n.style.left = Math.random() * 100 + 'vw';
    n.style.animationDelay = (Math.random() * 0.8) + 's';
    n.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
    n.style.fontSize = (14 + Math.random() * 18) + 'px';
    n.style.color = ['#B39DDB', '#90CAF9', '#F5D76E', '#FF6B8A', '#39FF14'][i % 5];
    layer.appendChild(n);
  }
  setTimeout(() => layer.remove(), 4500);
}


async function renderArtistPage(app, name) {
  let res;
  try {
    res = await fetch(`${API}/artists/${encodeURIComponent(name)}`, { credentials: 'include' });
  } catch (e) {
    app.innerHTML = '<div class="container"><p class="empty">Ошибка сети</p></div>'; return;
  }
  if (!res.ok) {
    app.innerHTML = `<div class="container"><p class="empty">Ошибка ${res.status}</p></div>`; return;
  }
  const { artist, tracks: list, total } = await res.json();
  tracks = list || [];
  const isAdm = currentUser && (currentUser.isAdmin || currentUser.is_admin || String(currentUser.username||'').toLowerCase()==='admin');
  const canEditPhoto = currentUser && (isAdm || !artist.photo);
  const canEditBio = currentUser && (isAdm || !artist.bio);
  const hasBio = !!(artist.bio && String(artist.bio).trim());

  app.innerHTML = `<div class="container">
    <a href="/" data-link class="back-link">← ${window.I18N.t('back')}</a>
    <div class="profile-header">
      <div class="profile-avatar">${artist.photo ? `<img src="${esc(artist.photo)}" alt="">` : '<span>🎤</span>'}</div>
      <div class="profile-info">
        <h1>${esc(artist.name)}</h1>
        <p class="profile-bio ${hasBio ? '' : 'text-dim'}" id="artist-bio-view">${hasBio ? esc(artist.bio) : '—'}</p>
        <div class="profile-stats"><span><b>${total}</b> ${window.I18N.t('of_tracks')}</span></div>
        ${currentUser ? `<div class="artist-edit">
          ${canEditPhoto ? `<label class="btn btn-outline file-btn">Фото
            <input type="file" id="artist-photo" accept="image/*" hidden>
          </label>` : (isAdm ? '' : '<p class="text-dim">Фото может менять только админ</p>')}
          ${canEditBio ? `
          <button type="button" class="btn btn-outline" id="artist-bio-toggle">${hasBio ? 'Изменить описание' : 'Добавить описание'}</button>
          <div id="artist-bio-form" class="artist-bio-form" ${hasBio ? 'hidden' : ''}>
            <textarea id="artist-bio" rows="3" maxlength="500" placeholder="Описание (до 500)">${esc(artist.bio || '')}</textarea>
            <div class="char-count"><span id="bio-len">${(artist.bio||'').length}</span>/500</div>
            <div class="artist-bio-actions">
              <button type="button" class="btn btn-primary" id="artist-save">${window.I18N.t('save')}</button>
              ${hasBio ? `<button type="button" class="btn btn-outline" id="artist-bio-cancel">Отмена</button>` : ''}
            </div>
          </div>` : ''}
        </div>` : ''}
      </div>
    </div>
    <h2 style="margin:24px 0 12px;color:var(--text-bright)">${window.I18N.t('minusovki')}</h2>
    <div class="tracks">${tracks.map((tr,i)=>trackRowHTML(tr,i)).join('')||'<p class="empty">Пока нет</p>'}</div>

    <div class="report-block">
      <button type="button" class="report-link" id="report-artist"><img src="/icons/warning.png" class="icon icon-warning" alt="">${window.I18N.t('report_artist')}</button>
      <form id="report-form" class="report-form" style="display:none">
        <div class="report-form-head">
          <div class="report-form-icon">⚠️</div>
          <div>
            <h3 class="report-form-title">Сообщить об ошибке</h3>
            <p class="report-form-sub">Исполнитель: <b>${esc(artist.name)}</b></p>
          </div>
        </div>
        <div class="report-checks">
          <label class="report-check"><input type="checkbox" name="wrong_photo" value="1"><span>Неверное фото</span></label>
          <label class="report-check"><input type="checkbox" name="wrong_bio" value="1"><span>Неверное описание</span></label>
        </div>
        <textarea name="message" rows="4" placeholder="Опишите, что не так и как должно быть..." required></textarea>
        <button type="submit" class="btn btn-primary btn-full" id="report-submit">Отправить замечание</button>
        <div class="report-toast" id="report-toast" hidden></div>
      </form>
    </div>
  </div>`;

  bindPlayButtons(app); bindArtistLinks(app);
  document.getElementById('artist-bio-toggle')?.addEventListener('click', () => {
    const form = document.getElementById('artist-bio-form');
    if (form) form.hidden = !form.hidden;
  });
  document.getElementById('artist-bio-cancel')?.addEventListener('click', () => {
    const form = document.getElementById('artist-bio-form');
    if (form) form.hidden = true;
  });
  document.getElementById('artist-bio')?.addEventListener('input', (e) => {
    const el = document.getElementById('bio-len');
    if (el) el.textContent = e.target.value.length;
  });
  document.getElementById('artist-save')?.addEventListener('click', async () => {
    const bioEl = document.getElementById('artist-bio');
    const bio = (bioEl ? bioEl.value : '').slice(0, 500);
    const r = await fetch(`${API}/artists/${encodeURIComponent(name)}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio })
    });
    const d = await r.json();
    if (r.ok) {
      // перерисовка: описание видно текстом, поле ввода скрыто
      await renderArtistPage(app, name);
    } else alert(d.error || 'Ошибка');
  });
  document.getElementById('artist-photo')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('photo', file);
    const r = await fetch(`${API}/artists/${encodeURIComponent(name)}/photo`, { method: 'POST', credentials: 'include', body: fd });
    const d = await r.json();
    if (r.ok) renderArtistPage(app, name);
    else alert(d.error || 'Ошибка');
  });
  document.getElementById('report-artist').onclick = () => {
    const f = document.getElementById('report-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('report-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const toast = document.getElementById('report-toast');
    const btn = document.getElementById('report-submit');
    const payload = {
      artist: name,
      wrong_photo: !!fd.get('wrong_photo'),
      wrong_bio: !!fd.get('wrong_bio'),
      message: fd.get('message') || '',
      from_user: currentUser ? currentUser.username : 'гость'
    };
    if (!payload.wrong_photo && !payload.wrong_bio) {
      toast.hidden = false;
      toast.className = 'report-toast report-toast-err';
      toast.textContent = 'Отметьте: неверное фото и/или описание';
      toast.style.opacity = '1';
      setTimeout(() => { toast.hidden = true; }, 4000);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Отправка...';
    try {
      const r = await fetch(`${API}/reports/artist`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch (_) {
        throw new Error('Сервер вернул не JSON. Перезапустите npm start и обновите server.js');
      }
      if (!r.ok) throw new Error(d.error || 'Ошибка');
      toast.hidden = false;
      toast.className = 'report-toast report-toast-ok';
      toast.textContent = d.message || 'Замечание отправлено. Ожидайте.';
      toast.style.opacity = '0';
      requestAnimationFrame(() => {
        toast.style.transition = 'opacity 0.4s ease';
        toast.style.opacity = '1';
      });
      e.target.reset();
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.hidden = true; }, 500);
      }, 5000);
    } catch (err) {
      toast.hidden = false;
      toast.className = 'report-toast report-toast-err';
      toast.textContent = err.message || 'Не удалось отправить';
      toast.style.opacity = '1';
      setTimeout(() => { toast.hidden = true; }, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить замечание';
    }
  };
}


function topTabsHtml(active) {
  return `<div class="top-tabs">
    <a href="/top50" data-link class="top-tab ${active==='popular'?'active':''}">${window.I18N.t('popular_now')}</a>
    <a href="/novinki" data-link class="top-tab ${active==='novinki'?'active':''}">${window.I18N.t('novinki')}</a>
    <a href="/downloads" data-link class="top-tab ${active==='downloads'?'active':''}">${window.I18N.t('most_downloaded')}</a>
  </div>`;
}

async function renderTopPage(app, tab) {
  tab = tab || 'popular';
  let title = window.I18N.t('top50_title');
  let qs = new URLSearchParams({ limit: 50, sort: 'popular' });
  if (tab === 'novinki') {
    title = window.I18N.t('latest_title');
    qs = new URLSearchParams({ limit: 200, sort: 'latest' });
  } else if (tab === 'downloads') {
    title = window.I18N.t('top50_title');
    qs = new URLSearchParams({ limit: 50, sort: 'downloads' });
  }
  const data = await (await fetch(`${API}/tracks?${qs}`, { credentials: 'include' })).json();
  tracks = data.tracks || [];
  app.innerHTML = `<div class="container">
    <h1 class="page-title">${title}</h1>
    ${topTabsHtml(tab)}
    <div class="tracks">${tracks.map((tr,i)=>trackRowHTML(tr,i)).join('')||'<p class="empty">Пока нет</p>'}</div>
  </div>`;
  bindPlayButtons(app); bindArtistLinks(app);
}

async function renderArtistsLetterPage(app, letter) {
  if (letter === '%23') letter = '#';
  const res = await fetch(`${API}/artists/letter/${encodeURIComponent(letter)}`, { credentials: 'include' });
  const data = await res.json();
  const list = data.artists || [];
  const label = letter === '#' ? window.I18N.t('artists_on_hash') : `«${esc(letter)}»`;
  app.innerHTML = `<div class="container">
    <a href="/" data-link class="back-link">← ${window.I18N.t('back')}</a>
    <h1 class="page-title">${window.I18N.t('artists_on')} ${label}</h1>
    <div class="artist-list">
      ${list.map(a => `
        <a href="/artist/${encodeURIComponent(a.name)}" data-link class="artist-list-item">
          <span class="artist-list-name">${esc(a.name)}</span>
          <span class="artist-list-count">${a.tracks_count} ${window.I18N.t('of_tracks')}</span>
        </a>`).join('') || '<p class="empty">Нет артистов на эту букву</p>'}
    </div>
  </div>`;
}

async function renderCollectionsPage(app) {
  if (!currentUser) { openModal('auth-modal'); navigate('/'); return; }
  const data = await (await fetch(`${API}/collections`, { credentials: 'include' })).json();
  const list = data.collections || [];
  app.innerHTML = `<div class="container">
    <h1>${window.I18N.t('my_collections')}</h1>
    <form id="create-coll" class="inline-form">
      <input type="text" id="coll-name" placeholder="${window.I18N.t('coll_name')}" required>
      <button class="btn btn-primary" type="submit">${window.I18N.t('create')}</button>
    </form>
    <div class="coll-grid">${list.map(c => `
      <a href="/collection/${c.id}" data-link class="coll-card">
        <div class="coll-card-title">${esc(c.name)}</div>
        <div class="coll-card-meta">${c.tracks_count} ${window.I18N.t('tracks')}</div>
      </a>`).join('') || `<p class="empty">${window.I18N.t('no_collections')}</p>`}</div>
  </div>`;
  document.getElementById('create-coll').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('coll-name').value.trim();
    if (!name) return;
    await fetch(`${API}/collections`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
    });
    renderCollectionsPage(app);
  };
}

async function renderCollectionPage(app, id) {
  const res = await fetch(`${API}/collections/${id}`, { credentials: 'include' });
  if (!res.ok) { app.innerHTML = '<div class="container"><p class="empty">Не найден</p></div>'; return; }
  const { collection, tracks: cts } = await res.json();
  tracks = cts || [];
  app.innerHTML = `<div class="container">
    <a href="/collections" data-link class="back-link">← Сборники</a>
    <h1>${esc(collection.name)}</h1>
    <div class="tracks">${tracks.map((t,i)=>trackRowHTML(t,i)).join('')||'<p class="empty">Пусто</p>'}</div>
  </div>`;
  bindPlayButtons(app); bindArtistLinks(app);
}

async function renderSettingsPage(app) {
  if (!currentUser) { openModal('auth-modal'); navigate('/'); return; }
  // refresh user
  await checkAuth();
  const socials = currentUser.socials || {};
  app.innerHTML = `<div class="container settings-page">
    <h1>Редактировать профиль</h1>
    ${window.XM_EXTRA ? window.XM_EXTRA.verifyNoticeHTML() : ''}
    <div class="settings-avatar">
      <div class="profile-avatar large">${currentUser.avatar ? `<img src="${esc(currentUser.avatar)}">` : '<span>👤</span>'}</div>
      <label class="btn btn-outline file-btn">Загрузить фото (1:1)
        <input type="file" id="avatar-input" accept="image/*" hidden>
      </label>
    </div>
    <label>О себе</label>
    <label class="field-label">${window.I18N.t('display_name') || 'Отображаемое имя (ник)'}</label>
    <input id="set-display-name" maxlength="40" placeholder="@username если пусто" value="${esc(currentUser.display_name || '')}">
    <p class="field-hint">${window.I18N.t('display_name_hint') || 'Показывается вместо @логина в профиле и на треках'}</p>
    <textarea id="set-bio" rows="3">${esc(currentUser.bio || '')}</textarea>
    <label>Telegram</label><input id="set-tg" value="${esc(socials.telegram || '')}" placeholder="@username">
    <label>VK</label><input id="set-vk" value="${esc(socials.vk || '')}">
    <label>YouTube</label><input id="set-yt" value="${esc(socials.youtube || '')}">
    <label>Instagram</label><input id="set-ig" value="${esc(socials.instagram || '')}">
    <label>Новый пароль</label><input type="password" id="set-pass" placeholder="Оставьте пустым">
    <button class="btn btn-primary" id="set-save" style="margin-top:16px">Сохранить</button>
    <p class="form-error" id="set-error" hidden></p>
  </div>`;

  if (window.XM_EXTRA) window.XM_EXTRA.bindVerifyNotice(app);
  document.getElementById('avatar-input').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('avatar', file);
    const r = await fetch(`${API}/users/me/avatar`, { method: 'POST', credentials: 'include', body: fd });
    const d = await r.json();
    if (r.ok) { currentUser.avatar = d.avatar; updateAuthUI(); renderSettingsPage(app); }
    else alert(d.error || 'Ошибка загрузки аватара');
  };
  document.getElementById('set-save').onclick = async () => {
    const body = {
      display_name: document.getElementById('set-display-name')?.value || '',
      bio: document.getElementById('set-bio').value,
      socials: {
        telegram: document.getElementById('set-tg').value,
        vk: document.getElementById('set-vk').value,
        youtube: document.getElementById('set-yt').value,
        instagram: document.getElementById('set-ig').value
      }
    };
    const pass = document.getElementById('set-pass').value;
    if (pass) body.password = pass;
    const r = await fetch(`${API}/users/me`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = await r.json();
    if (r.ok) {
      currentUser = { ...currentUser, ...d.user, display_name: d.user.display_name };
      alert('Сохранено');
      navigate(`/user/${encodeURIComponent(currentUser.username)}`);
    } else {
      document.getElementById('set-error').textContent = d.error || 'Ошибка';
      document.getElementById('set-error').hidden = false;
    }
  };
}


async function renderModerationPage(app) {
  if (!isCurrentAdmin()) {
    app.innerHTML = `<div class="container"><p class="empty">${window.I18N.t('admin_only') || 'Только для администратора'}</p></div>`;
    return;
  }
  const data = await (await fetch(`${API}/tracks?mode=moderation&limit=100&sort=latest`, { credentials: 'include' })).json();
  const list = data.tracks || [];
  tracks = list;
  app.innerHTML = `<div class="container">
    <h1 class="page-title">${window.I18N.t('moderation_title') || 'Модерация минусовок'}</h1>
    <p class="mod-sub">${window.I18N.t('moderation_sub') || 'Треки на проверке'}: <b>${list.length}</b></p>
    <div class="mod-list" id="mod-list">
      ${list.map((t, i) => `
        <div class="mod-card" data-id="${t.id}">
          <div class="mod-card-head">
            <div class="mod-card-info">
              <div class="track-title-line">
                <a class="track-title" href="/track/${t.id}" data-link>${esc(t.title)}</a>
                ${(t.type || t.type_extra) ? `<span class="track-badge">${esc(formatTrackType(t))}</span>` : ''}
                ${moderationHintHTML(t, true)}
              </div>
              <div class="track-sub">${artistLinks(t.artist)}</div>
              <div class="mod-meta">${esc(t.duration || '—')} · ${formatDate(t.created_at)}</div>
            </div>
            <div class="mod-actions">
              <button type="button" class="btn-mod btn-mod-ok" data-action="approve" data-id="${t.id}">${window.I18N.t('mod_approve') || 'Принять'}</button>
              <button type="button" class="btn-mod btn-mod-no" data-action="reject" data-id="${t.id}">${window.I18N.t('mod_reject') || 'Отклонить'}</button>
            </div>
          </div>
          <div class="mod-player-row">
            <button type="button" class="play-btn" data-play="${t.id}" data-idx="${i}" aria-label="Play">▶</button>
            <span class="mod-hint mod-hint-inline"><span class="mod-hint-icon">⚠</span>${esc(statusLabel('pending'))}</span>
          </div>
        </div>
      `).join('') || `<p class="empty">${window.I18N.t('moderation_empty') || 'Нет треков на модерации'}</p>`}
    </div>
  </div>`;
  bindPlayButtons(app); bindArtistLinks(app);
  const listEl = document.getElementById('mod-list');
  if (listEl) {
    listEl.onclick = async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      btn.disabled = true;
      try {
        const status = action === 'approve' ? 'approved' : 'rejected';
        let r = await fetch(`${API}/tracks/${id}/status`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if (r.status === 404) {
          r = await fetch(`${API}/tracks/${id}/${action}`, { method: 'POST', credentials: 'include' });
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(d.error || ('Ошибка ' + r.status));
          btn.disabled = false;
          return;
        }
        const card = btn.closest('.mod-card');
        if (card) {
          card.style.opacity = '0';
          card.style.transition = 'opacity 0.25s';
          setTimeout(() => {
            card.remove();
            const left = document.querySelectorAll('.mod-card').length;
            const sub = document.querySelector('.mod-sub b');
            if (sub) sub.textContent = left;
            if (!left) renderModerationPage(app);
          }, 250);
        }
      } catch (err) {
        alert(err.message || 'Сеть');
        btn.disabled = false;
      }
    };
  }
}


async function renderArrangersPage(app) {
  const data = await (await fetch(`${API}/arrangers?sort=plays&limit=100`, { credentials: 'include' })).json();
  const list = data.arrangers || [];
  app.innerHTML = `<div class="container">
    <a href="/" data-link class="back-link">← ${window.I18N.t('back')}</a>
    <h1 class="page-title">${window.I18N.t('all_arrangers') || 'Все аранжировщики'}</h1>
    <p class="page-sub-dim">${window.I18N.t('arrangers_rating_hint') || 'Рейтинг рассчитывается по сумме прослушиваний всех треков'}</p>
    <div class="arrangers-grid">
      ${list.map(u => `
        <a href="/user/${encodeURIComponent(u.username)}" data-link class="arranger-card">
          <div class="arranger-av lg">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : '<span>👤</span>'}</div>
          <div class="arranger-meta">
            <div class="arranger-name">${esc(userLabel(u))} ${arrangerBadgeHTML(u)}</div>
            <div class="arranger-count">${window.I18N.t('tracks_count') || 'треков'}: ${u.tracks_count || 0}</div>
          </div>
        </a>
      `).join('') || `<p class="empty">${window.I18N.t('arrangers_empty') || 'Пока нет'}</p>`}
    </div>
  </div>`;
}

async function renderArrangerApplyPage(app) {
  if (!currentUser) { openModal('auth-modal'); navigate('/'); return; }
  if (currentUser.isArranger || currentUser.is_arranger) {
    app.innerHTML = `<div class="container"><p class="empty">${window.I18N.t('already_arranger') || 'Вы уже аранжировщик'}</p></div>`;
    return;
  }
  const me = await (await fetch(`${API}/arrangers/application/me`, { credentials: 'include' })).json();
  const app0 = me.application;
  if (app0 && app0.status === 'pending') {
    app.innerHTML = `<div class="container settings-page">
      <h1>${window.I18N.t('arranger_apply') || 'Заявка аранжировщика'}</h1>
      <p class="mod-hint">${window.I18N.t('app_pending') || 'Заявка на проверке'}</p>
      <p class="profile-bio">${esc(app0.description || '')}</p>
    </div>`;
    return;
  }
  if (app0 && app0.status === 'rejected') {
    // allow re-apply
  }
  app.innerHTML = `<div class="container settings-page">
    <h1>${window.I18N.t('arranger_apply') || 'Стать аранжировщиком'}</h1>
    <p class="field-hint">${window.I18N.t('arranger_apply_hint') || 'Опишите, чем занимаетесь, и дайте ссылки на работы'}</p>
    ${app0 && app0.status === 'rejected' ? `<p class="mod-hint mod-hint-rejected">${window.I18N.t('app_rejected') || 'Отклонено'}: ${esc(app0.reject_reason || '')}</p>` : ''}
    <textarea id="arr-desc" rows="5" maxlength="2000" placeholder="${window.I18N.t('arranger_desc_ph') || 'Описание деятельности…'}"></textarea>
    <textarea id="arr-links" rows="3" maxlength="1000" placeholder="${window.I18N.t('arranger_links_ph') || 'Ссылки на работы, соцсети…'}"></textarea>
    <p class="form-error" id="arr-err" hidden></p>
    <button type="button" class="btn btn-primary" id="arr-submit">${window.I18N.t('submit_app') || 'Отправить заявку'}</button>
  </div>`;
  document.getElementById('arr-submit').onclick = async () => {
    const description = document.getElementById('arr-desc').value;
    const links = document.getElementById('arr-links').value;
    const r = await fetch(`${API}/arrangers/application`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, links })
    });
    const d = await r.json();
    if (!r.ok) {
      const er = document.getElementById('arr-err');
      er.textContent = d.error || 'Ошибка'; er.hidden = false;
      return;
    }
    alert(window.I18N.t('app_sent') || 'Заявка отправлена и находится на проверке');
    navigate('/arranger-apply');
  };
}

async function renderArrangerAppsAdmin(app) {
  if (!isCurrentAdmin()) {
    app.innerHTML = `<div class="container"><p class="empty">${window.I18N.t('admin_only')}</p></div>`;
    return;
  }
  const data = await (await fetch(`${API}/arrangers/applications`, { credentials: 'include' })).json();
  const list = data.applications || [];
  app.innerHTML = `<div class="container">
    <h1 class="page-title">${window.I18N.t('arranger_apps') || 'Заявки аранжировщиков'}</h1>
    <div class="mod-list">
      ${list.map(ap => `
        <div class="mod-card" data-id="${ap.id}">
          <div class="mod-card-head">
            <div>
              <a href="/user/${encodeURIComponent(ap.username)}" data-link class="track-title">@${esc(ap.username)}</a>
              <span class="mod-hint mod-hint-inline">${esc(ap.status)}</span>
              <div class="mod-meta">${formatDate(ap.created_at)}</div>
              <p class="profile-bio" style="margin-top:8px">${esc(ap.description || '')}</p>
              ${ap.links ? `<p class="field-hint">${esc(ap.links)}</p>` : ''}
              ${ap.reject_reason ? `<p class="mod-hint-rejected">${esc(ap.reject_reason)}</p>` : ''}
            </div>
            ${ap.status === 'pending' ? `<div class="mod-actions">
              <button type="button" class="btn-mod btn-mod-ok" data-approve="${ap.id}">${window.I18N.t('mod_approve') || 'Принять'}</button>
              <button type="button" class="btn-mod btn-mod-no" data-reject="${ap.id}">${window.I18N.t('mod_reject') || 'Отклонить'}</button>
            </div>` : ''}
          </div>
        </div>
      `).join('') || `<p class="empty">${window.I18N.t('moderation_empty') || 'Нет заявок'}</p>`}
    </div>
  </div>`;
  app.querySelectorAll('[data-approve]').forEach(btn => {
    btn.onclick = async () => {
      const r = await fetch(`${API}/arrangers/applications/${btn.dataset.approve}/review`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: true })
      });
      if (r.ok) renderArrangerAppsAdmin(app);
      else alert((await r.json()).error || 'Ошибка');
    };
  });
  app.querySelectorAll('[data-reject]').forEach(btn => {
    btn.onclick = async () => {
      const reason = prompt(window.I18N.t('reject_reason') || 'Причина отклонения:') || '';
      const r = await fetch(`${API}/arrangers/applications/${btn.dataset.reject}/review`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: false, reason })
      });
      if (r.ok) renderArrangerAppsAdmin(app);
      else alert((await r.json()).error || 'Ошибка');
    };
  });
}

function renderUploadPage(app) {
  if (!currentUser) { openModal('auth-modal'); navigate('/'); return; }
  app.innerHTML = `<div class="container settings-page">
    <h1>${window.I18N.t('nav_upload')}</h1>
    <form id="upload-form">
      <input name="title" placeholder="${window.I18N.t('title_req')}" required>
      <input name="artist" placeholder="${window.I18N.t('artists')} *" required>
      <div class="form-row">
        <input name="duration" id="up-duration" placeholder="${window.I18N.t('duration_auto')}" readonly>
        <input name="key" placeholder="${window.I18N.t('key_example')}">
      </div>
      <div class="type-row">
        <select name="type" id="up-type" required>${typeOptionsHtml('ориг')}</select>
        <select name="type_extra" id="up-type-extra">${typeExtraOptionsHtml('')}</select>
      </div>
      ${currentUser && currentUser.isAdmin ? `<div class="admin-status-row">
        <label class="status-radio"><input type="radio" name="status" value="approved" checked> ${window.I18N.t('status_approved') || 'Одобрено сразу'}</label>
        <label class="status-radio"><input type="radio" name="status" value="pending"> ${window.I18N.t('status_pending') || 'На модерацию'}</label>
      </div>` : `<input type="hidden" name="status" value="pending">`}
      <input name="bitrate" placeholder="${window.I18N.t('bitrate')}" value="320 kbps">
      <textarea name="lyrics" rows="3" placeholder="${window.I18N.t('lyrics_full')}"></textarea>
      <textarea name="lyrics_romaji" rows="2" placeholder="${window.I18N.t('romaji_opt')}"></textarea>
      <textarea name="lyrics_cyrillic" rows="2" placeholder="${window.I18N.t('cyrillic_opt')}"></textarea>
      <textarea name="lyrics_translation" rows="2" placeholder="${window.I18N.t('translation_opt')}"></textarea>
      <label class="field-label">${window.I18N.t('lrc_label')}</label>
      <textarea name="lyrics_lrc" id="up-lrc" rows="4" placeholder="${esc(window.I18N.t('lrc_hint'))}"></textarea>
      <label class="btn btn-outline file-btn">${window.I18N.t('lrc_load')}<input type="file" id="up-lrc-file" accept=".lrc,.txt" hidden></label>
      <input name="tag_lang" placeholder="${window.I18N.t('lang_tag')}">
      <input name="tag_genre" placeholder="${window.I18N.t('genre_opt')}">
      <input name="tag_theme" placeholder="${window.I18N.t('theme_opt')}">
      <textarea name="note" rows="2" placeholder="${window.I18N.t('note_ph')}" maxlength="500"></textarea>
      <label class="file-label"><input type="file" name="audio" id="up-audio" accept="audio/*" required>
        <span id="up-audio-label">${window.I18N.t('audio_req')}</span></label>
      <label class="file-label"><input type="file" name="cover" accept="image/*">
        <span>${window.I18N.t('cover_opt')}</span></label>
      <p class="form-error" id="upload-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-full">${window.I18N.t('nav_upload')}</button>
    </form>
    <p style="margin-top:16px"><a href="https://uvronline.app/ai" target="_blank" rel="noopener">${window.I18N.t('nav_vocal')} →</a></p>
  </div>`;

  if (window.XM_EXTRA) window.XM_EXTRA.bindLrcFile(document.getElementById('up-lrc-file'), document.getElementById('up-lrc'));
  document.getElementById('up-audio').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    document.getElementById('up-audio-label').textContent = file.name;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (isFinite(audio.duration)) document.getElementById('up-duration').value = formatTime(audio.duration);
      URL.revokeObjectURL(url);
    };
    audio.src = url;
  };

  document.getElementById('upload-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    // явно типы
    const typeEl = document.getElementById('up-type');
    const extraEl = document.getElementById('up-type-extra');
    if (typeEl) fd.set('type', typeEl.value);
    if (extraEl) fd.set('type_extra', extraEl.value || '');
    if (!fd.get('duration')) fd.set('duration', document.getElementById('up-duration').value || '0:00');
    const errEl = document.getElementById('upload-error');
    try {
      const res = await fetch(`${API}/tracks`, { method: 'POST', credentials: 'include', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      navigate(`/track/${data.track.id}`);
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
  };
}

async function openCollModal(trackId) {
  if (!currentUser) return openModal('auth-modal');
  addToCollTrackId = trackId;
  const data = await (await fetch(`${API}/collections`, { credentials: 'include' })).json();
  const list = data.collections || [];
  document.getElementById('coll-list').innerHTML = list.map(c =>
    `<button type="button" class="coll-pick" data-cid="${c.id}">${esc(c.name)} (${c.tracks_count})</button>`
  ).join('') || '<p class="text-dim">Нет сборников — создайте ниже</p>';
  document.querySelectorAll('.coll-pick').forEach(b => {
    b.onclick = async () => {
      const r = await fetch(`${API}/collections/${b.dataset.cid}/tracks`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: addToCollTrackId })
      });
      if (r.ok) { closeModal('coll-modal'); alert('Добавлено в сборник'); }
      else alert((await r.json()).error || 'Ошибка');
    };
  });
  openModal('coll-modal');
}
document.getElementById('new-coll-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-coll-name').value.trim();
  if (!name || !addToCollTrackId) return;
  const r = await fetch(`${API}/collections`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const d = await r.json();
  if (d.collection) {
    await fetch(`${API}/collections/${d.collection.id}/tracks`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_id: addToCollTrackId })
    });
    closeModal('coll-modal');
    document.getElementById('new-coll-name').value = '';
    alert('Сборник создан, трек добавлен');
  }
};

document.getElementById('search-btn').onclick = () => {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return; navigate(`/search?q=${encodeURIComponent(q)}`);
};
document.getElementById('search-input').onkeydown = (e) => {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (!q) return; navigate(`/search?q=${encodeURIComponent(q)}`);
  }
};


// Explicit menu handlers
document.getElementById('menu-collections')?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('profile-menu').hidden = true;
  navigate('/collections');
});
document.getElementById('menu-settings')?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  document.getElementById('profile-menu').hidden = true;
  navigate('/settings');
});
document.getElementById('nav-collections')?.addEventListener('click', (e) => {
  e.preventDefault();
  navigate('/collections');
});

const LANG_META = {
  ru: { flag: '/flags/ru.png', code: 'RU' },
  en: { flag: '/flags/en.png', code: 'EN' },
  be: { flag: '/flags/be.png', code: 'BE' },
  uk: { flag: '/flags/uk.png', code: 'UK' },
  es: { flag: '/flags/es.png', code: 'ES' },
  fr: { flag: '/flags/fr.png', code: 'FR' },
  zh: { flag: '/flags/zh.png', code: 'ZH' },
  pl: { flag: '/flags/pl.png', code: 'PL' },
  tr: { flag: '/flags/tr.png', code: 'TR' },
  pt: { flag: '/flags/pt.png', code: 'PT' },
  ro: { flag: '/flags/ro.png', code: 'RO' },
  it: { flag: '/flags/it.png', code: 'IT' },
  ka: { flag: '/flags/ka.png', code: 'KA' },
  ja: { flag: '/flags/ja.png', code: 'JA' },
  ko: { flag: '/flags/ko.png', code: 'KO' },
  kk: { flag: '/flags/kk.png', code: 'KK' }
};
function syncLangBtn(lang) {
  const m = LANG_META[lang] || LANG_META.ru;
  const f = document.getElementById('lang-btn-flag');
  const c = document.getElementById('lang-btn-code');
  if (f) { f.src = m.flag; f.alt = m.code; }
  if (c) c.textContent = m.code;
}
const langBtn = document.getElementById('lang-btn');
const langMenu = document.getElementById('lang-menu');
if (langBtn && langMenu) {
  syncLangBtn(window.I18N.lang);
  langBtn.onclick = (e) => {
    e.stopPropagation();
    langMenu.hidden = !langMenu.hidden;
  };
  document.addEventListener('click', () => { langMenu.hidden = true; });
  langMenu.querySelectorAll('.lang-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      const lang = item.dataset.lang;
      window.I18N.set(lang);
      syncLangBtn(lang);
      langMenu.hidden = true;
      updateAuthUI();
      render();
    };
  });
}
window.addEventListener('xminyc-lang', () => { syncLangBtn(window.I18N.lang); updateAuthUI(); render(); });
window.I18N.apply();

// Minuses menu
(function(){
  const btn = document.getElementById('nav-minus-btn');
  const menu = document.getElementById('nav-minus-menu');
  if (!btn || !menu) return;
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => e.stopPropagation());
})();

checkAuth().then(() => render());

// OAuth status (кнопки не отключаем жёстко — только подсказка в консоли)
fetch('/api/auth/oauth-status').then(r => r.json()).then(s => {
  console.log('[oauth-status]', s);
  if (!s.google) console.warn('Google OAuth: нет ключей в .env');
  if (!s.yandex) console.warn('Yandex OAuth: нет ключей в .env');
}).catch((e) => console.warn('oauth-status failed', e));

(function showAuthError() {
  const q = new URLSearchParams(location.search);
  if (!q.has('auth_error')) return;
  const provider = q.get('auth_error') || 'oauth';
  const msg = q.get('msg') || '';
  const text = 'Ошибка входа через ' + provider + (msg ? ': ' + msg : '');
  q.delete('auth_error'); q.delete('msg');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  setTimeout(() => alert(text), 300);
})();

