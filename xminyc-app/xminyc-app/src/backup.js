const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./db/store');

async function runBackup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(cfg.BACKUP_DIR, `xminyc-${stamp}.sqlite`);
  await store.backupTo(file);
  const all = fs.readdirSync(cfg.BACKUP_DIR).filter(f => /^xminyc-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - cfg.BACKUP_KEEP))) fs.unlinkSync(path.join(cfg.BACKUP_DIR, old));
  return file;
}
// Ежедневный бэкап БД: первый — через минуту после старта, далее раз в сутки
function schedule() {
  const run = () => runBackup().then(f => console.log('[backup] ok →', path.basename(f))).catch(e => console.error('[backup] fail:', e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 24 * 3600 * 1000).unref();
}
module.exports = { runBackup, schedule };
if (require.main === module) runBackup().then(f => { console.log('Backup:', f); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
