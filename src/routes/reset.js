'use strict';
/**
 * Reset password tanpa login memakai kode 6 digit.
 *
 * POST /v1/auth/reset/start   { email }        -> { ok:true }        (selalu, tanpa bocor email terdaftar)
 * POST /v1/auth/reset/verify  { email, code, newPassword } -> sesi baru
 *
 * Kode dibuat admin dari Z One (/manage -> tombol Kode) lewat
 * /api/admin/cross-app action 'resetCode'. TTL 15 menit, sekali pakai.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db');
const { signAccess } = require('../auth');
const { issue } = require('./auth');

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** Kode hanya bisa dipakai kalau baru dibuat admin; tidak ada kode default. */
async function verify(req, reply) {
  const { email: rawEmail, code, newPassword } = req.body || {};
  const email = String(rawEmail || '').toLowerCase().trim();
  if (!email || !code) return reply.code(400).send({ ok: false, error: 'Email dan kode wajib diisi' });
  if (String(newPassword || '').length < 8) {
    return reply.code(400).send({ ok: false, error: 'Password baru minimal 8 karakter' });
  }

  const invalid = () =>
    reply.code(400).send({ ok: false, error: 'Kode tidak valid atau sudah kedaluwarsa' });

  const row = await prisma.passwordReset.findUnique({ where: { codeHash: hash(code) } });
  if (!row) return invalid();
  if (row.usedAt) return invalid();
  if (row.expiresAt < new Date()) return invalid();
  if (row.email.toLowerCase() !== email) return invalid();

  const user = await prisma.practitioner.findUnique({ where: { email }, include: { tenant: true } });
  if (!user || !user.isActive) return invalid();

  // klaim atomik: dua permintaan bersamaan tidak bisa memakai kode yang sama
  const claimed = await prisma.passwordReset.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return invalid();

  await prisma.practitioner.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(String(newPassword), 10) },
  });

  // semua sesi lama mati: kalau password direset karena bocor, penyerang terlempar
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const refresh = await issue(user, req.body?.deviceId || null);
  return {
    ok: true,
    accessToken: signAccess(user),
    refreshToken: refresh.token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      clinicName: user.tenant?.name || null,
    },
  };
}

module.exports = { verify };
