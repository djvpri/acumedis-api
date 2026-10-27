'use strict';
/**
 * Uji alur device-code SSO tanpa DB.
 * - kode dibuat acak & tidak disimpan mentah (hanya hash)
 * - claim menolak token yang bukan dari secret kita / app lain
 * - poll belum mengembalikan token sebelum claim
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'q'.repeat(40);
process.env.CROSS_APP_SECRET = 'test-cross-secret';
process.env.SSO_APP_SLUG = 'zmedics';

const jwt = require('jsonwebtoken');
const sso = require('../src/routes/sso');

function reply() {
  return {
    _c: 200, _b: null,
    code(c) { this._c = c; return this; },
    send(b) { this._b = b; return this; },
  };
}

test('format kode: 4-4 huruf/angka tanpa karakter ambigu', () => {
  for (let i = 0; i < 50; i++) {
    const c = sso.newCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(!/[IO01]/.test(c), 'tidak boleh ada I/O/0/1: ' + c);
  }
});

test('kode berbeda tiap panggilan', () => {
  const set = new Set(Array.from({ length: 200 }, () => sso.newCode()));
  assert.ok(set.size > 190, 'kode harus unik');
});

test('hash kode stabil dan tidak membocorkan kode', () => {
  const c = 'ABCD-2345';
  assert.equal(sso.hash(c), sso.hash(c));
  assert.notEqual(sso.hash(c), c);
  assert.equal(sso.hash(c).length, 64);
});

test('claim tanpa body ditolak 400', async () => {
  const r = reply();
  await sso.claim({ body: {} }, r);
  assert.equal(r._c, 400);
});

test('claim dengan token dari secret asing ditolak 401', async () => {
  const bad = jwt.sign({ email: 'a@b.c', app: 'zmedics' }, 'secret-palsu', { expiresIn: '5m' });
  const r = reply();
  await sso.claim({ body: { code: 'AAAA-2222', token: bad } }, r);
  assert.equal(r._c, 401);
  assert.match(r._b.error, /tidak valid/);
});

test('claim dengan token app lain ditolak 403', async () => {
  const other = jwt.sign(
    { email: 'a@b.c', app: 'zpos' },
    process.env.CROSS_APP_SECRET,
    { expiresIn: '5m' }
  );
  const r = reply();
  await sso.claim({ body: { code: 'AAAA-2222', token: other } }, r);
  assert.equal(r._c, 403);
  assert.match(r._b.error, /zpos/);
});

test('poll tanpa code ditolak 400', async () => {
  const r = reply();
  await sso.poll({ query: {} }, r);
  assert.equal(r._c, 400);
});

test('fallback secret lama tetap diterima (kompatibel Z One)', () => {
  // tanpa CROSS_APP_SECRET di env, secret lama harus tetap lolos verifikasi token
  delete process.env.CROSS_APP_SECRET;
  const old = jwt.sign(
    { email: 'a@b.c', app: 'zmedics' },
    'z-ecosystem-admin-2026',
    { expiresIn: '5m' }
  );
  const modPath = require.resolve('../src/routes/sso');
  delete require.cache[modPath];
  const fresh = require('../src/routes/sso');
  const r = reply();

  return fresh.claim({ body: { code: 'ZZZZ-9999', token: old } }, r)
    .catch((e) => { assert.ok(e instanceof TypeError, 'harus lanjut ke lookup DB, bukan gagal verifikasi'); })
    .then(() => {
      if (r._c === 200) return;
      assert.notEqual(r._c, 401, 'token fallback tidak boleh ditolak sebagai invalid');
    });
});
