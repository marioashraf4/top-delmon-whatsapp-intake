'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEmail, buildConfirmationEmail, createResendMailer } = require('../src/email');

test('extracts one email and strips trailing punctuation', () => {
  assert.deepEqual(extractEmail('my email is fatima@example.com.'), { status: 'one', email: 'fatima@example.com' });
  assert.deepEqual(extractEmail('<Fatima.Ali+cr@Example.CO.UK>, thanks'), { status: 'one', email: 'Fatima.Ali+cr@example.co.uk' });
});
test('same address repeated is still one', () => assert.equal(extractEmail('a@x.com and A@X.com').status, 'one'));
test('different addresses are ambiguous', () => assert.equal(extractEmail('a@x.com or b@y.com').status, 'multiple'));
test('no / invalid emails', () => {
  for (const t of ['', 'hello', 'a@b', 'a@.com', '@x.com', 'a..b@x.com', 'a@-x.com', 'a@x.c', 'a@x.123']) {
    assert.equal(extractEmail(t).status, 'none', t);
  }
});
test('html and control characters in user content are neutralised', () => {
  const m = buildConfirmationEmail({ name: 'Eve <img src=x onerror=1>', text: '<script>alert("x")</script>\r\nBcc: a@b.com' });
  assert.ok(!m.html.includes('<script>') && !m.html.includes('<img'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(!/[\r\n]/.test(m.html));
});
test('missing name falls back to Client', () => assert.match(buildConfirmationEmail({ text: 'x' }).html, /Dear Client/));

test('resend mailer: passes idempotencyKey and unwraps { data, error }', async () => {
  let seen;
  const client = { emails: { send: async (payload, opts) => { seen = { payload, opts }; return { data: { id: 'abc' }, error: null }; } } };
  const mailer = createResendMailer({ from: 'A <a@b.com>', timeoutMs: 1000, client });
  const r = await mailer.send({ to: 'x@y.com', subject: 's', html: 'h', text: 't', idempotencyKey: 'k1' });
  assert.deepEqual(r, { ok: true, id: 'abc' });
  assert.equal(seen.opts.idempotencyKey, 'k1');
  assert.deepEqual(seen.payload.to, ['x@y.com']);
});
test('resend mailer: error classification (SDK returns errors, it does not throw)', async () => {
  const mk = (error) => createResendMailer({ from: 'f', timeoutMs: 1000, client: { emails: { send: async () => ({ data: null, error }) } } });
  const send = (m) => m.send({ to: 'x@y.com', subject: 's', html: 'h', text: 't', idempotencyKey: 'k' });
  assert.equal((await send(mk({ name: 'invalid_idempotent_request', message: '' }))).kind, 'key_reused');
  assert.equal((await send(mk({ name: 'invalid_parameter', message: '' }))).kind, 'permanent');
  for (const n of ['rate_limit_exceeded', 'concurrent_idempotent_requests', 'application_error', 'validation_error']) {
    assert.equal((await send(mk({ name: n, message: '' }))).kind, 'retryable', n);
  }
});
test('resend mailer: thrown error and timeout are retryable', async () => {
  const boom = createResendMailer({ from: 'f', timeoutMs: 1000, client: { emails: { send: async () => { throw new Error('net'); } } } });
  assert.equal((await boom.send({ to: 'x@y.com', idempotencyKey: 'k' })).kind, 'retryable');
  const slow = createResendMailer({ from: 'f', timeoutMs: 20, client: { emails: { send: () => new Promise(() => {}) } } });
  assert.deepEqual(await slow.send({ to: 'x@y.com', idempotencyKey: 'k' }), { ok: false, kind: 'retryable', code: 'timeout' });
});
