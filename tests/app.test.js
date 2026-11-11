'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const { sign } = require('../src/signature');
const { silentLogger } = require('../src/log');

async function withServer(fn) {
  const ctx = setup();
  const app = createApp({ config: ctx.config, handler: ctx.handler, log: silentLogger });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ ...ctx, base }); } finally { server.close(); }
}
const post = (base, body, sig) => fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body });
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'incoming-message.json'));

test('GET verification returns the challenge as text; wrong token or mode => 403', async () => {
  await withServer(async ({ base }) => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(`${base}/webhook?hub.mode=unsubscribe&hub.verify_token=test-verify&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(`${base}/webhook`)).status, 403);
  });
});

test('POST: missing / invalid signature => 401 and nothing processed', async () => {
  await withServer(async ({ base, svc }) => {
    assert.equal((await post(base, sample)).status, 401);
    assert.equal((await post(base, sample, sign(sample, 'wrong'))).status, 401);
    assert.equal((await post(base, sample, 'sha256=zz')).status, 401);
    assert.equal(svc.emails.length, 0);
  });
});

test('POST: signature is checked over the exact raw bytes (re-formatted JSON fails)', async () => {
  await withServer(async ({ base, svc }) => {
    const sig = sign(sample, 'test-secret');
    const reformatted = JSON.stringify(JSON.parse(sample.toString()));
    assert.equal((await post(base, reformatted, sig)).status, 401);
    assert.equal(svc.emails.length, 0);
  });
});

test('POST: valid signed sample => 200, one email; sending it twice still one email', async () => {
  await withServer(async ({ base, svc }) => {
    const sig = sign(sample, 'test-secret');
    const r1 = await post(base, sample, sig);
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).completed, 1);
    const r2 = await post(base, sample, sig);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, 1);
    assert.equal(svc.emails.length, 1);
    assert.equal(svc.emails[0].to, 'fatima@example.com');
  });
});

test('POST: valid signature but invalid JSON => 400; temporary failure => 503', async () => {
  await withServer(async ({ base, svc }) => {
    const bad = Buffer.from('{not json');
    assert.equal((await post(base, bad, sign(bad, 'test-secret'))).status, 400);
    svc.mailResults.push({ ok: false, kind: 'retryable', code: 'application_error' });
    const r = await post(base, sample, sign(sample, 'test-secret'));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '30');
    assert.equal((await post(base, sample, sign(sample, 'test-secret'))).status, 200);
  });
});

test('POST: status-only event => 200, nothing sent', async () => {
  await withServer(async ({ base, svc }) => {
    const b = fs.readFileSync(path.join(__dirname, '..', 'samples', 'status-only.json'));
    assert.equal((await post(base, b, sign(b, 'test-secret'))).status, 200);
    assert.equal(svc.emails.length + svc.replies.length, 0);
  });
});

test('health endpoint', async () => {
  await withServer(async ({ base }) => assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true }));
});
