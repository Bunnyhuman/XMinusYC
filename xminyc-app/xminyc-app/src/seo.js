// Серверная подстановка мета-тегов (title/description/OpenGraph) и текстового fallback для страниц.
// SPA на клиенте всё равно перерисует #app; боты и шаринг получают осмысленный HTML.
const fs = require('fs');
const path = require('path');
const store = require('./db/store');
const cfg = require('./config');

const TEMPLATE_FILE = path.join(cfg.PUBLIC_DIR, 'index.html');
let template = null;
const getTemplate = () => template || (template = fs.readFileSync(TEMPLATE_FILE, 'utf8'));

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const abs = (u) => !u ? '' : /^https?:\/\//.test(u) ? u : cfg.BASE_URL + u;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function pageMeta(reqPath, user) {
  const site = cfg.SITE_NAME;
  const base = { title: `${site} — минусовки во всех тональностях`, desc: 'Слушайте, меняйте тональность и темп, скачивайте минусовки. Караоке с текстами песен.', image: abs('/logo.png'), type: 'website', noindex: false, body: '' };
  let m;
  if ((m = reqPath.match(/^\/track\/(\d+)$/))) {
    const t = store.findTrack(m[1]);
    if (t && t.status !== 'rejected') {
      const name = `${t.artist} — ${t.title}`;
      return {
        ...base, title: `${name} — минусовка | ${site}`,
        desc: clip(t.lyrics ? `Минусовка «${t.title}» (${t.artist}). ${t.lyrics}` : `Скачать и слушать минусовку «${t.title}» — ${t.artist}. Тональность ${t.key || '—'}, ${t.duration || ''}.`, 200),
        image: abs(t.cover) || base.image, type: 'music.song', noindex: t.status !== 'approved',
        body: `<h1>${esc(name)}</h1><p>Минусовка. Тональность: ${esc(t.key || '—')}. Длительность: ${esc(t.duration || '—')}.</p>${t.lyrics ? `<pre>${esc(clip(t.lyrics, 2000))}</pre>` : ''}`,
        ld: { '@context': 'https://schema.org', '@type': 'MusicRecording', name: t.title, byArtist: { '@type': 'MusicGroup', name: t.artist }, duration: t.duration, url: `${cfg.BASE_URL}/track/${t.id}` }
      };
    }
    return { ...base, noindex: true };
  }
  if ((m = reqPath.match(/^\/artist\/(.+)$/))) {
    let name; try { name = decodeURIComponent(m[1]); } catch (_) { return base; }
    const a = store.findArtist(name);
    const tracks = store.listTracksByArtist(name).slice(0, 50);
    if (a && tracks.length) {
      return {
        ...base, title: `${a.name} — минусовки | ${site}`, desc: clip(a.bio || `Минусовки исполнителя ${a.name}: ${tracks.slice(0, 5).map(t => t.title).join(', ')}`, 200),
        image: abs(a.photo) || base.image,
        body: `<h1>${esc(a.name)}</h1><ul>${tracks.map(t => `<li><a href="/track/${t.id}">${esc(t.title)}</a></li>`).join('')}</ul>`
      };
    }
    return { ...base, noindex: true };
  }
  if ((m = reqPath.match(/^\/user\/(.+)$/))) {
    let name; try { name = decodeURIComponent(m[1]); } catch (_) { return base; }
    const u = store.findUserByUsername(name);
    if (u) return { ...base, title: `${u.display_name || u.username} | ${site}`, desc: clip(u.bio || `Профиль ${u.username} на ${site}`, 200), image: abs(u.avatar) || base.image };
  }
  const noindex = /^\/(settings|upload|moderation|admin|collections?|history|reset|arranger-apps?|arranger-apply)/.test(reqPath);
  return { ...base, noindex, user };
}

function render(reqPath, user) {
  const m = pageMeta(reqPath, user);
  const url = cfg.BASE_URL + (reqPath === '/' ? '' : reqPath);
  const tags = [
    `<meta name="description" content="${esc(m.desc)}">`,
    m.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:site_name" content="${esc(cfg.SITE_NAME)}">`,
    `<meta property="og:type" content="${m.type}">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(m.image)}">`,
    '<meta name="twitter:card" content="summary">',
    m.ld ? `<script type="application/ld+json">${JSON.stringify(m.ld).replace(/</g, '\\u003c')}</script>` : ''
  ].filter(Boolean).join('\n  ');
  let html = getTemplate()
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace('</head>', `  ${tags}\n</head>`);
  if (m.body) html = html.replace('<main class="main" id="app"></main>', `<main class="main" id="app"><div class="container seo-fallback">${m.body}</div></main>`);
  return html;
}

function sitemap() {
  const d = store.sitemapData();
  const u = (loc, lastmod) => `<url><loc>${esc(cfg.BASE_URL + loc)}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    u('/'), u('/novinki'), u('/top50'), u('/arrangers'),
    ...d.tracks.map(t => u('/track/' + t.id, t.created_at)),
    ...d.artists.map(n => u('/artist/' + encodeURIComponent(n))),
    ...d.users.map(n => u('/user/' + encodeURIComponent(n)))
  ].join('\n')}\n</urlset>`;
}
const robots = () => `User-agent: *\nDisallow: /api/\nDisallow: /settings\nDisallow: /upload\nAllow: /\n\nSitemap: ${cfg.BASE_URL}/sitemap.xml\n`;
module.exports = { render, sitemap, robots };
