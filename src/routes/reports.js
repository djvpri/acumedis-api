'use strict';
const { prisma } = require('../db');

/** Ringkasan harian untuk beranda app: jadwal, sesi, uang. */
async function summary(req) {
  const date = String(req.query?.date || new Date().toISOString().slice(0, 10));
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  const tenantId = req.user.tenantId;

  const [appointments, sessions, unpaid, expenses] = await Promise.all([
    prisma.appointment.findMany({
      where: { tenantId, scheduledAt: { gte: start, lte: end }, deletedAt: null },
      select: { status: true },
    }),
    prisma.session.findMany({
      where: { tenantId, sessionDate: { gte: start, lte: end }, deletedAt: null },
      select: { fee: true, paymentStatus: true },
    }),
    prisma.session.findMany({
      where: { tenantId, paymentStatus: { not: 'paid' }, deletedAt: null },
      select: { fee: true },
    }),
    prisma.expense.findMany({
      where: { tenantId, date: { gte: start, lte: end } },
      select: { amount: true },
    }),
  ]);

  const done = appointments.filter(a => a.status === 'done').length;
  const waiting = appointments.filter(a => a.status !== 'done' && a.status !== 'cancelled').length;
  const income = sessions
    .filter(s => s.paymentStatus === 'paid')
    .reduce((t, s) => t + (s.fee || 0), 0);
  const spent = expenses.reduce((t, e) => t + (e.amount || 0), 0);

  return {
    ok: true,
    date,
    appointments_total: appointments.length,
    appointments_done: done,
    appointments_waiting: waiting,
    sessions_today: sessions.length,
    income_today: income,
    expense_today: spent,
    unpaid_count: unpaid.length,
    unpaid_amount: unpaid.reduce((t, s) => t + (s.fee || 0), 0),
  };
}

/** GET /v1/sync?since=ISO — tarik semua perubahan sejak waktu tertentu (untuk mode offline). */
async function sync(req) {
  const sinceRaw = req.query?.since;
  const since = sinceRaw ? new Date(String(sinceRaw)) : new Date(0);
  if (isNaN(since.getTime())) {
    return { ok: false, error: 'format since tidak valid (pakai ISO 8601)' };
  }
  const tenantId = req.user.tenantId;

  const [patients, sessions, appointments] = await Promise.all([
    prisma.patient.findMany({
      where: { tenantId, updatedAt: { gte: since } },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    }),
    prisma.session.findMany({
      where: { tenantId, updatedAt: { gte: since } },
      include: { patient: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    }),
    prisma.appointment.findMany({
      where: { tenantId, updatedAt: { gte: since } },
      include: { patient: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    }),
  ]);

  const { toPatient } = require('./patients');
  const { toSession } = require('./sessions');
  const { toAppointment } = require('./appointments');

  return {
    ok: true,
    server_time: new Date().toISOString(),
    since: since.toISOString(),
    patients: patients.map(toPatient),
    sessions: sessions.map(toSession),
    appointments: appointments.map(toAppointment),
  };
}

module.exports = { summary, sync };
