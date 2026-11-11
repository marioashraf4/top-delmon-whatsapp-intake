'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, msg, contacts } = require('./helpers');
const { messageKey } = require('../src/store');
const { REPLIES } = require('../src/handler');

test('happy path: one email (with idempotency key), one accurate reply', async () => {
  const { svc, handler, store } = setup();
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.emails.length, 1);
  assert.equal(svc.emails[0].to, 'fatima@example.com');
  assert.equal(svc.emails[0].idempotencyKey, `wa-confirm-${messageKey('wamid.ABC')}`);
  assert.match(svc.emails[0].html, /Dear Fatima Ali/);
  assert.deepEqual(svc.replies, [{ to: '97336000000', body: REPLIES.accepted }]);
  assert.ok(!/delivered|has been sent/i.test(REPLIES.accepted), 'must not claim delivery');
  const row = store.get(messageKey('wamid.ABC'));
  assert.equal(row.status, 'completed');
  assert.equal(row.email_status, 'accepted');
  assert.ok(!JSON.stringify(row).includes('fatima'), 'no email/PII stored');
});

test('same message delivered again later: no second email or reply', async () => {
  const { svc, handler } = setup();
  await handler.processMessage(msg(), contacts);
  assert.equal(await handler.processMessage(msg(), contacts), 'duplicate');
  assert.equal(svc.emails.length, 1);
  assert.equal(svc.replies.length, 1);
});

test('concurrent duplicate deliveries: exactly one email, other is told to retry', async () => {
  const { svc, handler } = setup();
  svc.mailDelayMs = 30;
  const results = await Promise.all([handler.processMessage(msg(), contacts), handler.processMessage(msg(), contacts), handler.processMessage(msg(), contacts)]);
  assert.deepEqual(results.sort(), ['completed', 'in_progress', 'in_progress']);
  assert.equal(svc.emails.length, 1);
});

test('no email: asks for one, sends no email', async () => {
  const { svc, handler } = setup();
  await handler.processMessage(msg({ id: 'wamid.N', text: { body: 'hello there' } }), contacts);
  assert.equal(svc.emails.length, 0);
  assert.equal(svc.replies[0].body, REPLIES.no_email);
});

test('multiple different emails: asks client to pick one, sends no email', async () => {
  const { svc, handler } = setup();
  await handler.processMessage(msg({ id: 'wamid.M', text: { body: 'a@x.com or b@y.com' } }), contacts);
  assert.equal(svc.emails.length, 0);
  assert.equal(svc.replies[0].body, REPLIES.multiple);
});

test('Resend failure: no success message; retry reuses the SAME key; ends with exactly one accepted email', async () => {
  const { svc, handler, store } = setup();
  svc.mailResults.push({ ok: false, kind: 'retryable', code: 'application_error' });
  assert.equal(await handler.processMessage(msg(), contacts), 'retry');
  assert.equal(svc.replies.length, 0);
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.emails.length, 2); // second call is the retry; real Resend dedupes by key
  assert.equal(svc.emails[0].idempotencyKey, svc.emails[1].idempotencyKey);
  assert.equal(store.get(messageKey('wamid.ABC')).attempts, 2);
  assert.equal(svc.replies.length, 1);
});

test('email accepted but WhatsApp reply fails: retry does NOT resend the email', async () => {
  const { svc, handler } = setup();
  svc.replyResults.push({ ok: false, kind: 'retryable', code: 'timeout' });
  assert.equal(await handler.processMessage(msg(), contacts), 'retry');
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.emails.length, 1);
  assert.equal(svc.replies.length, 2);
});

test('crash after Resend call but before it was recorded: retry within window reuses key', async () => {
  const { svc, handler, store, state } = setup();
  // simulate: process died after marking "sending"; lease later expires
  const key = messageKey('wamid.ABC');
  const c = store.claim(key, { now: state.now, leaseMs: 60000 });
  store.update(key, c.token, { email_status: 'sending', email_attempt_at: state.now }, state.now);
  state.now += 61000;
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.emails.length, 1);
  assert.equal(svc.emails[0].idempotencyKey, `wa-confirm-${key}`);
});

test('unknown outcome AND Resend key window expired: never resend, reply does not promise an email', async () => {
  const { svc, handler, store, state } = setup();
  const key = messageKey('wamid.ABC');
  const c = store.claim(key, { now: state.now, leaseMs: 60000 });
  store.update(key, c.token, { email_status: 'sending', email_attempt_at: state.now }, state.now);
  state.now += 24 * 3600 * 1000;
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.emails.length, 0);
  assert.equal(svc.replies[0].body, REPLIES.unknown);
  assert.equal(store.get(key).email_status, 'unknown');
});

test('lease active => in_progress; lease expired => taken over', async () => {
  const { handler, store, state } = setup();
  const key = messageKey('wamid.ABC');
  store.claim(key, { now: state.now, leaseMs: 60000 });
  assert.equal(await handler.processMessage(msg(), contacts), 'in_progress');
  state.now += 60001;
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
});

test('Resend permanent rejection: tells client to check address, acknowledges', async () => {
  const { svc, handler } = setup();
  svc.mailResults.push({ ok: false, kind: 'permanent', code: 'invalid_parameter' });
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(svc.replies[0].body, REPLIES.rejected);
});

test('Resend 409 invalid_idempotent_request means already accepted: counted as accepted, no extra email', async () => {
  const { svc, handler, store } = setup();
  svc.mailResults.push({ ok: false, kind: 'key_reused', code: 'invalid_idempotent_request' });
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
  assert.equal(store.get(messageKey('wamid.ABC')).email_status, 'accepted');
  assert.equal(svc.replies[0].body, REPLIES.accepted);
});

test('gives up after MAX_ATTEMPTS and acknowledges', async () => {
  const { svc, handler } = setup({ maxAttempts: 2 });
  for (let i = 0; i < 2; i++) { svc.mailResults.push({ ok: false, kind: 'retryable', code: 'x' }); assert.equal(await handler.processMessage(msg(), contacts), 'retry'); }
  assert.equal(await handler.processMessage(msg(), contacts), 'abandoned');
  assert.equal(await handler.processMessage(msg(), contacts), 'duplicate');
});

test('permanent WhatsApp reply failure does not block completion', async () => {
  const { svc, handler } = setup();
  svc.replyResults.push({ ok: false, kind: 'permanent', code: 'http_400' });
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
});

test('unexpected exception => retry, lease released', async () => {
  const { svc, handler } = setup();
  svc.mailer.send = async () => { throw new Error('boom'); };
  assert.equal(await handler.processMessage(msg(), contacts), 'retry');
  svc.mailer.send = async () => ({ ok: true, id: 'x' });
  assert.equal(await handler.processMessage(msg(), contacts), 'completed');
});

test('payload walking: multiple entries/changes/messages, correct contact per sender, ignores statuses & non-text', async () => {
  const { svc, handler } = setup();
  const c2 = [{ profile: { name: 'Omar' }, wa_id: '222' }, { profile: { name: 'Fatima' }, wa_id: '111' }];
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      { changes: [
        { field: 'messages', value: { contacts: c2, messages: [
          { from: '111', id: 'w1', type: 'text', text: { body: 'a@x.com' } },
          { from: '222', id: 'w2', type: 'text', text: { body: 'b@y.com' } },
          { from: '222', id: 'w3', type: 'image' },
        ] } },
        { field: 'messages', value: { statuses: [{ id: 's', status: 'delivered' }] } },
        { field: 'other', value: {} },
      ] },
      { changes: [{ field: 'messages', value: { contacts: c2, messages: [{ from: '111', id: 'w4', type: 'text', text: { body: 'no mail' } }] } }] },
    ],
  };
  const counts = await handler.handlePayload(body);
  assert.deepEqual(counts, { completed: 3, duplicate: 0, ignored: 1, abandoned: 0, in_progress: 0, retry: 0 });
  assert.match(svc.emails.find((e) => e.to === 'a@x.com').html, /Dear Fatima/);
  assert.match(svc.emails.find((e) => e.to === 'b@y.com').html, /Dear Omar/);
  assert.equal(svc.emails.length, 2);
});

test('garbage payloads are ignored safely', async () => {
  const { handler } = setup();
  for (const b of [null, {}, { object: 'page' }, { object: 'whatsapp_business_account' }, { object: 'whatsapp_business_account', entry: [null, { changes: [null] }] }]) {
    assert.equal((await handler.handlePayload(b)).completed, 0);
  }
});
