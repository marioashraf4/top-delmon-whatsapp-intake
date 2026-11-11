'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, loadDotEnv, ConfigError } = require('../src/config');

const full = { META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v', RESEND_API_KEY: 'r', META_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p' };

test('missing variables are reported by name only', () => {
  assert.throws(() => loadConfig({ META_APP_SECRET: 'supersecret' }), (e) => e instanceof ConfigError && /META_VERIFY_TOKEN/.test(e.message) && !/supersecret/.test(e.message));
});
test('valid config; PORT from environment (Render)', () => {
  const c = loadConfig({ ...full, PORT: '10000' });
  assert.equal(c.port, 10000);
  assert.equal(c.appSecret, 's');
});
test('mock mode needs only the Meta secrets and is refused in production', () => {
  assert.equal(loadConfig({ META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v' }, { mock: true }).mock, true);
  assert.throws(() => loadConfig({ ...full, NODE_ENV: 'production' }, { mock: true }), ConfigError);
});
test('values are trimmed; bad numbers and short leases rejected', () => {
  assert.equal(loadConfig({ ...full, META_APP_SECRET: '  s \r' }).appSecret, 's');
  assert.throws(() => loadConfig({ ...full, PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ ...full, LEASE_MS: '1000' }), ConfigError);
});
test('.env loading: handles BOM + CRLF + quotes, and never overrides existing variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '﻿META_APP_SECRET=from_file\r\nMETA_VERIFY_TOKEN="quoted value"\r\nPORT=1234\r\n');
  const env = { PORT: '9999' };
  assert.equal(loadDotEnv(file, env), true);
  assert.equal(env.META_APP_SECRET, 'from_file');
  assert.equal(env.META_VERIFY_TOKEN, 'quoted value');
  assert.equal(env.PORT, '9999');
  assert.equal(loadDotEnv(path.join(dir, 'missing.env'), {}), false);
  fs.rmSync(dir, { recursive: true });
});
