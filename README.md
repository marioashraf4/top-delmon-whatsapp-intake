# td-whatsapp-intake

Receives client WhatsApp messages through the Meta Cloud API webhook, extracts the client's email
address, sends a confirmation email with Resend, and replies on WhatsApp.

**Core guarantee:** The system is designed to prevent duplicate confirmation emails using SQLite tracking and Resend idempotency keys, with safeguards against retrying messages when the email outcome is unknown.

## How it works

1. `POST /webhook` reads the **raw** body and verifies `X-Hub-Signature-256` (HMAC-SHA256 with `META_APP_SECRET`,
   constant-time compare). Bad or missing signature -> `401`, nothing processed.
2. Every message in every entry/change is processed; status-only and non-text events are ignored.
3. Each message is **claimed atomically** in SQLite (keyed by a SHA-256 of the WhatsApp message id).
4. The email is sent with a Resend `idempotencyKey` derived from the same id.
5. The WhatsApp reply says only what actually happened ("queued", never "delivered").
6. Success/duplicate -> `200`. Temporary failure or another worker mid-flight -> `503` so Meta redelivers.

### Duplicate protection (two independent layers)

| Layer | Protects against | Limit |
|---|---|---|
| SQLite claim + lease (`src/store.js`) | Meta redeliveries, concurrent requests, restarts | Needs the DB file to survive restarts |
| Resend `idempotencyKey` (`wa-confirm-<hash>`) | Crash after Resend accepted the email but before we recorded it; lost DB | Resend remembers keys for **24 h** |

- **Lease:** a claim lasts 60 s and is renewed before each external call. One attempt takes at most
  `RESEND_TIMEOUT_MS (8 s) + WHATSAPP_TIMEOUT_MS (7 s)`, so a lease cannot expire during a legitimate attempt
  (`LEASE_MS` must be >= 2x the timeouts; enforced at startup). Writes are fenced by a per-claim token, so a
  stale worker cannot overwrite a newer one.
- **Crash after Resend call:** the attempt time is saved *before* calling Resend. A retry within 23 h reuses the
  same key, so Resend returns the original result instead of sending again. HTTP 409 `invalid_idempotent_request`
  (key already used) is treated as "already accepted".
- **After the 24 h key window:** if an attempt's outcome is still unknown after 23 h, the service **will not resend**.
  It marks the message `unknown` (visible in logs as `email.needs_review`), replies without promising an email, and
  leaves it for a human. We deliberately prefer "maybe no email" over "possibly two emails".
- **Accepted != delivered.** Resend accepting a request means the email is queued. Bounces/delivery need Resend's
  `email.delivered` / `email.bounced` webhooks, which are **not** implemented here.
- The WhatsApp reply is at-least-once (Meta's send API has no idempotency key): in a rare crash window the client
  could get the reply text twice, but never the email twice.

## Requirements

Node.js **22.13+** (uses built-in `node:sqlite`, `node:test`, `fetch`; no extra DB dependency). Tested target: Node 26.

## Setup (Windows PowerShell)

    npm install
    Copy-Item .env.example .env      # then edit .env with real values (never commit it)

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `META_APP_SECRET` | yes | Meta app secret; verifies webhook signatures |
| `META_VERIFY_TOKEN` | yes | Token you chose in the Meta webhook setup (GET handshake) |
| `META_ACCESS_TOKEN` | real mode | WhatsApp Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | real mode | Sender phone number id |
| `RESEND_API_KEY` | real mode | Resend API key |
| `EMAIL_FROM` | no | Default `Top Delmon <onboarding@resend.dev>` (test sender, see Render section) |
| `PORT` | no | Default 3000; Render injects it |
| `DATABASE_PATH` | no | Default `./data/app.db` (`./data/mock.db` in mock mode) |
| `GRAPH_API_VERSION` | no | Default `v23.0` |
| `RESEND_TIMEOUT_MS`, `WHATSAPP_TIMEOUT_MS`, `LEASE_MS`, `MAX_ATTEMPTS` | no | 8000, 7000, 60000, 8 |

`.env` is loaded only if it exists and never overrides variables already set in the environment (so Render's
settings win). Missing variables are reported **by name only**; secrets are never printed or logged.

## Run and test locally (no Meta or Resend accounts needed)

    npm test                  # automated tests (mocks for Resend + WhatsApp)
    npm run start:mock        # server with fake Resend/WhatsApp; refuses to run if NODE_ENV=production

In a second PowerShell window:

    npm run send -- samples/incoming-message.json                 # valid signed request
    npm run send -- samples/incoming-message.json --sig=invalid   # expect 401
    npm run send -- samples/incoming-message.json --sig=missing   # expect 401
    npm run send -- samples/incoming-message.json                 # again: "duplicate":1, no 2nd email
    npm run send -- samples/no-email.json                         # asks for an email, sends none
    npm run send -- samples/multiple-messages.json                # 2 emails, 1 ignored image
    npm run send -- samples/status-only.json                      # 200, nothing sent
    npm run outbox                                                # counts what the mock "sent"
    npm run reset:mock                                            # wipe mock DB/outbox to start over

`scripts/send-webhook.js` reads `META_APP_SECRET` from `.env`, signs the file's exact bytes and posts it. It never
prints the secret. Use `npm start` (real mode) only with real credentials.

## Deploying on Render

What works as-is: Node web service (`npm install` / `npm start`), the injected `PORT`, env vars from the dashboard,
`/health`, HTTPS webhook URL for Meta, signature verification, Resend and Graph API calls (HTTPS, port 443).

**SQLite needs a persistent disk.** Render's filesystem is ephemeral: it is wiped on redeploy, restart and
free-tier spin-down. Losing the DB loses the duplicate ledger; Resend's 24 h key window would still protect most
cases, but not after 24 h. Options:

1. **Paid web service + Persistent Disk** (simplest with this code): mount at e.g. `/var/data`, set
   `DATABASE_PATH=/var/data/app.db`. A disk ties the service to one instance (no horizontal scaling) and
   disables zero-downtime deploys.
2. **PostgreSQL** (not implemented). `store.js` is the only DB-touching module; port the same
   `INSERT ... ON CONFLICT DO UPDATE ... WHERE` claim to Postgres to run multiple instances. Render's *free*
   Postgres **expires after 30 days** (14-day grace, then deleted), is 1 GB, has no backups, so it is only fine for
   demos; use a paid database for production.
3. **Free web service:** fine for a demo, unsuitable for production: sleeps after 15 min idle (~1 min cold start;
   Meta may time out and retry, which the idempotency design tolerates), ephemeral disk, 750 instance-hours/month.

Production env vars on Render: `NODE_ENV=production`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `RESEND_API_KEY`, `EMAIL_FROM`, `DATABASE_PATH`.

**Real client emails need a verified sender domain.** Resend's `onboarding@resend.dev` sender can only deliver to
your own Resend account email. Verify a domain in Resend (SPF/DKIM DNS records) and set e.g.
`EMAIL_FROM="Top Delmon <noreply@yourdomain.com>"`. WhatsApp also needs a permanent system-user access token
(temporary tokens expire) and the webhook subscribed to the `messages` field.

## Privacy and security notes

- Signature verification uses the raw bytes and `timingSafeEqual`; the verify token is compared in constant time.
- Logs contain only event names, codes, counts and a 12-char hash of the message id: no emails, phone numbers,
  names, message text or secrets. The DB stores hashes and states only.
- User text and names are HTML-escaped (and control characters stripped) before going into the email.
- Anyone can type any email address into WhatsApp, so a confirmation can reach a third party; the email is
  generic and sent once per message, but consider an opt-in/verification step for high-risk use.

## Known limits

- No delivery/bounce tracking (needs Resend webhooks).
- Single SQLite file = single instance (see Render options).
- Processing is synchronous inside the webhook request (bounded to ~15 s by timeouts) so a crash always results
  in a Meta retry rather than a lost message.

## Run the Complete Local Demo (Windows PowerShell)

Follow these steps to run the application and test its main features without real Meta or Resend credentials.

### 1. Install dependencies

Open PowerShell inside the project folder and run:

```powershell
npm install
```

### 2. Run automated tests

```powershell
npm test
```

Expected result:

```text
tests 53
pass 53
fail 0
```

### 3. Start the Mock Server

First, reset the mock database to start with a clean test environment:

```powershell
npm run reset:mock
```

Then start the server:

```powershell
npm run start:mock
```

Keep this PowerShell window open while testing.

### 4. Send test webhook requests

Open a second PowerShell window in the same project folder.

**Test 1 – Valid WhatsApp message:**

```powershell
npm run send -- samples/incoming-message.json
```

Expected: HTTP 200 and `"completed":1`.

**Test 2 – Duplicate message:**

Run the same command again:

```powershell
npm run send -- samples/incoming-message.json
```

Expected: HTTP 200 and `"duplicate":1`. No second email is sent.

**Test 3 – Invalid signature:**

```powershell
npm run send -- samples/incoming-message.json --sig=invalid
```

Expected: HTTP 401 Unauthorized.

**Test 4 – Missing signature:**

```powershell
npm run send -- samples/incoming-message.json --sig=missing
```

Expected: HTTP 401 Unauthorized.

**Test 5 – Message without an email address:**

```powershell
npm run send -- samples/no-email.json
```

Expected: HTTP 200. The system asks the customer to provide an email address.

**Test 6 – Multiple messages:**

```powershell
npm run send -- samples/multiple-messages.json
```

Expected: HTTP 200, with two messages completed and one ignored non-text message.

**Test 7 – Status-only webhook event:**

```powershell
npm run send -- samples/status-only.json
```

Expected: HTTP 200 with no messages processed.

### 5. Check the Mock Outbox

Run:

```powershell
npm run outbox
```

This displays simulated email and WhatsApp responses.

For the complete test sequence above, the expected summary is:

- Emails sent: 3
- WhatsApp replies sent: 4
- Duplicate confirmation emails: prevented

### 6. Stop or Reset the Server

Press `Ctrl + C` in the server window to stop the application.

To clear the mock data and start a fresh test:

```powershell
npm run reset:mock
```

**Note:** Mock Mode simulates external services. It does not send real emails or WhatsApp messages. Real integration requires valid Meta and Resend credentials.
