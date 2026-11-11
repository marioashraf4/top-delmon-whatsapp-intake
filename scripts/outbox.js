'use strict';
// Usage: node scripts/outbox.js   -> counts what the MOCK services "sent" (data/mock-outbox.jsonl)
const fs = require('node:fs');
const { loadDotEnv } = require('../src/config');
loadDotEnv();
const file = process.env.MOCK_OUTBOX_PATH || './data/mock-outbox.jsonl';
const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const emails = rows.filter((r) => r.kind === 'email');
const replies = rows.filter((r) => r.kind === 'whatsapp');
console.log(`emails sent: ${emails.length} (distinct idempotency keys: ${new Set(emails.map((e) => e.idempotencyKey)).size})`);
console.log(`whatsapp replies sent: ${replies.length}`);
for (const r of rows) console.log(' -', r.kind, r.kind === 'email' ? `to *@${r.toDomain}` : `"${r.reply}..."`);
