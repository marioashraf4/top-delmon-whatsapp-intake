'use strict';

const { loadDotEnv, loadConfig, ConfigError } = require('./config');
const { logger: log } = require('./log');
const { openStore } = require('./store');
const { createHandler } = require('./handler');
const { createApp } = require('./app');

function main() {
  loadDotEnv(); // local development only; a missing .env is fine (Render injects real env vars)
  const mock = process.argv.includes('--mock');

  let config;
  try {
    config = loadConfig(process.env, { mock });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  (config.warnings || []).forEach((w) => log.warn('config.warning', { message: w }));

  let mailer, whatsapp;
  if (mock) {
    ({ mailer, whatsapp } = require('./mocks').createMockServices(config.mockOutboxPath));
    log.warn('mode.mock', { note: 'No real emails or WhatsApp messages are sent' });
  } else {
    mailer = require('./email').createResendMailer({ apiKey: config.resendApiKey, from: config.emailFrom, timeoutMs: config.resendTimeoutMs });
    whatsapp = require('./whatsapp').createWhatsAppClient({
      token: config.waToken, phoneNumberId: config.waPhoneNumberId, graphVersion: config.graphVersion, timeoutMs: config.waTimeoutMs,
    });
  }

  const store = openStore(config.dbPath);
  const purged = store.purge(config.retentionMs, Date.now());
  if (purged) log.info('store.purged', { rows: purged });

  const handler = createHandler({ store, mailer, whatsapp, config, log });
  const app = createApp({ config, handler, log });
  const server = app.listen(config.port, '0.0.0.0', () => log.info('server.listening', { port: config.port, mock }));

  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
