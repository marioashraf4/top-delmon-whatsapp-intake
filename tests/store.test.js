'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openStore } = require('../src/store');

const L = { now: 1000, leaseMs: 100 };
test('only one claimant wins while the lease is active', () => {
  const s = openStore(':memory:');
  const a = s.claim('k', L);
  const b = s.claim('k', { ...L, now: 1050 });
  assert.equal(a.claimed, true);
  assert.deepEqual(b, { claimed: false, reason: 'in_progress' });
});
test('expired or released lease can be taken over; old owner is fenced out', () => {
  const s = openStore(':memory:');
  const a = s.claim('k', L);
  const b = s.claim('k', { now: 1100, leaseMs: 100 });
  assert.equal(b.claimed, true);
  assert.equal(b.row.attempts, 2);
  assert.equal(s.update('k', a.token, { reply_status: 'sent' }, 1101), false);
  assert.equal(s.finish('k', a.token, 'completed', 1101), false);
  assert.equal(s.release('k', b.token, 1102), true);
  assert.equal(s.claim('k', { now: 1102, leaseMs: 100 }).claimed, true);
});
test('completed rows are never re-claimed', () => {
  const s = openStore(':memory:');
  const a = s.claim('k', L);
  assert.equal(s.finish('k', a.token, 'completed', 1001), true);
  assert.deepEqual(s.claim('k', { now: 999999, leaseMs: 100 }), { claimed: false, reason: 'completed' });
});
test('update rejects unknown columns; renew extends lease', () => {
  const s = openStore(':memory:');
  const a = s.claim('k', L);
  assert.throws(() => s.update('k', a.token, { status: 'completed' }, 1));
  assert.equal(s.renew('k', a.token, { now: 1090, leaseMs: 100 }), true);
  assert.equal(s.claim('k', { now: 1150, leaseMs: 100 }).claimed, false);
});
test('purge removes only old finished rows', () => {
  const s = openStore(':memory:');
  const a = s.claim('old', { now: 1, leaseMs: 1 }); s.finish('old', a.token, 'completed', 2);
  s.claim('busy', { now: 1, leaseMs: 1 });
  assert.equal(s.purge(10, 1000), 1);
  assert.ok(s.get('busy') && !s.get('old'));
});
