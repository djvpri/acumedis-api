'use strict';
/**
 * Uji lapisan HTTP tanpa DB.
 * Fokus: auth wajib, validasi input, bentuk balasan yang dipakai app Android.
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'z'.repeat(40);

function fakeReply() {
  return {
    _code: 200,
    _body: null,
    code(c) { this._code = c; return this; },
    send(b) { this._body = b; return this; },
  };
}

const { signAccess, requireAuth } = require('../src/auth');

test('tanpa token -> 401 unauthorized', async () => {
  const reply = fakeReply();
  await requireAuth({ headers: {} }, reply);
  assert.equal(reply._code, 401);
  assert.equal(reply._body.error, 'unauthorized');
});

test('token dari secret lain -> 401', async () => {
  const other = require('jsonwebtoken').sign({ sub: 'u1' }, 'y'.repeat(40), { expiresIn: '10m' });
  const reply = fakeReply();
  await requireAuth({ headers: { authorization: `Bearer ${other}` } }, reply);
  assert.equal(reply._code, 401);
  assert.equal(reply._body.error, 'token expired or invalid');
});

test('token valid mengisi req.user', async () => {
  const reply = fakeReply();
  const req = { headers: { authorization: `Bearer ${signAccess({ id: 'u1', tenantId: 't1', role: 'owner' })}` } };
  await requireAuth(req, reply);
  assert.equal(req.user.sub, 'u1');
  assert.equal(req.user.tenantId, 't1');
  assert.equal(req.user.role, 'owner');
});

test('login tanpa body ditolak 400', async () => {
  const auth = require('../src/routes/auth');
  const reply = fakeReply();
  await auth.login({ body: {} }, reply);
  assert.equal(reply._code, 400);
});

test('validasi sesi: patient_id wajib', async () => {
  const sessions = require('../src/routes/sessions');
  const reply = fakeReply();
  await sessions.create({ body: {}, user: { tenantId: 't1', sub: 'u1' } }, reply);
  assert.equal(reply._code, 400);
  assert.match(reply._body.error, /patient_id/);
});

test('validasi jadwal: scheduled_at wajib', async () => {
  const appts = require('../src/routes/appointments');
  const reply = fakeReply();
  await appts.create({ body: {}, user: { tenantId: 't1', sub: 'u1' } }, reply);
  assert.equal(reply._code, 400);
  assert.match(reply._body.error, /scheduled_at/);
});

test('validasi pasien: nama wajib', async () => {
  const patients = require('../src/routes/patients');
  const reply = fakeReply();
  await patients.create({ body: {}, user: { tenantId: 't1' } }, reply);
  assert.equal(reply._code, 400);
  assert.match(reply._body.error, /nama/);
});

test('validasi stok: nama barang wajib', async () => {
  const inv = require('../src/routes/inventory');
  const reply = fakeReply();
  await inv.createStock({ body: {}, user: { tenantId: 't1' } }, reply);
  assert.equal(reply._code, 400);
});

test('nomor antrean = max + 1', () => {
  const rows = [{ queueNumber: 3 }, { queueNumber: 1 }];
  assert.equal(Math.max(...rows.map(r => r.queueNumber)) + 1, 4);
});
