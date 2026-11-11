'use strict';

const crypto = require('node:crypto');

/** Returns the header value Meta would send: "sha256=<hex>" (HMAC-SHA256 of the RAW body). */
function sign(rawBody, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Verifies X-Hub-Signature-256 against the raw request bytes in constant time. */
function verifySignature(rawBody, header, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1], 'hex'); // always 32 bytes
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest(); // 32 bytes
  return crypto.timingSafeEqual(provided, expected);
}

/** Constant-time string comparison (hashes first so lengths always match). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { sign, verifySignature, safeEqual };
