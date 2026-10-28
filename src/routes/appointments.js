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

/**
 * Batas satu hari kalender menurut zona waktu pengguna.
 * `tz` = menit di timur UTC (WIB = 420). Tanpa ini, jadwal pagi (mis. 05:00 WIB)
 * tersimpan sebagai hari sebelumnya dalam UTC dan muncul di tanggal yang salah.
 */
function dayBounds(date, tz) {
  const offset = Number.isFinite(tz) ? tz : 0;
  const start = new Date(`${date}T00:00:00.000Z`).getTime() - offset * 60_000;
  return { start: new Date(start), end: new Date(start + 86_400_000 - 1) };
}

async function list(req) {
  const { date, from, to, status, since, limit, tz } = req.query || {};
  const where = { tenantId: req.user.tenantId, deletedAt: null };

  if (date) {
    const { start, end } = dayBounds(String(date), Number(tz));
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

/**
 * Nomor antrean berikutnya untuk satu hari kalender pengguna (reset tiap hari).
 * Memakai zona pengirim: kalau memakai hari UTC, antrean berganti nomor pukul
 * 07:00 WIB, bukan tengah malam.
 */
async function nextQueueNumber(tenantId, scheduledAt, tz) {
  const offset = Number.isFinite(tz) ? tz : 0;
  const localDate = new Date(scheduledAt.getTime() + offset * 60_000).toISOString().slice(0, 10);
  const { start, end } = dayBounds(localDate, offset);
  const last = await prisma.appointment.findFirst({
    where: { tenantId, scheduledAt: { gte: start, lt: new Date(end.getTime() + 1) }, queueNumber: { not: null } },
    orderBy: { queueNumber: 'desc' },
    select: { queueNumber: true },
  });
  return (last?.queueNumber || 0) + 1;
}

/**
 * Cari jadwal yang bentrok. Prisma tidak bisa membandingkan scheduledAt + durasi
 * di query, jadi ambil kandidat dalam rentang lalu hitung di sini.
 * @return jadwal yang bentrok, atau null.
 */
async function findConflict(tenantId, startAt, durationMinutes, ignoreId) {
  const start = startAt.getTime();
  const end = start + durationMinutes * 60_000;
  const rows = await prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { not: 'cancelled' },
      id: ignoreId ? { not: ignoreId } : undefined,
      // jadwal lain tidak mungkin lebih dari 1 hari sebelumnya
      scheduledAt: { gte: new Date(start - 86_400_000), lt: new Date(end) },
    },
    include,
    orderBy: { scheduledAt: 'asc' },
  });
  return rows.find((a) => {
    const aStart = a.scheduledAt.getTime();
    const aEnd = aStart + (a.durationMinutes || 60) * 60_000;
    return aStart < end && aEnd > start;
  }) || null;
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
  if (Number.isNaN(scheduledAt.getTime())) {
    return reply.code(400).send({ ok: false, error: 'tanggal tidak valid' });
  }
  const duration = Number.isFinite(b.duration_minutes) ? b.duration_minutes : 60;

  const clash = await findConflict(req.user.tenantId, scheduledAt, duration, null);
  if (clash) {
    // tampilkan jam menurut zona pengirim, bukan UTC
    const tz = Number.isFinite(b.tz) ? b.tz : 0;
    const local = new Date(clash.scheduledAt.getTime() + tz * 60_000).toISOString().slice(11, 16);
    return reply.code(409).send({
      ok: false,
      error: 'Bentrok dengan ' + (clash.patient?.name || clash.externalName || 'jadwal lain') + ' pukul ' + local,
      conflict_id: clash.id,
    });
  }

  const qn = b.queue_number != null
    ? parseInt(b.queue_number, 10)
    : await nextQueueNumber(req.user.tenantId, scheduledAt, b.tz);

  const a = await prisma.appointment.create({
    data: {
      tenantId: req.user.tenantId,
      patientId,
      practitionerId: req.user.sub,
      scheduledAt,
      durationMinutes: duration,
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
  const nextAt = b.scheduled_at ? new Date(String(b.scheduled_at)) : existing.scheduledAt;
  if (Number.isNaN(nextAt.getTime())) {
    return reply.code(400).send({ ok: false, error: 'tanggal tidak valid' });
  }
  const nextDuration = Number.isFinite(b.duration_minutes)
    ? b.duration_minutes : existing.durationMinutes;

  // ubah jam juga bisa bentrok — cek kecuali jadwal ini dibatalkan
  const nextStatus = ['pending', 'confirmed', 'done', 'cancelled'].includes(b.status)
    ? b.status : existing.status;
  if (nextStatus !== 'cancelled') {
    const clash = await findConflict(req.user.tenantId, nextAt, nextDuration, existing.id);
    if (clash) {
      const tz = Number.isFinite(b.tz) ? b.tz : 0;
      const local = new Date(clash.scheduledAt.getTime() + tz * 60_000).toISOString().slice(11, 16);
      return reply.code(409).send({
        ok: false,
        error: 'Bentrok dengan ' + (clash.patient?.name || clash.externalName || 'jadwal lain') + ' pukul ' + local,
        conflict_id: clash.id,
      });
    }
  }

  const a = await prisma.appointment.update({
    where: { id: existing.id },
    data: {
      scheduledAt: b.scheduled_at ? nextAt : undefined,
      durationMinutes: Number.isFinite(b.duration_minutes) ? nextDuration : undefined,
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
