// Ограничитель накрутки счётчиков: одно действие на ключ в течение окна
function makeDedupe(ttlMs) {
  const m = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, t] of m) if (n - t > ttlMs) m.delete(k); }, 5 * 60 * 1000).unref();
  return (key) => {
    const n = Date.now();
    const t = m.get(key);
    if (t && n - t < ttlMs) return false;
    m.set(key, n);
    return true;
  };
}
module.exports = { makeDedupe };
