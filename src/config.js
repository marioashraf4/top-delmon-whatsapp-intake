'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

/**
 * Loads a local .env file into process.env WITHOUT overriding variables that are
 * already set (so Render's real environment always wins, and a missing .env is fine).
 * A UTF-8 BOM (added by some Windows editors / PowerShell) is stripped.
 */
function loadDotEnv(file = path.resolve(process.cwd(), '.env'), env = process.env) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

class ConfigError extends Error {}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/** Builds and validates configuration. Error messages list variable NAMES only, never values. */
function loadConfig(env = process.env, { mock = false } = {}) {
  const get = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const isProd = get('NODE_ENV') === 'production';

  if (mock && isProd) throw new ConfigError('Mock mode is not allowed when NODE_ENV=production.');

  const required = ['META_APP_SECRET', 'META_VERIFY_TOKEN'];
  if (!mock) required.push('RESEND_API_KEY', 'META_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID');
  const missing = required.filter((k) => !get(k));
  if (missing.length) throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}`);

  const cfg = {
    mock,
    port: num(get('PORT'), 3000),
    appSecret: get('META_APP_SECRET'),
    verifyToken: get('META_VERIFY_TOKEN'),
    resendApiKey: get('RESEND_API_KEY'),
    emailFrom: get('EMAIL_FROM') || 'Top Delmon <onboarding@resend.dev>',
    waToken: get('META_ACCESS_TOKEN'),
    waPhoneNumberId: get('WHATSAPP_PHONE_NUMBER_ID'),
    graphVersion: get('GRAPH_API_VERSION') || 'v23.0',
    dbPath: get('DATABASE_PATH') || (mock ? './data/mock.db' : './data/app.db'),
    mockOutboxPath: get('MOCK_OUTBOX_PATH') || './data/mock-outbox.jsonl',
    // Timing. Worst case for one attempt = resendTimeoutMs + waTimeoutMs (+ DB), well under leaseMs,
    // and the lease is renewed before each external call.
    resendTimeoutMs: num(get('RESEND_TIMEOUT_MS'), 8000),
    waTimeoutMs: num(get('WHATSAPP_TIMEOUT_MS'), 7000),
    leaseMs: num(get('LEASE_MS'), 60000),
    maxAttempts: num(get('MAX_ATTEMPTS'), 8),
    // Resend remembers an idempotency key for 24h. We stop trusting it (and refuse to resend) after 23h.
    emailKeyWindowMs: 23 * 60 * 60 * 1000,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
  };

  for (const k of ['port', 'resendTimeoutMs', 'waTimeoutMs', 'leaseMs', 'maxAttempts']) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new ConfigError(`Invalid numeric configuration: ${k}`);
  }
  if (cfg.leaseMs < 2 * (cfg.resendTimeoutMs + cfg.waTimeoutMs)) {
    throw new ConfigError('LEASE_MS must be at least twice RESEND_TIMEOUT_MS + WHATSAPP_TIMEOUT_MS.');
  }
  if (!mock && cfg.emailFrom.includes('onboarding@resend.dev')) {
    cfg.warnings = ['EMAIL_FROM is the Resend test sender: it can only deliver to your own Resend account email. Verify a domain for real clients.'];
  }
  return cfg;
}

module.exports = { loadDotEnv, loadConfig, ConfigError };
