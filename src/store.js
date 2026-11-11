'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const UPDATABLE = new Set(['email_status', 'email_attempt_at', 'resend_email_id', 'email_error', 'reply_status']);

/** WhatsApp message ids embed the sender's phone number, so we only ever store/log a hash. */
const messageKey = (waMessageId) => crypto.createHash('sha256').update(waMessageId).digest('hex');

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      message_key      TEXT PRIMARY KEY,
      status           TEXT    NOT NULL,              -- processing | completed | abandoned
      lease_token      TEXT,
      lease_expires_at INTEGER NOT NULL DEFAULT 0,    -- ms epoch
      attempts         INTEGER NOT NULL DEFAULT 0,
      email_status     TEXT    NOT NULL DEFAULT 'pending', -- pending|sending|accepted|rejected|unknown|no_email|multiple
      email_attempt_at INTEGER,                        -- time of FIRST call to Resend (24h key window starts here)
      resend_email_id  TEXT,
      email_error      TEXT,
      reply_status     TEXT    NOT NULL DEFAULT 'pending', -- pending|sent|failed
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);

  // ONE atomic statement: insert a new row, or take over an existing row ONLY if it is still
  // 'processing' and its lease has expired/been released. Completed rows are never re-claimed.
  const claimStmt = db.prepare(`
    INSERT INTO messages (message_key, status, lease_token, lease_expires_at, attempts, created_at, updated_at)
    VALUES (@key, 'processing', @token, @exp, 1, @now, @now)
    ON CONFLICT(message_key) DO UPDATE SET
      lease_token = @token, lease_expires_at = @exp, attempts = attempts + 1, updated_at = @now
    WHERE messages.status = 'processing' AND messages.lease_expires_at <= @now`);
  const getStmt = db.prepare('SELECT * FROM messages WHERE message_key = ?');
  const renewStmt = db.prepare(`UPDATE messages SET lease_expires_at = @exp, updated_at = @now
    WHERE message_key = @key AND lease_token = @token AND status = 'processing'`);
  const releaseStmt = db.prepare(`UPDATE messages SET lease_expires_at = 0, updated_at = @now
    WHERE message_key = @key AND lease_token = @token AND status = 'processing'`);
  const finishStmt = db.prepare(`UPDATE messages SET status = @status, lease_expires_at = 0, updated_at = @now
    WHERE message_key = @key AND lease_token = @token AND status = 'processing'`);
  const purgeStmt = db.prepare("DELETE FROM messages WHERE status != 'processing' AND updated_at < ?");

  return {
    claim(key, { now, leaseMs }) {
      const token = crypto.randomUUID();
      const r = claimStmt.run({ key, token, exp: now + leaseMs, now });
      const row = getStmt.get(key);
      if (r.changes === 1 && row && row.lease_token === token) return { claimed: true, token, row };
      return { claimed: false, reason: row && row.status === 'processing' ? 'in_progress' : 'completed' };
    },
    /** Each of these returns false if this owner no longer holds the lease. */
    renew: (key, token, { now, leaseMs }) => renewStmt.run({ key, token, exp: now + leaseMs, now }).changes === 1,
    release: (key, token, now) => releaseStmt.run({ key, token, now }).changes === 1,
    finish: (key, token, status, now) => finishStmt.run({ key, token, status, now }).changes === 1,
    update(key, token, fields, now) {
      const cols = Object.keys(fields);
      for (const c of cols) if (!UPDATABLE.has(c)) throw new Error(`Column not updatable: ${c}`);
      const sql = `UPDATE messages SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now
        WHERE message_key = @key AND lease_token = @token AND status = 'processing'`;
      return db.prepare(sql).run({ ...fields, key, token, now }).changes === 1;
    },
    get: (key) => getStmt.get(key),
    purge: (olderThanMs, now) => purgeStmt.run(now - olderThanMs).changes,
    close: () => db.close(),
  };
}

module.exports = { openStore, messageKey };
