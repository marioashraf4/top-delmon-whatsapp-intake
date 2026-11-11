'use strict';

// Local-only fakes used by `npm run start:mock`. They never touch the network. Each "send" is appended
// to a local JSONL outbox (no message text, no full email address) so you can count what would be sent.
// The mock mailer deliberately does NOT deduplicate: duplicate protection must come from the app itself.
const fs = require('node:fs');
const path = require('node:path');

function appender(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return (record) => fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n');
}

function createMockServices(outboxPath) {
  const append = appender(outboxPath);
  let n = 0;
  return {
    mailer: {
      async send({ to, idempotencyKey }) {
        append({ kind: 'email', idempotencyKey, toDomain: to.split('@')[1] });
        return { ok: true, id: `mock-email-${++n}` };
      },
    },
    whatsapp: {
      async sendText(to, body) {
        append({ kind: 'whatsapp', toSuffix: String(to).slice(-3), reply: body.slice(0, 40) });
        return { ok: true };
      },
    },
  };
}

module.exports = { createMockServices };
