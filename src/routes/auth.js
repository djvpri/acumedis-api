'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db');
const { signAccess } = require('../auth');

const REFRESH_DAYS = parseInt(process.env.REFRESH_DAYS || '30', 10);

function newRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

async function issue(user, deviceId) {
  const token = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { token, userId: user.id, deviceId: deviceId || null, expiresAt },
  });
  return { token, expiresAt };
}

/** POST /v1/auth/login  {email, password, deviceId?} */
async function login(req, reply) {
  const { email, password, deviceId } = req.body || {};
  if (!email || !password) {
    return reply.code(400).send({ ok: false, error: 'email dan password wajib' });
  }

  const user = await prisma.practitioner.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !user.isActive) {
    return reply.code(401).send({ ok: false, error: 'Email atau password salah' });
  }
  const valid = await bcrypt.compare(String(password), user.password);
  if (!valid) return reply.code(401).send({ ok: false, error: 'Email atau password salah' });

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  if (tenant && !tenant.isActive) {
    return reply.code(403).send({ ok: false, error: 'Klinik tidak aktif' });
  }

  const accessToken = signAccess(user);
  const refresh = await issue(user, deviceId);

  return {
    ok: true,
    accessToken,
    refreshToken: refresh.token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      clinicName: tenant?.name || null,
      currency: user.currency,
      defaultFee: user.defaultFee,
    },
  };
}

/** POST /v1/auth/refresh  {refreshToken} */
async function refresh(req, reply) {
  const { refreshToken, deviceId } = req.body || {};
  if (!refreshToken) return reply.code(400).send({ ok: false, error: 'refreshToken wajib' });

  const row = await prisma.refreshToken.findUnique({
    where: { token: String(refreshToken) },
    include: { user: true },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date() || !row.user.isActive) {
    return reply.code(401).send({ ok: false, error: 'refresh token tidak valid' });
  }

  // rotasi: token lama dicabut, terbitkan baru
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  const accessToken = signAccess(row.user);
  const next = await issue(row.user, deviceId || row.deviceId);

  return { ok: true, accessToken, refreshToken: next.token };
}

/** POST /v1/auth/logout  {refreshToken} */
async function logout(req, reply) {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { token: String(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  return { ok: true };
}

/** GET /v1/me */
async function me(req) {
  const user = await prisma.practitioner.findUnique({
    where: { id: req.user.sub },
    include: { tenant: true },
  });
  if (!user) return { ok: false, error: 'user tidak ditemukan' };
  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      currency: user.currency,
      defaultFee: user.defaultFee,
      tenantId: user.tenantId,
      clinicName: user.tenant?.name || null,
    },
  };
}

module.exports = { login, refresh, logout, me };
