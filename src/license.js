'use strict';
/**
 * Lisensi klinik yang diterbitkan Z One (hub).
 *
 * Bentuknya token bertanda tangan HMAC, bukan panggilan ke Z One tiap request:
 * klinik dengan internet buruk tidak boleh terkunci padahal lisensinya sah.
 * Server memverifikasi tanda tangan secara lokal, jadi tetap jalan walau Z One
 * tidak bisa dihubungi.
 *
 * Token: base64url(payload).base64url(hmacSha256)
 * payload: { tenantId, plan, exp, maxPractitioners, issuedAt }
 */
const crypto = require('crypto');
const { prisma } = require('./db');

/** Masa tenggang: masih penuh, hanya diberi peringatan. */
const GRACE_DAYS = 7;

function secret() {
  const s = process.env.CROSS_APP_SECRET || '';
  return s.length >= 16 ? s : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * @return {payload} kalau tanda tangan sah, null kalau tidak.
 * Token kedaluwarsa tetap dikembalikan — pemanggil yang memutuskan artinya,
 * supaya bisa membedakan "palsu" dari "lewat tanggal".
 */
function verify(token) {
  if (!secret() || !token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  // bandingkan dengan waktu tetap supaya tidak bisa ditebak lewat timing
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Status lisensi satu tenant dari data lokal (tidak menghubungi Z One).
 * @return {state, plan, expiresAt, daysLeft, graceEndsAt, maxPractitioners}
 *   state: active | grace | expired | suspended | none
 */
async function statusOf(tenantId) {
  const t = await prisma.tenant.findUnique({
    where: { id: String(tenantId) },
    select: {
      id: true, plan: true, expiresAt: true, isActive: true,
      licenseToken: true, licenseSyncedAt: true, maxPractitioners: true,
    },
  });
  if (!t) return { state: 'none', plan: null };

  const base = {
    plan: t.plan,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    maxPractitioners: t.maxPractitioners,
    syncedAt: t.licenseSyncedAt ? t.licenseSyncedAt.toISOString() : null,
  };

  if (!t.isActive) return { ...base, state: 'suspended', daysLeft: null };

  // token dari Z One diutamakan: itu yang ditandatangani, jadi tidak bisa
  // diperpanjang dengan mengubah kolom di DB app
  let exp = t.expiresAt;
  const payload = verify(t.licenseToken);
  if (payload && payload.tenantId === t.id) {
    if (payload.exp) exp = new Date(payload.exp);
    base.plan = payload.plan || base.plan;
    base.maxPractitioners = payload.maxPractitioners ?? base.maxPractitioners;
  }

  if (!exp) return { ...base, state: 'active', daysLeft: null, expiresAt: null };

  const now = Date.now();
  const end = exp.getTime();
  const daysLeft = Math.ceil((end - now) / 86_400_000);
  const graceEnds = end + GRACE_DAYS * 86_400_000;

  let state = 'active';
  if (now > graceEnds) state = 'expired';
  else if (now > end) state = 'grace';

  return {
    ...base,
    expiresAt: exp.toISOString(),
    daysLeft,
    graceEndsAt: new Date(graceEnds).toISOString(),
    state,
  };
}

/** true kalau tenant boleh menulis data baru. */
function canWrite(state) {
  return state === 'active' || state === 'grace' || state === 'none';
}

/**
 * Kunci endpoint tulis saat lisensi habis. Dipakai sebagai preHandler pada
 * route yang MENAMBAH data; route baca dan cetak nota sengaja tidak dikunci —
 * klinik yang sedang menangani pasien tidak boleh kehilangan rekam medisnya
 * gara-gara tagihan.
 */
async function requireWritable(req, reply) {
  const st = await statusOf(req.user.tenantId);
  if (canWrite(st.state)) {
    req.license = st;
    return;
  }
  return reply.code(402).send({
    ok: false,
    error: st.state === 'suspended'
      ? 'Lisensi klinik ditangguhkan. Hubungi admin.'
      : 'Masa lisensi berakhir. Data tetap bisa dibaca dan nota dicetak, tetapi tidak bisa menambah data baru.',
    license: { state: st.state, expiresAt: st.expiresAt, plan: st.plan },
  });
}

/** GET /v1/license — dipakai app untuk spanduk peringatan. */
async function get(req) {
  const st = await statusOf(req.user.tenantId);
  return { ok: true, writable: canWrite(st.state), ...st };
}

module.exports = { sign, verify, statusOf, get, requireWritable, canWrite, GRACE_DAYS };
