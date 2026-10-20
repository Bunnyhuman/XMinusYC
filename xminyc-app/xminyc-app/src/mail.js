const nodemailer = require('nodemailer');
const cfg = require('./config');

let transport = null;
function isConfigured() { return !!(cfg.SMTP.user && cfg.SMTP.pass); }
function getTransport() {
  if (!isConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure,
      auth: { user: cfg.SMTP.user, pass: cfg.SMTP.pass }
    });
  }
  return transport;
}
async function send({ to, subject, text, replyTo }) {
  const t = getTransport();
  if (!t) return { ok: false, reason: 'smtp_not_configured' };
  if (!to) return { ok: false, reason: 'no_recipient' };
  try {
    await t.sendMail({ from: cfg.SMTP.from || `"${cfg.SITE_NAME}" <${cfg.SMTP.user}>`, to, subject, text, replyTo });
    return { ok: true };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}
module.exports = { send, isConfigured };
