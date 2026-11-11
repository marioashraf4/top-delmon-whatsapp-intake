'use strict';

// Minimal JSON logger. Callers must only pass non-sensitive fields (codes, counts, short hashed ids).
function write(stream, level, event, fields) {
  stream.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n');
}

const logger = {
  info: (event, fields) => write(process.stdout, 'info', event, fields),
  warn: (event, fields) => write(process.stderr, 'warn', event, fields),
  error: (event, fields) => write(process.stderr, 'error', event, fields),
};

const silentLogger = { info() {}, warn() {}, error() {} };

module.exports = { logger, silentLogger };
