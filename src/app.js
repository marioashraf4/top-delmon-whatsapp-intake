'use strict';

const express = require('express');
const { verifySignature, safeEqual } = require('./signature');

function createApp({ config, handler, log }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Meta webhook verification handshake: echo hub.challenge as plain text.
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && safeEqual(token, config.verifyToken) && typeof challenge === 'string') {
      return res.status(200).type('text/plain').send(challenge);
    }
    return res.sendStatus(403);
  });

  // The body is read as RAW bytes: the signature is computed over exactly these bytes, so we must
  // verify BEFORE (and independently of) JSON parsing.
  app.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.get('x-hub-signature-256'), config.appSecret)) {
      log.warn('webhook.bad_signature', {});
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    try {
      const counts = await handler.handlePayload(body);
      // 503 asks Meta to redeliver later (it retries failed webhooks); 200 acknowledges.
      const status = counts.retry || counts.in_progress ? 503 : 200;
      if (status === 503) res.set('Retry-After', '30');
      return res.status(status).json(counts);
    } catch (err) {
      log.error('webhook.error', { error: err && err.name });
      return res.sendStatus(500);
    }
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.too.large') return res.sendStatus(413);
    log.error('http.error', { error: err && err.name });
    return res.sendStatus(500);
  });

  return app;
}

module.exports = { createApp };
