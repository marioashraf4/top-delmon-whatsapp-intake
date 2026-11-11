'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppClient } = require('../src/whatsapp');

const client = (fetchImpl) => createWhatsAppClient({ token: 't', phoneNumberId: '123', fetchImpl, timeoutMs: 50 });
const resp = (status, json) => ({ ok: status < 300, status, json: async () => json });

test('success', async () => assert.deepEqual(await client(async () => resp(200, {})).sendText('1', 'hi'), { ok: true }));
test('HTTP errors are classified, never throw', async () => {
  assert.equal((await client(async () => resp(500, {})).sendText('1', 'x')).kind, 'retryable');
  assert.equal((await client(async () => resp(429, {})).sendText('1', 'x')).kind, 'retryable');
  assert.equal((await client(async () => resp(401, {})).sendText('1', 'x')).kind, 'retryable');
  const r = await client(async () => resp(400, { error: { code: 131047 } })).sendText('1', 'x');
  assert.deepEqual(r, { ok: false, kind: 'permanent', code: 'http_400_131047' });
});
test('network error and timeout are retryable', async () => {
  assert.equal((await client(async () => { throw new TypeError('fetch failed'); }).sendText('1', 'x')).code, 'network');
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout timers are unref'd; a real socket keeps the loop alive
  try { assert.equal((await client(hang).sendText('1', 'x')).code, 'timeout'); } finally { clearTimeout(keepAlive); }
});
test('sends the expected request', async () => {
  let seen;
  await client(async (url, init) => { seen = { url, init }; return resp(200, {}); }).sendText('97336', 'hello');
  assert.match(seen.url, /graph\.facebook\.com\/v23\.0\/123\/messages$/);
  assert.equal(seen.init.headers.Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(seen.init.body), { messaging_product: 'whatsapp', to: '97336', type: 'text', text: { body: 'hello' } });
});
