/* Дополнительные возможности: караоке (LRC), история, админ-панель, жалобы, фильтры,
   сброс пароля, Media Session, подсказка тональности, PWA. Использует глобалы из app.js. */
(function () {
  'use strict';
  const T = (k) => window.I18N.t(k);
  const $ = (id) => document.getElementById(id);
  const post = (url, body) => fetch(API + url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const toast = (msg) => {
    const el = document.createElement('div');
    el.className = 'xm-toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4000);
  };

  // ---------- подсказка тональности ----------
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function transposeKey(key, semis) {
    const m = /^\s*([A-Ga-g])([#b♯♭]?)(m|min|M|maj)?\s*$/.exec(String(key || ''));
    if (!m) return null;
    const flat = m[2] === 'b' || m[2] === '♭';
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : flat ? -1 : 0;
    const idx = ((NAT[m[1].toUpperCase()] + acc + Math.round(semis)) % 12 + 12) % 12;
    const minor = m[3] === 'm' || m[3] === 'min';
    return (flat ? FLAT : SHARP)[idx] + (minor ? 'm' : '');
  }
  function keyLine(key, semis) {
    if (!key) return '';
    const to = transposeKey(key, semis);
    if (!to || !semis) return `${T('key_now')}: ${key}`;
    const frac = Math.abs(semis - Math.round(semis)) > 0.01;
    return `${T('key_now')}: ${key} → ${frac ? '≈' : ''}${to} (${semis > 0 ? '+' : ''}${semis})`;
  }

  // ---------- LRC-караоке ----------
  // Субтитры SRT/VTT: «00:00:32,570 --> 00:00:39,410» + строки текста
  const SUB_TIME = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const subSec = (h, m, sec, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(sec) + Number('0.' + ms);
  const isSubtitles = (text) => String(text || '').split(/\r?\n/).some(r => SUB_TIME.test(r));
  function parseSubtitles(text) {
    const blocks = []; let cur = null;
    const flush = () => {
      if (cur) blocks.push({ t: cur.t, end: cur.end, text: cur.txt.join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim() });
      cur = null;
    };
    for (const row of String(text).replace(/^\ufeff/, '').split(/\r?\n/)) {
      const m = SUB_TIME.exec(row);
      if (m) { flush(); cur = { t: subSec(m[1], m[2], m[3], m[4]), end: subSec(m[5], m[6], m[7], m[8]), txt: [] }; continue; }
      if (!cur) continue;
      if (!row.trim()) { flush(); continue; }
      cur.txt.push(row.trim());
    }
    flush();
    blocks.sort((x, y) => x.t - y.t);
    const out = [];
    blocks.forEach((b, i) => {
      out.push({ t: b.t, text: b.text });
      const next = blocks[i + 1];
      if (!next || next.t - b.end > 4) out.push({ t: b.end, text: '' }); // пауза / проигрыш
    });
    return out;
  }
  const lrcStamp = (t) => {
    const cs = Math.max(0, Math.round(t * 100));
    const p2 = (n) => String(n).padStart(2, '0');
    return `[${p2(Math.floor(cs / 6000))}:${p2(Math.floor((cs % 6000) / 100))}.${p2(cs % 100)}]`;
  };
  const srtToLrc = (text) => parseSubtitles(text).map(l => lrcStamp(l.t) + l.text).join('\n');

  function parseLrc(text) {
    if (isSubtitles(text)) return parseSubtitles(text);
    const lines = []; let offset = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const off = /^\s*\[offset:\s*(-?\d+)\s*\]/i.exec(raw);
      if (off) { offset = Number(off[1]) / 1000; continue; }
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.,:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const txt = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{2}(?:[.,:]\d{1,3})?>/g, '').trim();
      for (const s of stamps) {
        const frac = s[3] ? Number('0.' + s[3]) : 0;
        lines.push({ t: Number(s[1]) * 60 + Number(s[2]) + frac - offset, text: txt });
      }
    }
    return lines.sort((a, b) => a.t - b.t);
  }
  let K = null; // состояние караоке на открытой странице трека
  function seekTo(sec) {
    pauseOffset = Math.max(0, Math.min(sec, durationSec || sec));
    if (isPlaying && toneBuffer) startGrainPlayback(pauseOffset);
    else if (htmlAudio) htmlAudio.currentTime = pauseOffset;
    else updateProgressUI(pauseOffset);
  }
  function mountKaraoke(track) {
    const box = $('karaoke-lines');
    if (!box) { K = null; return; }
    const lines = parseLrc(track.lyrics_lrc);
    if (!lines.length) {
      const b = $('karaoke'); K = null;
      if (b && $('ed-lrc')) box.innerHTML = '<p class="form-error">В тексте не найдено отметок времени вида [мм:сс.xx] — подсветка не сработает.</p>';
      else if (b) b.remove();
      return;
    }
    box.innerHTML = lines.map((l, i) => `<div class="k-line" data-i="${i}">${esc(l.text) || '♪'}</div>`).join('');
    box.onclick = (e) => {
      const el = e.target.closest('.k-line'); if (!el || !currentTrack || currentTrack.id !== track.id) return;
      seekTo(lines[+el.dataset.i].t);
    };
    K = { id: track.id, lines, box, active: -1 };
  }
  function onTime(elapsed) {
    if (window.navigator.mediaSession && durationSec && Date.now() - (onTime.ms || 0) > 1000) {
      onTime.ms = Date.now();
      try {
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setPositionState({ duration: durationSec, playbackRate: Math.max(0.1, tempo / 100), position: Math.min(elapsed, durationSec) });
      } catch (_) {}
    }
    if (!K || !currentTrack || currentTrack.id !== K.id || !document.body.contains(K.box)) return;
    let lo = 0, hi = K.lines.length - 1, idx = -1;
    const t = elapsed + 0.15;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (K.lines[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === K.active) return;
    K.active = idx;
    K.box.querySelectorAll('.k-line').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.classList.toggle('done', i < idx);
    });
    const el = K.box.querySelector('.k-line.active');
    if (el) K.box.scrollTo({ top: el.offsetTop - K.box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }
  // Читает файл как UTF-8, а если не получилось — как Windows-1251 (старые русские файлы)
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (_) { return new TextDecoder('windows-1251').decode(buf); }
  }
  function bindLrcFile(fileInput, textarea) {
    if (!fileInput || !textarea) return;
    fileInput.accept = '.lrc,.txt,.srt,.vtt';
    fileInput.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 300 * 1024) return alert('Файл слишком большой');
      const txt = decodeText(await f.arrayBuffer()).replace(/^\ufeff/, '');
      if (isSubtitles(txt)) { textarea.value = srtToLrc(txt); toast('Субтитры преобразованы в формат LRC'); }
      else textarea.value = txt;
      e.target.value = '';
    };
  }

  // ---------- воспроизведение: счётчик, история, Media Session ----------
  const HKEY = 'xminyc_history';
  const readHistory = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (_) { return []; } };
  function pushHistory(t) {
    try {
      const list = readHistory().filter(x => x.id !== t.id);
      list.unshift({ id: t.id, title: t.title, artist: t.artist, at: Date.now() });
      localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 50)));
    } catch (_) {}
  }
  function onTrackStart(track) {
    post(`/tracks/${track.id}/play`).catch(() => {});
    pushHistory(track);
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title, artist: track.artist,
        artwork: track.cover ? [{ src: new URL(track.cover, location.origin).href }] : []
      });
      const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} };
      h('play', () => { if (!isPlaying) togglePlay(); });
      h('pause', () => { if (isPlaying) stopAudio(); });
      h('previoustrack', () => $('p-prev').click());
      h('nexttrack', () => $('p-next').click());
      h('seekto', (d) => seekTo(d.seekTime));
    } catch (_) {}
  }
  function onPause() { if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch (_) {} } }
  function onEnded() {
    onPause();
    if (currentIndex >= 0 && currentIndex < tracks.length - 1) playTrackById(tracks[currentIndex + 1].id, currentIndex + 1, { keepFx: true });
  }

  // ---------- фильтры поиска ----------
  async function filtersBarHTML(f) {
    let o = { keys: [], genres: [], langs: [], types: [] };
    try { o = await (await fetch(`${API}/tracks/filters`)).json(); } catch (_) {}
    const sel = (name, label, vals, cur, fmt) => `<label class="flt"><span>${esc(label)}</span><select data-flt="${name}">
      <option value="">${esc(T('filter_all'))}</option>${vals.map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(fmt ? fmt(v) : v)}</option>`).join('')}</select></label>`;
    return `<div class="filters-bar">
      ${sel('key', T('filter_key'), o.keys, f.key)}${sel('genre', T('filter_genre'), o.genres, f.genre)}
      ${sel('lang', T('filter_lang'), o.langs, f.lang)}${sel('type', T('filter_type'), o.types, f.type, typeLabel)}
      <button type="button" class="btn btn-outline" id="flt-reset">${esc(T('filter_reset'))}</button></div>`;
  }
  function bindFilters(root, q) {
    const go = () => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      root.querySelectorAll('[data-flt]').forEach(s => { if (s.value) p.set(s.dataset.flt, s.value); });
      navigate('/search' + (p.toString() ? '?' + p : ''));
    };
    root.querySelectorAll('[data-flt]').forEach(s => { s.onchange = go; });
    const r = $('flt-reset'); if (r) r.onclick = () => navigate('/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
  }

  // ---------- подтверждение email ----------
  function verifyNoticeHTML() {
    if (!currentUser || !currentUser.email || currentUser.emailVerified) return '';
    return `<div class="verify-notice"><span>${esc(T('verify_notice'))}</span> <button type="button" class="btn btn-outline" id="verify-resend">${esc(T('verify_resend'))}</button></div>`;
  }
  function bindVerifyNotice(root) {
    const b = root.querySelector('#verify-resend'); if (!b) return;
    b.onclick = async () => {
      b.disabled = true;
      const r = await post('/auth/resend-verification');
      toast(r.ok ? T('verify_sent') : (await r.json()).error || 'Ошибка');
    };
  }

  // ---------- страницы ----------
  const page = (inner) => `<div class="container settings-page">${inner}</div>`;

  function renderHistoryPage(app) {
    const list = readHistory();
    tracks = list.map(h => ({ id: h.id, title: h.title, artist: h.artist }));
    app.innerHTML = `<div class="container"><h1 class="page-title">${esc(T('history'))}</h1>
      ${list.length ? `<div class="tracks">${list.map((h, i) => `<div class="track" data-play="${h.id}" data-idx="${i}">
        <div class="track-num">${i + 1}</div>
        <div class="track-info"><div class="track-title-line"><a class="track-title" href="/track/${h.id}">${esc(h.title)}</a></div>
        <div class="track-sub">${artistLinks(h.artist)}</div></div>
        <div class="track-meta"><button type="button" class="track-play-icon" data-play="${h.id}" data-idx="${i}" aria-label="Play">▶</button></div></div>`).join('')}</div>
        <p><button type="button" class="btn btn-outline" id="hist-clear">${esc(T('history_clear'))}</button></p>`
      : `<p class="empty">${esc(T('history_empty'))}</p>`}</div>`;
    bindPlayButtons(app); bindArtistLinks(app);
    const c = $('hist-clear'); if (c) c.onclick = () => { localStorage.removeItem(HKEY); renderHistoryPage(app); };
  }

  function renderTermsPage(app) {
    app.innerHTML = page(`<h1>Правила использования</h1>
      <p class="field-hint">Редакция от ${esc(new Date().toLocaleDateString('ru-RU'))}</p>
      <h3>1. О сайте</h3><p>Сайт предназначен для обмена минусовыми фонограммами для личного некоммерческого использования (караоке, обучение, репетиции).</p>
      <h3>2. Загружаемый контент</h3><p>Загружая файл, вы подтверждаете, что имеете право его распространять либо что он распространяется на условиях, допускающих такое использование. Запрещено загружать контент, нарушающий законодательство, права третьих лиц, а также оскорбительные и вредоносные материалы. Все новые треки проходят модерацию.</p>
      <h3>3. Авторские права</h3><p>Если вы правообладатель и считаете, что материал нарушает ваши права, направьте заявление через <a href="/copyright">специальную форму</a>. Мы рассмотрим его и при подтверждении нарушения удалим материал.</p>
      <h3>4. Аккаунт</h3><p>Вы отвечаете за сохранность пароля и действия в своём аккаунте. Администрация вправе заблокировать аккаунт при нарушении правил.</p>
      <h3>5. Персональные данные</h3><p>Мы храним логин, email (если указан) и данные профиля для работы сайта. Данные не передаются третьим лицам, кроме случаев, предусмотренных законом.</p>
      <h3>6. Ответственность</h3><p>Сайт предоставляется «как есть». Администрация не гарантирует бесперебойную работу и не отвечает за контент, загруженный пользователями, до получения обоснованного заявления.</p>`);
  }

  function renderCopyrightPage(app, params) {
    const base = location.origin + (params.track ? '/track/' + encodeURIComponent(params.track) : '');
    app.innerHTML = page(`<h1>${esc(T('report_copyright'))}</h1>
      <p>Если вы правообладатель и считаете, что трек нарушает ваши права, заполните форму. Мы свяжемся с вами по указанному email.</p>
      <form id="cr-form">
        <input name="name" placeholder="Ваше имя / организация *" required maxlength="200">
        <input name="email" type="email" placeholder="Email для связи *" required maxlength="200">
        <input name="track_url" placeholder="Ссылка на трек на нашем сайте *" required maxlength="500" value="${esc(params.track ? base : '')}">
        <textarea name="message" rows="6" required minlength="20" maxlength="3000" placeholder="Какое произведение нарушено и на каком основании вам принадлежат права *"></textarea>
        <label class="status-radio"><input type="checkbox" name="confirm" required> Подтверждаю, что информация достоверна и я уполномочен действовать от имени правообладателя</label>
        <p class="form-error" id="cr-error" hidden></p><p class="form-ok" id="cr-ok" hidden>Заявление отправлено. Спасибо!</p>
        <button class="btn btn-primary btn-full" type="submit">Отправить</button>
      </form>`);
    $('cr-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $('cr-error'); err.hidden = true;
      const r = await post('/reports/copyright', { name: fd.get('name'), email: fd.get('email'), track_url: fd.get('track_url'), message: fd.get('message'), confirm: !!fd.get('confirm') });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || 'Ошибка'; err.hidden = false; return; }
      e.target.reset(); $('cr-ok').hidden = false;
    };
  }

  function renderResetPage(app, params) {
    app.innerHTML = page(`<h1>${esc(T('reset_title'))}</h1>
      <form id="rs-form"><input type="password" id="rs-pass" minlength="8" maxlength="200" required placeholder="${esc(T('reset_new'))}">
      <p class="form-error" id="rs-error" hidden></p>
      <button class="btn btn-primary btn-full" type="submit">${esc(T('reset_save'))}</button></form>`);
    $('rs-form').onsubmit = async (e) => {
      e.preventDefault();
      const r = await post('/auth/reset', { token: params.token || '', password: $('rs-pass').value });
      const d = await r.json();
      if (!r.ok) { const er = $('rs-error'); er.textContent = d.error || 'Ошибка'; er.hidden = false; return; }
      toast(T('reset_done')); navigate('/'); openModal('auth-modal');
    };
  }

  // ----- админ-панель -----
  function barChart(rows, label) {
    const map = Object.fromEntries(rows.map(r => [r.d, r.c]));
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push([d, map[d] || 0]); }
    const max = Math.max(1, ...days.map(x => x[1]));
    return `<div class="adm-chart"><div class="adm-chart-title">${esc(label)} <small>(30 дн., всего ${days.reduce((s, x) => s + x[1], 0)})</small></div>
      <div class="adm-bars">${days.map(([d, c]) => `<div class="adm-bar" title="${d}: ${c}" style="height:${Math.max(2, Math.round(c / max * 100))}%"></div>`).join('')}</div></div>`;
  }
  async function admStats(box) {
    const r = await fetch(`${API}/admin/stats`, { credentials: 'include' });
    if (!r.ok) { box.innerHTML = '<p class="empty">Ошибка</p>'; return; }
    const s = await r.json();
    const card = (v, l) => `<div class="adm-card"><div class="adm-num">${esc(v)}</div><div class="adm-label">${esc(l)}</div></div>`;
    box.innerHTML = `<div class="adm-cards">
      ${card(s.users, 'Пользователей')}${card(s.arrangers, 'Аранжировщиков')}${card(s.banned, 'Заблокировано')}
      ${card(s.tracks.approved || 0, 'Треков одобрено')}${card(s.tracks.pending || 0, 'На модерации')}${card(s.tracks.rejected || 0, 'Отклонено')}
      ${card(s.plays, 'Прослушиваний')}${card(s.downloads, 'Скачиваний')}${card(s.likes, 'Лайков')}${card(s.artists, 'Исполнителей')}${card(s.reports_open, 'Открытых жалоб')}</div>
      ${barChart(s.registrations, 'Регистрации')}${barChart(s.uploads, 'Загрузки треков')}
      <h3>Топ-10 по прослушиваниям</h3>
      <table class="adm-table"><tr><th>Трек</th><th>▶</th><th>⬇</th><th>♥</th></tr>
      ${s.top_tracks.map(t => `<tr><td><a href="/track/${t.id}">${esc(t.artist)} — ${esc(t.title)}</a></td><td>${t.plays}</td><td>${t.downloads}</td><td>${t.likes_count}</td></tr>`).join('')}</table>`;
  }
  async function admUsers(box, q) {
    const r = await fetch(`${API}/admin/users?limit=100&q=${encodeURIComponent(q || '')}`, { credentials: 'include' });
    const d = await r.json();
    box.innerHTML = `<div class="adm-search"><input id="adm-uq" placeholder="Поиск по логину или email" value="${esc(q || '')}"><button class="btn btn-outline" id="adm-uq-go">Найти</button></div>
      <p class="field-hint">Всего: ${d.total}</p>
      <div class="adm-scroll"><table class="adm-table"><tr><th>ID</th><th>Логин</th><th>Email</th><th>Треков</th><th>Создан</th><th></th></tr>
      ${d.users.map(u => `<tr class="${u.is_banned ? 'adm-banned' : ''}"><td>${u.id}</td>
        <td><a href="/user/${encodeURIComponent(u.username)}">${esc(u.username)}</a>${u.is_admin ? ' 👑' : ''}${u.is_arranger ? ' 🎹' : ''}</td>
        <td>${esc(u.email || '—')} ${u.email ? (u.email_verified ? '✓' : '<span title="не подтверждён">?</span>') : ''}</td>
        <td>${u.tracks_count}</td><td>${esc((u.created_at || '').slice(0, 10))}</td>
        <td>${u.is_admin ? '' : `<button class="btn-mod ${u.is_banned ? 'btn-mod-ok' : 'btn-mod-no'}" data-ban="${u.id}" data-state="${u.is_banned ? 0 : 1}">${u.is_banned ? 'Разблокировать' : 'Заблокировать'}</button>
          <button class="btn-mod btn-mod-ok" data-arr="${u.id}" data-state="${u.is_arranger ? 0 : 1}">${u.is_arranger ? '− аранжировщик' : '+ аранжировщик'}</button>`}</td></tr>`).join('')}</table></div>`;
    const go = () => admUsers(box, $('adm-uq').value.trim());
    $('adm-uq-go').onclick = go; $('adm-uq').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    box.querySelectorAll('[data-ban]').forEach(b => b.onclick = async () => {
      if (b.dataset.state === '1' && !confirm('Заблокировать пользователя? Его сессии будут завершены.')) return;
      const r2 = await post(`/admin/users/${b.dataset.ban}/ban`, { banned: b.dataset.state === '1' });
      if (r2.ok) go(); else alert((await r2.json()).error || 'Ошибка');
    });
    box.querySelectorAll('[data-arr]').forEach(b => b.onclick = async () => {
      const r2 = await post(`/arrangers/users/${b.dataset.arr}/role`, { is_arranger: b.dataset.state === '1' });
      if (r2.ok) go(); else alert((await r2.json()).error || 'Ошибка');
    });
  }
  async function admReports(box, status) {
    const r = await fetch(`${API}/reports?status=${status || ''}`, { credentials: 'include' });
    const d = await r.json();
    box.innerHTML = `<div class="adm-search"><button class="btn ${status === 'open' ? 'btn-primary' : 'btn-outline'}" data-rs="open">Открытые</button>
      <button class="btn ${!status ? 'btn-primary' : 'btn-outline'}" data-rs="">Все</button></div>
      <div class="mod-list">${d.reports.map(x => `<div class="mod-card ${x.type === 'copyright' ? 'adm-copyright' : ''}"><div class="mod-card-head"><div>
        <strong>#${x.id} · ${x.type === 'copyright' ? '⚖ Правообладатель' : 'Исполнитель'}</strong>
        <span class="mod-hint mod-hint-inline">${esc(x.status)}</span>
        <div class="mod-meta">${esc((x.created_at || '').replace('T', ' ').slice(0, 16))}</div>
        ${x.type === 'artist' ? `<p>Исполнитель: <a href="/artist/${encodeURIComponent(x.artist || '')}">${esc(x.artist)}</a>${x.wrong ? ' — неверно: ' + [x.wrong.photo ? 'фото' : '', x.wrong.bio ? 'описание' : ''].filter(Boolean).join(', ') : ''}</p>`
          : `<p>${esc(x.contact_name)} &lt;${esc(x.contact_email)}&gt;<br>Трек: ${x.track_id ? `<a href="/track/${x.track_id}">#${x.track_id}</a> ` : ''}${esc(x.track_url || '')}</p>`}
        <p class="profile-bio">${esc(x.message || '')}</p></div>
        ${x.status === 'open' ? `<div class="mod-actions"><button class="btn-mod btn-mod-ok" data-done="${x.id}">Обработано</button><button class="btn-mod btn-mod-no" data-dismiss="${x.id}">Отклонить</button></div>` : ''}
      </div></div>`).join('') || '<p class="empty">Жалоб нет</p>'}</div>`;
    box.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => admReports(box, b.dataset.rs));
    const resolve = (id, st) => post(`/reports/${id}/resolve`, { status: st }).then(() => admReports(box, status));
    box.querySelectorAll('[data-done]').forEach(b => b.onclick = () => resolve(b.dataset.done, 'done'));
    box.querySelectorAll('[data-dismiss]').forEach(b => b.onclick = () => resolve(b.dataset.dismiss, 'dismissed'));
  }
  async function renderAdminPage(app, params) {
    if (!isCurrentAdmin()) { app.innerHTML = `<div class="container"><p class="empty">${esc(T('admin_only'))}</p></div>`; return; }
    const tab = ['stats', 'users', 'reports'].includes(params.tab) ? params.tab : 'stats';
    app.innerHTML = `<div class="container"><h1 class="page-title">${esc(T('admin_panel'))}</h1>
      <div class="home-tabs">
        ${[['stats', 'Статистика'], ['users', 'Пользователи'], ['reports', 'Жалобы']].map(([k, l]) => `<a class="home-tab ${tab === k ? 'active' : ''}" href="/admin?tab=${k}">${l}</a>`).join('')}
        <a class="home-tab" href="/moderation">Модерация</a><a class="home-tab" href="/arranger-apps">Заявки</a>
      </div><div id="adm-box"><p class="empty">…</p></div></div>`;
    const box = $('adm-box');
    if (tab === 'stats') await admStats(box); else if (tab === 'users') await admUsers(box, ''); else await admReports(box, 'open');
  }

  // ---------- маршрутизатор дополнительных страниц ----------
  async function route(parts, params, app) {
    switch (parts[0]) {
      case 'history': renderHistoryPage(app); return true;
      case 'terms': renderTermsPage(app); return true;
      case 'copyright': renderCopyrightPage(app, params); return true;
      case 'reset': renderResetPage(app, params); return true;
      case 'admin': await renderAdminPage(app, params); return true;
      default: return false;
    }
  }

  // ---------- восстановление пароля в окне входа ----------
  let forgotMode = false;
  function setForgot(on) {
    forgotMode = on;
    const pass = $('auth-password'), user = $('auth-username'), email = $('auth-email');
    $('auth-title').textContent = on ? T('forgot_title') : (isRegister ? (T('auth_register') || 'Регистрация') : T('auth_login'));
    $('auth-submit').textContent = on ? T('forgot_send') : (isRegister ? (T('auth_register_btn') || T('auth_submit')) : T('nav_login'));
    pass.hidden = on; pass.required = !on;
    user.hidden = on; user.required = !on;
    email.hidden = !on && !isRegister;
    if (on) { email.hidden = false; email.required = true; email.placeholder = T('forgot_ph'); } else { email.required = false; email.placeholder = 'Email'; }
    $('auth-forgot').textContent = on ? T('back_to_login') : T('forgot_password');
    $('auth-error').hidden = true;
  }
  async function authIntercept() {
    if (!forgotMode) return false;
    const email = $('auth-email').value.trim();
    const err = $('auth-error');
    const r = await post('/auth/forgot', { email });
    const d = await r.json();
    err.textContent = r.ok ? (d.message || T('forgot_sent')) : (d.error || 'Ошибка');
    err.hidden = false; err.classList.toggle('form-ok', r.ok);
    return true;
  }
  function initAuthExtras() {
    const f = $('auth-forgot'); if (!f) return;
    f.onclick = (e) => { e.preventDefault(); e.stopPropagation(); $('auth-error').classList.remove('form-ok'); setForgot(!forgotMode); };
    $('auth-toggle').addEventListener('click', () => { if (forgotMode) setForgot(false); });
    document.querySelectorAll('[data-close="auth-modal"]').forEach(b => b.addEventListener('click', () => { if (forgotMode) setForgot(false); $('auth-error').classList.remove('form-ok'); }));
  }

  // ---------- параметры URL после редиректов (verify / OAuth) и PWA ----------
  function handleUrlFlags() {
    const p = new URLSearchParams(location.search);
    if (p.has('verify')) { toast(p.get('verify') === 'ok' ? T('verify_ok') : T('verify_fail')); p.delete('verify'); history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '')); }
  }
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  initAuthExtras(); handleUrlFlags();

  window.XM_EXTRA = { route, parseLrc, srtToLrc, mountKaraoke, onTime, onTrackStart, onPause, onEnded, keyLine, transposeKey, bindLrcFile, seekTo,
    filtersBarHTML, bindFilters, verifyNoticeHTML, bindVerifyNotice, authIntercept, toast };
})();