'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'x'.repeat(40);

const { signAccess, verifyAccess } = require('../src/auth');

test('access token berisi tenant & role', () => {
  const token = signAccess({ id: 'p1', tenantId: 't1', role: 'owner', name: 'Ayu', email: 'a@b.c' });
  const payload = verifyAccess(token);
  assert.equal(payload.sub, 'p1');
  assert.equal(payload.tenantId, 't1');
  assert.equal(payload.role, 'owner');
});

test('token rusak ditolak', () => {
  assert.equal(verifyAccess('bukan.token.valid'), null);
});

test('token kedaluwarsa ditolak', () => {
  const expired = jwt.sign({ sub: 'p1', tenantId: 't1' }, process.env.JWT_SECRET, { expiresIn: -10 });
  assert.equal(verifyAccess(expired), null);
});

test('token dari secret lain ditolak', () => {
  const other = jwt.sign({ sub: 'p1' }, 'y'.repeat(40), { expiresIn: '10m' });
  assert.equal(verifyAccess(other), null);
});
