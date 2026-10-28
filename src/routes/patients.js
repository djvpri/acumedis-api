'use strict';
const { prisma } = require('../db');

/** Bentuk JSON yang dipakai app Android (snake_case ringkas). */
function toPatient(p) {
  return {
    id: p.id,
    name: p.name,
    gender: p.gender,
    birth_date: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
    phone: p.phone,
    email: p.email,
    address: p.address,
    note: p.note,
    total_sessions: p._count ? p._count.sessions : undefined,
    last_session_date: p.sessions?.[0]?.sessionDate?.toISOString() || null,
    updated_at: p.updatedAt.toISOString(),
  };
}

async function list(req) {
  const { since, q, limit } = req.query || {};
  const where = { tenantId: req.user.tenantId, deletedAt: null };
  if (q) {
    where.OR = [
      { name: { contains: String(q), mode: 'insensitive' } },
      { phone: { contains: String(q) } },
    ];
  }
  if (since) where.updatedAt = { gte: new Date(String(since)) };

  const rows = await prisma.patient.findMany({
    where,
    include: {
      _count: { select: { sessions: true } },
      sessions: { orderBy: { sessionDate: 'desc' }, take: 1, select: { sessionDate: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(parseInt(limit || '200', 10) || 200, 500),
  });
  return { ok: true, count: rows.length, patients: rows.map(toPatient) };
}

async function detail(req, reply) {
  const p = await prisma.patient.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
    include: {
      _count: { select: { sessions: true } },
      sessions: { orderBy: { sessionDate: 'desc' }, take: 1, select: { sessionDate: true } },
    },
  });
  if (!p) return reply.code(404).send({ ok: false, error: 'pasien tidak ditemukan' });
  return { ok: true, patient: toPatient(p) };
}

async function create(req, reply) {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) {
    return reply.code(400).send({ ok: false, error: 'nama wajib diisi' });
  }
  const p = await prisma.patient.create({
    data: {
      tenantId: req.user.tenantId,
      name: String(b.name).trim(),
      gender: b.gender === 'male' || b.gender === 'female' ? b.gender : null,
      birthDate: b.birth_date ? new Date(b.birth_date) : null,
      phone: b.phone || null,
      email: b.email || null,
      address: b.address || null,
      note: b.note || null,
    },
  });
  return reply.code(201).send({ ok: true, patient: toPatient(p) });
}

async function update(req, reply) {
  const existing = await prisma.patient.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
  });
  if (!existing) return reply.code(404).send({ ok: false, error: 'pasien tidak ditemukan' });

  const b = req.body || {};
  const p = await prisma.patient.update({
    where: { id: existing.id },
    data: {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      gender: b.gender === 'male' || b.gender === 'female' ? b.gender : undefined,
      // string kosong = pengguna mengosongkan kolom, bukan "jangan diubah"
      birthDate: b.birth_date !== undefined
        ? (b.birth_date ? new Date(b.birth_date) : null)
        : undefined,
      phone: b.phone !== undefined ? b.phone : undefined,
      email: b.email !== undefined ? b.email : undefined,
      address: b.address !== undefined ? b.address : undefined,
      note: b.note !== undefined ? b.note : undefined,
    },
  });
  return { ok: true, patient: toPatient(p) };
}

/** Soft delete: data tetap ada untuk rekam medis, hilang dari daftar. */
async function remove(req, reply) {
  const r = await prisma.patient.updateMany({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (r.count === 0) return reply.code(404).send({ ok: false, error: 'pasien tidak ditemukan' });
  return { ok: true, deleted: r.count };
}

module.exports = { list, detail, create, update, remove, toPatient };
