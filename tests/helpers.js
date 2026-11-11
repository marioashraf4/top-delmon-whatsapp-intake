'use strict';
const { openStore } = require('../src/store');
const { createHandler } = require('../src/handler');
const { silentLogger } = require('../src/log');

const baseConfig = {
  leaseMs: 60000, maxAttempts: 8, emailKeyWindowMs: 23 * 3600 * 1000,
  appSecret: 'test-secret', verifyToken: 'test-verify',
};

/** Fakes that record calls. `script` lets a test override the next results. */
function makeServices() {
  const s = {
    emails: [], replies: [],
    mailResults: [], replyResults: [], mailDelayMs: 0,
    mailer: {
      async send(args) {
        s.emails.push(args);
        if (s.mailDelayMs) await new Promise((r) => setTimeout(r, s.mailDelayMs));
        return s.mailResults.shift() || { ok: true, id: `re_${s.emails.length}` };
      },
    },
    whatsapp: {
      async sendText(to, body) {
        s.replies.push({ to, body });
        return s.replyResults.shift() || { ok: true };
      },
    },
  };
  return s;
}

function setup(overrides = {}) {
  const svc = makeServices();
  const store = openStore(':memory:');
  const state = { now: 1_800_000_000_000 };
  const config = { ...baseConfig, ...overrides };
  const handler = createHandler({ store, mailer: svc.mailer, whatsapp: svc.whatsapp, config, log: silentLogger, clock: () => state.now });
  return { svc, store, state, handler, config };
}

const msg = (over = {}) => ({
  from: '97336000000', id: 'wamid.ABC', timestamp: '1', type: 'text',
  text: { body: 'Please renew. My email is fatima@example.com' }, ...over,
});
const contacts = [{ profile: { name: 'Fatima Ali' }, wa_id: '97336000000' }];

module.exports = { setup, msg, contacts, makeServices, baseConfig };
