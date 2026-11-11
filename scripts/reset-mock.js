'use strict';
// Usage: node scripts/reset-mock.js  -> deletes the MOCK database and outbox so you can re-run the manual tests.
const fs = require('node:fs');
const { loadDotEnv } = require('../src/config');
loadDotEnv();
const db = process.env.DATABASE_PATH || './data/mock.db';
for (const f of [db, `${db}-wal`, `${db}-shm`, process.env.MOCK_OUTBOX_PATH || './data/mock-outbox.jsonl']) fs.rmSync(f, { force: true });
console.log('Mock database and outbox reset.');
