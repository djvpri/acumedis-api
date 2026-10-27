'use strict';
const { prisma } = require('../db');

function toAppointment(a) {
  return {
    id: a.id,
    scheduled_at: a.scheduledAt.toISOString(),
    duration_minutes: a.durationMinutes,
    reason: a.reason,
    status: a.status,
    queue_number: a.queueNumber,
    notes: a.notes,
    patient_id: a.patientId,
    patient_name: a.patient?.name || null,
    external_name: a.externalName,
    external_phone: a.externalPhone,
    updated_at: a.updatedAt.toISOString(),
  };
}

const include = { patient: { select: { id: true, name: true } } };

async function list(req) {
  const { date, from, to, status, since, limit } = req.query || {};
  const where = { tenantId: req.user.tenantId, deletedAt: null };

  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);
    where.scheduledAt = { gte: start, lte: end };
  } else if (from || to) {
    where.scheduledAt = {};
    if (from) where.scheduledAt.gte = new Date(String(from));
    if (to) where.scheduledAt.lte = new Date(String(to));
  }
  if (status) where.status = String(status);
  if (since) where.updatedAt = { gte: new Date(String(since)) };

  const rows = await prisma.appointment.findMany({
    where,
    include,
    orderBy: { scheduledAt: 'asc' },
    take: Math.min(parseInt(limit || '100', 10) || 100, 500),
  });
  return { ok: true, count: rows.length, appointments: rows.map(toAppointment) };
}

/** Nomor antrean berikutnya untuk tanggal tertentu (reset tiap hari). */
async function nextQueueNumber(tenantId, scheduledAt) {
  const d = new Date(scheduledAt);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const last = await prisma.appointment.findFirst({
    where: { tenantId, scheduledAt: { gte: start, lt: end }, queueNumber: { not: null } },
    orderBy: { queueNumber: 'desc' },
    select: { queueNumber: true },
  });
  return (last?.queueNumber || 0) + 1;
}

async function create(req, reply) {
  const b = req.body || {};
  if (!b.scheduled_at) return reply.code(400).send({ ok: false, error: 'scheduled_at wajib' });
  if (!b.patient_id && !b.external_name) {
    return reply.code(400).send({ ok: false, error: 'patient_id atau external_name wajib' });
  }

  let patientId = null;
  if (b.patient_id) {
    const p = await prisma.patient.findFirst({
      where: { id: String(b.patient_id), tenantId: req.user.tenantId, deletedAt: null },
    });
    if (!p) return reply.code(404).send({ ok: false, error: 'pasien tidak ditemukan' });
    patientId = p.id;
  }

  const scheduledAt = new Date(String(b.scheduled_at));
  const qn = b.queue_number != null
    ? parseInt(b.queue_number, 10)
    : await nextQueueNumber(req.user.tenantId, scheduledAt);

  const a = await prisma.appointment.create({
    data: {
      tenantId: req.user.tenantId,
      patientId,
      practitionerId: req.user.sub,
      scheduledAt,
      durationMinutes: Number.isFinite(b.duration_minutes) ? b.duration_minutes : 60,
      reason: b.reason || null,
      status: ['pending', 'confirmed', 'done', 'cancelled'].includes(b.status)
        ? b.status : 'confirmed',
      externalName: b.external_name || null,
      externalPhone: b.external_phone || null,
      notes: b.notes || null,
      queueNumber: qn,
    },
    include,
  });
  return reply.code(201).send({ ok: true, appointment: toAppointment(a) });
}

async function update(req, reply) {
  const existing = await prisma.appointment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
  });
  if (!existing) return reply.code(404).send({ ok: false, error: 'jadwal tidak ditemukan' });

  const b = req.body || {};
  const a = await prisma.appointment.update({
    where: { id: existing.id },
    data: {
      scheduledAt: b.scheduled_at ? new Date(String(b.scheduled_at)) : undefined,
      durationMinutes: Number.isFinite(b.duration_minutes) ? b.duration_minutes : undefined,
      reason: b.reason !== undefined ? b.reason : undefined,
      status: ['pending', 'confirmed', 'done', 'cancelled'].includes(b.status)
        ? b.status : undefined,
      notes: b.notes !== undefined ? b.notes : undefined,
      externalName: b.external_name !== undefined ? b.external_name : undefined,
      externalPhone: b.external_phone !== undefined ? b.external_phone : undefined,
    },
    include,
  });
  return { ok: true, appointment: toAppointment(a) };
}

async function remove(req, reply) {
  const r = await prisma.appointment.updateMany({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
    data: { deletedAt: new Date(), status: 'cancelled' },
  });
  if (r.count === 0) return reply.code(404).send({ ok: false, error: 'jadwal tidak ditemukan' });
  return { ok: true };
}

module.exports = { list, create, update, remove, toAppointment };
