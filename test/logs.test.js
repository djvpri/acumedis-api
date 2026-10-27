'use strict';
/**
 * Kontrak endpoint log error: validasi, idempotensi, rate limit.
 * DB di-mock supaya pengujian tidak butuh Postgres.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const calls = { createMany: [], findMany: [], count: [], deleteMany: [] };
require.cache[require.resolve('../src/db')] = {
  id: require.resolve('../src/db'),
  filename: require.resolve('../src/db'),
  loaded: true,
  exports: {
    prisma: {
      errorLog: {
        createMany: async (a) => { calls.createMany.push(a); return { count: a.data.length }; },
        findMany: async (a) => { calls.findMany.push(a); return [{ id: '1', level: 'fatal' }]; },
        count: async (a) => { calls.count.push(a); return 1; },
        deleteMany: async (a) => { calls.deleteMany.push(a); return { count: 7 }; },
      },
    },
  },
};

const logs = require('../src/routes/logs');

function reply() {
  return {
    _c: 200, _b: null,
    code(c) { this._c = c; return this; },
    send(b) { this._b = b; return this; },
  };
}

const entry = (over = {}) => ({
  clientId: 'c-1', level: 'fatal', kind: 'crash',
  message: 'NullPointerException', stackTrace: 'at A.b(A.kt:1)',
  appVersion: '1.4.0', versionCode: 6, occurredAt: '2026-10-27T07:00:00.000Z',
  ...over,
});

test('menyimpan entri valid dan mengisi metadata perangkat', async () => {
  calls.createMany.length = 0;
  const r = reply();
  const out = await logs.create({
    headers: { 'x-device-id': 'dev-abc' },
    ip: '10.0.0.9',
    body: { entries: [entry()] },
  }, r);

  assert.equal(out.ok, true);
  assert.equal(out.stored, 1);
  const row = calls.createMany[0].data[0];
  assert.equal(row.deviceId, 'dev-abc');
  assert.equal(row.level, 'fatal');
  assert.equal(row.versionCode, 6);
  assert.ok(row.occurredAt instanceof Date);
  assert.equal(calls.createMany[0].skipDuplicates, true, 'harus idempoten');
});

test('entri tanpa clientId atau message dibuang', async () => {
  const r = reply();
  const out = await logs.create({ headers: {}, ip: '10.0.0.10', body: { entries: [{ level: 'error' }, entry({ clientId: 'c-2' })] } }, r);
  assert.equal(out.accepted, 1, 'hanya satu entri valid');
});

test('level aneh jatuh ke error, bukan fatal', async () => {
  calls.createMany.length = 0;
  const r = reply();
  await logs.create({ headers: {}, ip: '10.0.0.11', body: { entries: [entry({ level: 'panic' })] } }, r);
  assert.equal(calls.createMany[0].data[0].level, 'error');
});

test('field panjang dipotong supaya tabel tidak membengkak', async () => {
  calls.createMany.length = 0;
  const r = reply();
  await logs.create({ headers: {}, ip: '10.0.0.12', body: { entries: [entry({ message: 'x'.repeat(5000), stackTrace: 'y'.repeat(20000) })] } }, r);
  const row = calls.createMany[0].data[0];
  assert.equal(row.message.length, 2000);
  assert.equal(row.stackTrace.length, 8000);
});

test('entries kosong ditolak 400', async () => {
  const r = reply();
  await logs.create({ headers: {}, ip: '10.0.0.13', body: { entries: [] } }, r);
  assert.equal(r._c, 400, 'entries kosong harus 400');
});

test('batch dibatasi 50 entri', async () => {
  calls.createMany.length = 0;
  const r = reply();
  const many = Array.from({ length: 120 }, (_, i) => entry({ clientId: 'c-' + i }));
  await logs.create({ headers: {}, ip: '10.0.0.14', body: { entries: many } }, r);
  assert.equal(calls.createMany[0].data.length, 50);
});

test('rate limit per IP: request ke-61 ditolak 429', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 61; i++) {
    const r = reply();
    await logs.create({ headers: {}, ip, body: { entries: [entry({ clientId: 'rl-' + i })] } }, r);
    last = r;
  }
  assert.equal(last._c, 429);
});

test('baca log hanya untuk owner/admin', async () => {
  const r = reply();
  await logs.list({ user: { role: 'practitioner' }, query: {} }, r);
  assert.equal(r._c, 403);
});

test('owner bisa membaca dengan filter level dan limit', async () => {
  calls.findMany.length = 0;
  const r = reply();
  const out = await logs.list({ user: { role: 'owner' }, query: { level: 'fatal', limit: '5' } }, r);
  assert.equal(out.count, 1);
  assert.deepEqual(calls.findMany[0].where, { level: 'fatal' });
  assert.equal(calls.findMany[0].take, 5);
});

test('purge hanya owner, dan menghitung yang terhapus', async () => {
  const r1 = reply();
  await logs.purge({ user: { role: 'admin' }, query: {} }, r1);
  assert.equal(r1._c, 403);

  const r2 = reply();
  const out = await logs.purge({ user: { role: 'owner' }, query: { before: '2026-01-01T00:00:00Z' } }, r2);
  assert.equal(out.deleted, 7);
  assert.ok(calls.deleteMany[0].where.occurredAt.lt instanceof Date);
});
