'use strict';
/**
 * Jembatan admin Z One: kontrak GET/POST /api/admin/cross-app.
 * DB di-mock supaya tidak butuh Postgres.
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.CROSS_APP_SECRET = 'test-cross-secret';

const tenants = [{ id: 't1', name: 'Klinik AcuMedis', plan: 'starter', isActive: true, expiresAt: null, slug: 'klinik-acumedis-ab12', createdAt: new Date() }];
const users = [{ id: 'u1', name: 'dr. Ayu', email: 'admin@acumedis.app', tenantId: 't1', isActive: true, role: 'owner', createdAt: new Date() }];

const db = {
  tenant: {
    findMany: async () => tenants,
    findFirst: async () => tenants[0],
    findUnique: async ({ where }) => tenants.find((t) => t.id === where.id || t.slug === where.slug) || null,
    create: async ({ data }) => { const row = { id: 't2', isActive: true, expiresAt: null, ...data }; tenants.push(row); return row; },
    update: async ({ where, data }) => { const t = tenants.find((x) => x.id === where.id); Object.assign(t, data); return t; },
  },
  practitioner: {
    findMany: async () => users,
    findUnique: async ({ where }) => users.find((u) => u.email === where.email || u.id === where.id) || null,
    create: async ({ data }) => { const row = { id: 'u2', isActive: true, ...data }; users.push(row); return row; },
    update: async ({ where, data }) => {
      const u = users.find((x) => x.email === where.email || x.id === where.id);
      if (!u) throw new Error('not found');
      Object.assign(u, data);
      return u;
    },
  },
  refreshToken: { updateMany: async () => ({ count: 2 }) },
};

require.cache[require.resolve('../src/db')] = {
  id: require.resolve('../src/db'),
  filename: require.resolve('../src/db'),
  loaded: true,
  exports: { prisma: db },
};

const admin = require('../src/routes/admin');

const reply = () => ({
  _c: 200, _b: null,
  code(c) { this._c = c; return this; },
  send(b) { this._b = b; return this; },
});
const authHeader = { authorization: 'Bearer test-cross-secret' };

test('GET tanpa secret ditolak 401', async () => {
  const r = reply();
  await admin.get({ headers: {} }, r);
  assert.equal(r._c, 401);
});

test('GET dengan secret mengembalikan tenant & user terpetakan', async () => {
  const out = await admin.get({ headers: authHeader }, reply());
  assert.equal(out.tenants.length, 1);
  assert.equal(out.tenants[0].join_token, 'klinik-acumedis-ab12');
  assert.equal(out.users[0].email, 'admin@acumedis.app');
  assert.equal(out.users[0].active, true);
});

test('POST tanpa secret ditolak', async () => {
  const r = reply();
  await admin.post({ headers: {}, body: { action: 'updateRole' } }, r);
  assert.equal(r._c, 401);
});

test('create user tanpa password ditolak 400', async () => {
  const r = reply();
  await admin.post({ headers: authHeader, body: { action: 'create', data: { email: 'baru@klinik.id' } } }, r);
  assert.equal(r._c, 400);
  assert.match(r._b.error, /Password/);
});

test('create user sukses, password di-hash', async () => {
  const out = await admin.post({
    headers: authHeader,
    body: { action: 'create', data: { email: 'baru@klinik.id', name: 'dr. Baru', password: 'rahasia123' } },
  }, reply());
  assert.equal(out.ok, true);
  assert.equal(out.user.email, 'baru@klinik.id');
  assert.notEqual(out.user.password, 'rahasia123', 'password tidak boleh tersimpan mentah');
  assert.match(out.user.role, /practitioner|owner|admin/);
});

test('create user email duplikat ditolak 409', async () => {
  const r = reply();
  await admin.post({ headers: authHeader, body: { action: 'create', data: { email: 'admin@acumedis.app', password: 'x' } } }, r);
  assert.equal(r._c, 409);
});

test('delete user menonaktifkan + mencabut token', async () => {
  const out = await admin.post({ headers: authHeader, body: { action: 'delete', email: 'baru@klinik.id' } }, reply());
  assert.equal(out.ok, true);
  assert.equal(out.user.active, false);
});

test('updateRole menolak role asing', async () => {
  const r = reply();
  await admin.post({ headers: authHeader, body: { action: 'updateRole', email: 'admin@acumedis.app', data: { role: 'superuser' } } }, r);
  assert.equal(r._c, 400);
  assert.match(r._b.error, /owner/);
});

test('deleteTenant menonaktifkan, bukan menghapus', async () => {
  const out = await admin.post({ headers: authHeader, body: { action: 'deleteTenant', data: { tenantId: 't1' } } }, reply());
  assert.equal(out.tenant.active, false, 'klinik harus dinonaktifkan agar data pasien aman');
});

test('aksi tak dikenal ditolak 400', async () => {
  const r = reply();
  await admin.post({ headers: authHeader, body: { action: 'dropDatabase' } }, r);
  assert.equal(r._c, 400);
});
