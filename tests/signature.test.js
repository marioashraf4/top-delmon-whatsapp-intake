'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verifySignature, safeEqual } = require('../src/signature');

const body = Buffer.from('{"a":1}');
test('valid signature verifies', () => assert.equal(verifySignature(body, sign(body, 's3cret'), 's3cret'), true));
test('wrong secret fails', () => assert.equal(verifySignature(body, sign(body, 'other'), 's3cret'), false));
test('tampered body fails', () => assert.equal(verifySignature(Buffer.from('{"a":2}'), sign(body, 's3cret'), 's3cret'), false));
test('missing / malformed / wrong-length headers fail without throwing', () => {
  for (const h of [undefined, '', 'sha256=', 'sha256=abcd', 'sha1=' + 'a'.repeat(40), 'a'.repeat(64), 'sha256=' + 'z'.repeat(64), 'sha256=' + 'a'.repeat(66)]) {
    assert.equal(verifySignature(body, h, 's3cret'), false);
  }
});
test('empty secret never verifies', () => assert.equal(verifySignature(body, sign(body, ''), ''), false));
test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
});
