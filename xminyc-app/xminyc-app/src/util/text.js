// Нормализация и транслитерация для нечёткого поиска (ё/е, регистр, ru<->lat)
const MAP = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',і:'i',ї:'yi',є:'e',ґ:'g',ў:'u' };

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function translit(s) {
  return normalize(s).split('').map(ch => (ch in MAP ? MAP[ch] : ch)).join('');
}
function searchText(...parts) {
  const n = normalize(parts.filter(Boolean).join(' '));
  const t = translit(n);
  return t === n ? n : n + ' ' + t;
}
function searchVariants(q) {
  const n = normalize(q);
  const t = translit(n);
  return [...new Set([n, t].filter(Boolean))];
}
module.exports = { normalize, translit, searchText, searchVariants };
