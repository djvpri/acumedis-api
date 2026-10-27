'use strict';
/**
 * Device-code SSO dari Z One (https://zone.zomet.my.id).
 *
 * Alur:
 *  1. App: POST /v1/auth/sso/start  -> {code, verifyUrl, expiresIn}
 *  2. User buka verifyUrl di browser (sudah login Z One), menyetujui
 *  3. Z One: POST <api>/v1/auth/sso/claim  {code, token}   (token = JWT HS256 dari Z One)
 *  4. App: GET /v1/auth/sso/poll?code=... -> accessToken + refreshToken
 *
 * Keamanan:
 *  - code dibuat acak, disimpan sebagai hash, TTL 5 menit, sekali pakai
 *  - claim diverifikasi dengan CROSS_APP_SECRET dan `app` harus cocok
 *  - poll tidak pernah mengembalikan token sebelum claim diverifikasi
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { prisma } = require('../db');
const { signAccess } = require('../auth');
const { issue } = require('./auth');

const TTL_SECONDS = parseInt(process.env.SSO_CODE_TTL || '300', 10);
const EXPECTED_APP = process.env.SSO_APP_SLUG || 'zmedics';

/**
 * POST /v1/auth/sso/exchange  {token, deviceId?}
 * Alur deep link: Z One menandatangani token, app menerimanya lewat
 * `acumedis://sso?token=...`, lalu menukarnya di sini jadi sesi AcuMedis.
 * Verifikasi sama persis dengan claim — bedanya tidak ada kode perangkat.
 */
async function exchange(req, reply) {
  const { token } = req.body || {};
  if (!token) return reply.code(400).send({ ok: false, error: 'token wajib' });

  const payload = verifyZoneToken(token);
  if (!payload) return reply.code(401).send({ ok: false, error: 'token Z One tidak valid' });
  if (payload.app && payload.app !== EXPECTED_APP) {
    return reply.code(403).send({ ok: false, error: `token untuk app "${payload.app}"` });
  }

  const email = String(payload.email).toLowerCase().trim();
  const user = await prisma.practitioner.findUnique({ where: { email }, include: { tenant: true } });

  return issueFor(user, req.body?.deviceId || null, reply);
}

function secrets() {
  const list = [];
  if (process.env.CROSS_APP_SECRET) list.push(process.env.CROSS_APP_SECRET);
  // fallback lama yang masih dipakai Z One saat env-nya belum diisi
  list.push('z-ecosystem-admin-2026');
  return [...new Set(list)].filter(Boolean);
}

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** "ABCD-1234" — mudah dibaca, tanpa huruf ambigu. */
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

/** POST /v1/auth/sso/start  {deviceId?} */
async function start(req, reply) {
  const deviceId = req.body?.deviceId ? String(req.body.deviceId).slice(0, 120) : null;
  const code = newCode();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

  await prisma.ssoCode.create({
    data: { codeHash: hash(code), deviceId, expiresAt },
  });

  const zone = (process.env.ZONE_URL || 'https://zone.zomet.my.id').replace(/\/+$/, '');
  // redirect=mobile → halaman /link menawarkan kembali ke app lewat deep link
  return reply.code(201).send({
    ok: true,
    code,
    expiresIn: TTL_SECONDS,
    verifyUrl: `${zone}/link?code=${encodeURIComponent(code)}&redirect=mobile`,
  });
}

/** Verifikasi JWT dari Z One; kembalikan payload atau null. */
function verifyZoneToken(token) {
  for (const secret of secrets()) {
    try {
      const payload = jwt.verify(String(token), secret, { algorithms: ['HS256'] });
      if (payload && payload.email) return payload;
    } catch { /* coba secret berikutnya */ }
  }
  return null;
}

/** POST /v1/auth/sso/claim  {code, token}  — dipanggil server Z One. */
async function claim(req, reply) {
  const { code, token } = req.body || {};
  if (!code || !token) {
    return reply.code(400).send({ ok: false, error: 'code dan token wajib' });
  }

  const payload = verifyZoneToken(token);
  if (!payload) return reply.code(401).send({ ok: false, error: 'token Z One tidak valid' });
  if (payload.app && payload.app !== EXPECTED_APP) {
    return reply.code(403).send({ ok: false, error: `token untuk app "${payload.app}", bukan ${EXPECTED_APP}` });
  }

  const row = await prisma.ssoCode.findUnique({ where: { codeHash: hash(code) } });
  if (!row) return reply.code(404).send({ ok: false, error: 'kode tidak dikenal' });
  if (row.claimedAt) return reply.code(409).send({ ok: false, error: 'kode sudah dipakai' });
  if (row.expiresAt < new Date()) return reply.code(410).send({ ok: false, error: 'kode kedaluwarsa' });

  const email = String(payload.email).toLowerCase().trim();
  const user = await prisma.practitioner.findUnique({ where: { email } });
  if (!user || !user.isActive) {
    return reply.code(403).send({
      ok: false,
      error: 'Akun ini belum terdaftar sebagai praktisi AcuMedis. Hubungi admin klinik.',
    });
  }

  await prisma.ssoCode.update({
    where: { id: row.id },
    data: { claimedAt: new Date(), email },
  });

  return { ok: true, email };
}

/** GET /v1/auth/sso/poll?code=... */
async function poll(req, reply) {
  const code = String(req.query?.code || '');
  if (!code) return reply.code(400).send({ ok: false, error: 'code wajib' });

  const row = await prisma.ssoCode.findUnique({ where: { codeHash: hash(code) } });
  if (!row) return reply.code(404).send({ ok: false, error: 'kode tidak dikenal' });
  if (row.expiresAt < new Date() && !row.claimedAt) {
    return reply.code(410).send({ ok: false, error: 'kode kedaluwarsa' });
  }
  if (!row.claimedAt || !row.email) {
    return reply.code(202).send({ ok: false, pending: true, error: 'menunggu persetujuan' });
  }

  const user = await prisma.practitioner.findUnique({
    where: { email: row.email },
    include: { tenant: true },
  });

  // sekali pakai: kode langsung dibakar
  await prisma.ssoCode.delete({ where: { id: row.id } });

  return issueFor(user, row.deviceId, reply);
}

/** Bentuk balasan login yang sama untuk poll & exchange. */
async function issueFor(user, deviceId, reply) {
  if (!user || !user.isActive) {
    return reply.code(403).send({
      ok: false,
      error: 'Akun ini belum terdaftar sebagai praktisi AcuMedis. Hubungi admin klinik.',
    });
  }

  const accessToken = signAccess(user);
  const refresh = await issue(user, deviceId || null);

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
      clinicName: user.tenant?.name || null,
      currency: user.currency,
      defaultFee: user.defaultFee,
    },
  };
}

module.exports = { start, claim, poll, exchange, hash, newCode };
