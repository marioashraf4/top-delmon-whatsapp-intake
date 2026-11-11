'use strict';

const crypto = require('node:crypto');
const { extractEmail, buildConfirmationEmail } = require('./email');
const { messageKey } = require('./store');

const REPLIES = {
  accepted:
    'Thank you. We have received your request and queued a confirmation email to the address you provided. ' +
    "If it does not arrive shortly, please check your spam folder or reply here.",
  rejected: 'We could not send a confirmation email to the address you provided. Please check it and send it again.',
  unknown: 'Thank you. We have received your request and our team will follow up with you.',
  no_email: 'Please send your email address so we can confirm your request.',
  multiple: 'We found more than one email address in your message. Please reply with the single address we should use.',
};

/**
 * deps: { store, mailer, whatsapp, config, log, clock? }
 * Per message, results are one of:
 *   ignored | duplicate | completed | abandoned   -> acknowledge (HTTP 200)
 *   in_progress | retry                            -> ask Meta to retry later (HTTP 503)
 */
function createHandler({ store, mailer, whatsapp, config, log, clock = Date.now }) {
  const lease = () => ({ now: clock(), leaseMs: config.leaseMs });

  async function processMessage(message, contacts) {
    const waId = message && message.id;
    const from = message && message.from;
    if (typeof waId !== 'string' || !waId || waId.length > 512 || typeof from !== 'string' || !from) return 'ignored';
    if (message.type !== 'text' || typeof (message.text && message.text.body) !== 'string') return 'ignored';

    const key = messageKey(waId);
    const tag = key.slice(0, 12);
    const claim = store.claim(key, lease());
    if (!claim.claimed) {
      log.info('message.skipped', { msg: tag, reason: claim.reason });
      return claim.reason === 'completed' ? 'duplicate' : 'in_progress';
    }
    const { token, row } = claim;

    try {
      if (row.attempts > config.maxAttempts) {
        store.finish(key, token, 'abandoned', clock());
        log.error('message.abandoned', { msg: tag, attempts: row.attempts });
        return 'abandoned';
      }

      const text = message.text.body;
      const contact = (Array.isArray(contacts) ? contacts : []).find((c) => c && c.wa_id === from);
      const parsed = extractEmail(text);
      let emailStatus = row.email_status;
      const upd = (fields) => store.update(key, token, fields, clock());

      // ---- Step 1: email (idempotent) ----
      if (parsed.status !== 'one') {
        emailStatus = parsed.status === 'multiple' ? 'multiple' : 'no_email';
        if (!upd({ email_status: emailStatus })) return 'retry';
      } else if (emailStatus === 'pending' || emailStatus === 'sending') {
        const firstAttempt = row.email_attempt_at;
        if (emailStatus === 'sending' && clock() - firstAttempt >= config.emailKeyWindowMs) {
          // Outcome of an earlier attempt is unknown AND Resend would no longer deduplicate: do NOT resend.
          emailStatus = 'unknown';
          if (!upd({ email_status: 'unknown', email_error: 'key_window_expired' })) return 'retry';
          log.error('email.needs_review', { msg: tag, reason: 'idempotency window expired with unknown outcome' });
        } else {
          // Record the attempt BEFORE calling Resend, so a crash leaves a durable trace.
          if (!store.renew(key, token, lease()) || !upd({ email_status: 'sending', email_attempt_at: firstAttempt ?? clock() })) return 'retry';
          const mail = buildConfirmationEmail({ name: contact && contact.profile && contact.profile.name, text });
          const r = await mailer.send({ to: parsed.email, ...mail, idempotencyKey: `wa-confirm-${key}` });

          if (r.ok || r.kind === 'key_reused') {
            // key_reused => Resend already accepted an email under this key, so never send another.
            emailStatus = 'accepted';
            if (!upd({ email_status: 'accepted', resend_email_id: r.ok ? r.id : null })) return 'retry';
            log.info('email.accepted', { msg: tag, viaKeyReuse: !r.ok });
          } else if (r.kind === 'permanent') {
            emailStatus = 'rejected';
            if (!upd({ email_status: 'rejected', email_error: r.code })) return 'retry';
            log.warn('email.rejected', { msg: tag, code: r.code });
          } else {
            store.release(key, token, clock());
            log.warn('email.retry', { msg: tag, code: r.code, attempt: row.attempts });
            return 'retry';
          }
        }
      }

      // ---- Step 2: WhatsApp reply (wording reflects what actually happened) ----
      if (row.reply_status === 'pending') {
        if (!store.renew(key, token, lease())) return 'retry';
        const r = await whatsapp.sendText(from, REPLIES[emailStatus]);
        if (r.ok) {
          if (!upd({ reply_status: 'sent' })) return 'retry';
        } else if (r.kind === 'permanent') {
          if (!upd({ reply_status: 'failed' })) return 'retry';
          log.warn('reply.failed', { msg: tag, code: r.code });
        } else {
          store.release(key, token, clock());
          log.warn('reply.retry', { msg: tag, code: r.code, attempt: row.attempts });
          return 'retry';
        }
      }

      if (!store.finish(key, token, 'completed', clock())) return 'retry';
      log.info('message.completed', { msg: tag, email: emailStatus });
      return 'completed';
    } catch (err) {
      store.release(key, token, clock());
      log.error('message.error', { msg: tag, error: err && err.name });
      return 'retry';
    }
  }

  /** Walks every entry -> change -> message in a Meta webhook body. Status-only/unsupported events are ignored. */
  async function handlePayload(body) {
    const counts = { completed: 0, duplicate: 0, ignored: 0, abandoned: 0, in_progress: 0, retry: 0 };
    if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return counts;
    for (const entry of body.entry) {
      for (const change of (entry && entry.changes) || []) {
        if (!change || change.field !== 'messages' || !change.value) continue;
        const { messages, contacts } = change.value;
        if (!Array.isArray(messages)) continue; // e.g. statuses-only
        for (const message of messages) counts[await processMessage(message, contacts)]++;
      }
    }
    return counts;
  }

  return { processMessage, handlePayload };
}

module.exports = { createHandler, REPLIES };
