'use strict';

const MAX_EMAIL = 254;
const CANDIDATE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function isValidEmail(addr) {
  if (addr.length > MAX_EMAIL) return false;
  const [local, domain, ...rest] = addr.split('@');
  if (rest.length || !local || !domain || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
}

/**
 * Finds the client's email in free text.
 * -> {status:'one', email} | {status:'none'} | {status:'multiple'}
 * More than one DIFFERENT address is ambiguous, so we ask the client instead of guessing.
 */
function extractEmail(text) {
  const found = new Map();
  for (const m of String(text).matchAll(CANDIDATE)) {
    const addr = m[0].replace(/^[.'%+-]+/, '');
    if (isValidEmail(addr)) found.set(addr.toLowerCase(), addr);
  }
  if (found.size === 0) return { status: 'none' };
  if (found.size > 1) return { status: 'multiple' };
  return { status: 'one', email: [...found.values()][0].replace(/@(.+)$/, (_, d) => '@' + d.toLowerCase()) };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// eslint-disable-next-line no-control-regex
const clean = (s, max) => String(s).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);

/** Builds the confirmation email. All user-supplied content is escaped for HTML. */
function buildConfirmationEmail({ name, text }) {
  const safeName = clean(name || 'Client', 80) || 'Client';
  const quote = clean(text || '', 500);
  return {
    subject: 'We received your request',
    html:
      `<p>Dear ${escapeHtml(safeName)},</p>` +
      `<p>We received your message: &ldquo;${escapeHtml(quote)}&rdquo;. Our team will contact you within one working day.</p>`,
    text: `Dear ${safeName},\n\nWe received your message: "${quote}". Our team will contact you within one working day.`,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Resend error names -> what we do. (Names from the SDK's RESEND_ERROR_CODES_BY_KEY.)
const PERMANENT = new Set(['invalid_parameter', 'missing_required_field']); // bad recipient/payload: retrying is pointless
const KEY_REUSED = 'invalid_idempotent_request'; // same key, different payload => key was already used => email already accepted before

function classifyResendError(error) {
  const code = String(error.name || 'unknown').toLowerCase();
  if (code === KEY_REUSED) return { ok: false, kind: 'key_reused', code };
  if (PERMANENT.has(code)) return { ok: false, kind: 'permanent', code };
  // Everything else (rate limit, 5xx, concurrent_idempotent_requests, invalid/missing api key,
  // invalid_from_address, validation_error such as "test sender can only email yourself") is retryable
  // or an operator/config problem; MAX_ATTEMPTS bounds it.
  return { ok: false, kind: 'retryable', code };
}

/** mailer.send() -> {ok:true,id} | {ok:false, kind:'retryable'|'permanent'|'key_reused', code} */
function createResendMailer({ apiKey, from, timeoutMs, client }) {
  const resend = client || new (require('resend').Resend)(apiKey);
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      let result;
      try {
        result = await withTimeout(resend.emails.send({ from, to: [to], subject, html, text }, { idempotencyKey }), timeoutMs);
      } catch (err) {
        return { ok: false, kind: 'retryable', code: err.code === 'TIMEOUT' ? 'timeout' : 'exception' };
      }
      const { data, error } = result || {};
      if (error) return classifyResendError(error);
      if (!data || !data.id) return { ok: false, kind: 'retryable', code: 'no_id' };
      // "accepted" means Resend queued it. It does NOT mean delivered.
      return { ok: true, id: data.id };
    },
  };
}

module.exports = { extractEmail, escapeHtml, buildConfirmationEmail, createResendMailer, classifyResendError, withTimeout };
