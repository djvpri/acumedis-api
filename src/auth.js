'use strict';
const jwt = require('jsonwebtoken');

// Secret dibaca saat dipakai (bukan saat modul dimuat) supaya bisa diuji
// dan supaya container yang restart dengan env baru langsung memakai nilai baru.
function accessSecret() {
  const s = process.env.JWT_SECRET || '';
  if (s.length < 24) throw new Error('JWT_SECRET wajib diisi minimal 24 karakter');
  return s;
}

const ACCESS_TTL = () => process.env.ACCESS_TTL || '30m';

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, name: user.name, email: user.email },
    accessSecret(),
    { expiresIn: ACCESS_TTL() }
  );
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, accessSecret());
  } catch {
    return null;
  }
}

/** fastify preHandler: wajib Authorization: Bearer <access token>. */
async function requireAuth(req, reply) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const payload = verifyAccess(token);
  if (!payload) return reply.code(401).send({ ok: false, error: 'token expired or invalid' });
  req.user = payload;
}

module.exports = { signAccess, verifyAccess, requireAuth, accessSecret };
