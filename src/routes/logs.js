'use strict';
/**
 * Log error dari app Android.
 *
 * POST /v1/logs      publik (tanpa Bearer) — crash sering terjadi sebelum login
 *                    atau saat token justru rusak. Identitas perangkat lewat
 *                    header X-Device-Id; entri idempoten lewat clientId.
 * GET  /v1/logs      khusus role owner/admin, untuk membaca.
 * DELETE /v1/logs    purge manual (owner).
 *
 * PII tidak pernah dikirim mentah oleh app (lihat Log.kt), tapi server tetap
 * memotong panjang field supaya payload aneh tidak membengkakkan tabel.
 */
const { prisma } = require('../db');

const MAX_BATCH = 50;
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Rate limit sederhana per IP: 60 request / menit. Cukup untuk menahan spam. */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  rec.n += 1;
  return rec.n > 60;
}

/** POST /v1/logs  { deviceId?, appVersion?, entries:[{clientId, level, kind, ...}] } */
async function create(req, reply) {
  const ip = req.ip || 'unknown';
  if (limited(ip)) return reply.code(429).send({ ok: false, error: 'terlalu banyak permintaan' });

  const body = req.body || {};
  const deviceId = cut(req.headers['x-device-id'] || body.deviceId, 120);
  const list = Array.isArray(body.entries) ? body.entries.slice(0, MAX_BATCH) : [];
  if (!list.length) return reply.code(400).send({ ok: false, error: 'entries kosong' });

  const rows = [];
  for (const e of list) {
    if (!e || !e.clientId || !e.message) continue;
    rows.push({
      clientId: cut(e.clientId, 64),
      level: ['fatal', 'error', 'warn'].includes(e.level) ? e.level : 'error',
      kind: cut(e.kind || 'crash', 24),
      message: cut(e.message, 2000),
      stackTrace: cut(e.stackTrace, 8000),
      screen: cut(e.screen, 64),
      deviceId,
      appVersion: cut(e.appVersion || body.appVersion, 24),
      versionCode: Number.isFinite(e.versionCode) ? Math.trunc(e.versionCode) : null,
      androidVersion: cut(e.androidVersion, 32),
      deviceModel: cut(e.deviceModel, 64),
      baseUrl: cut(e.baseUrl, 200),
      tenantId: e.tenantId ? cut(e.tenantId, 40) : null,
      userId: e.userId ? cut(e.userId, 40) : null,
      occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
    });
  }
  if (!rows.length) return reply.code(400).send({ ok: false, error: 'tidak ada entri valid' });

  // Idempoten: clientId unik, jadi retry tidak menggandakan baris.
  const res = await prisma.errorLog.createMany({ data: rows, skipDuplicates: true });

  return { ok: true, accepted: rows.length, stored: res.count };
}

/** GET /v1/logs?level=fatal&kind=crash&since=ISO&limit=100 */
async function list(req, reply) {
  if (!['owner', 'admin'].includes(req.user?.role)) {
    return reply.code(403).send({ ok: false, error: 'khusus owner' });
  }
  const { level, kind, since, limit } = req.query || {};
  const where = {};
  if (level) where.level = String(level);
  if (kind) where.kind = String(kind);
  if (since) {
    const d = new Date(String(since));
    if (!Number.isNaN(d.getTime())) where.occurredAt = { gte: d };
  }

  const take = Math.min(Math.max(parseInt(limit || '100', 10) || 100, 1), 500);
  const logs = await prisma.errorLog.findMany({ where, orderBy: { occurredAt: 'desc' }, take });
  const count = await prisma.errorLog.count({ where });
  return { ok: true, count, logs };
}

/** DELETE /v1/logs?before=ISO — purge. Tanpa `before` akan menghapus semua. */
async function purge(req, reply) {
  if (req.user?.role !== 'owner') return reply.code(403).send({ ok: false, error: 'khusus owner' });
  const before = req.query?.before ? new Date(String(req.query.before)) : null;
  const where = before && !Number.isNaN(before.getTime()) ? { occurredAt: { lt: before } } : {};
  const res = await prisma.errorLog.deleteMany({ where });
  return { ok: true, deleted: res.count };
}

module.exports = { create, list, purge };
