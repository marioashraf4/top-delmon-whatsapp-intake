'use strict';
// Usage: node scripts/send-webhook.js <payload.json> [--sig=valid|invalid|missing] [--url=http://localhost:3000/webhook]
// Reads META_APP_SECRET from your local .env, signs the file's exact bytes, POSTs them. Never prints the secret.
const fs = require('node:fs');
const { loadDotEnv } = require('../src/config');
const { sign } = require('../src/signature');

(async () => {
  loadDotEnv();
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const opt = (name, d) => (args.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${d}`).split('=').slice(1).join('=');
  const mode = opt('sig', 'valid');
  const url = opt('url', `http://localhost:${process.env.PORT || 3000}/webhook`);
  if (!file) { console.error('Usage: node scripts/send-webhook.js <payload.json> [--sig=valid|invalid|missing]'); process.exit(2); }
  const secret = (process.env.META_APP_SECRET || '').trim();
  if (!secret) { console.error('META_APP_SECRET is not set (put it in .env).'); process.exit(2); }

  const body = fs.readFileSync(file); // exact bytes, signed and sent unchanged
  const headers = { 'Content-Type': 'application/json' };
  if (mode === 'valid') headers['X-Hub-Signature-256'] = sign(body, secret);
  else if (mode === 'invalid') headers['X-Hub-Signature-256'] = sign(body, secret + 'x');
  else if (mode !== 'missing') { console.error('--sig must be valid, invalid or missing'); process.exit(2); }

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    console.log(`HTTP ${res.status} (${mode} signature)`, (await res.text()).slice(0, 300));
  } catch (e) {
    console.error('Request failed - is the server running?', e.cause?.code || e.message);
    process.exit(1);
  }
})();
