'use strict';
/**
 * Laporan keuangan: pendapatan, pengeluaran, laba, piutang.
 *
 * Rentang tanggal memakai zona pengirim (tz = menit di timur UTC, WIB = 420),
 * kalau tidak, uang yang masuk pagi hari akan jatuh ke tanggal sebelumnya.
 */
const { prisma } = require('../db');

function rangeOf(q) {
  const tz = Number.isFinite(Number(q.tz)) ? Number(q.tz) : 0;
  const offset = tz * 60_000;
  const now = Date.now();

  const dayStart = (iso) => new Date(new Date(`${iso}T00:00:00.000Z`).getTime() - offset);
  const localDate = (ms) => new Date(ms + offset).toISOString().slice(0, 10);

  const to = q.to ? String(q.to) : localDate(now);
  const from = q.from ? String(q.from) : to;
  const start = dayStart(from);
  const end = new Date(dayStart(to).getTime() + 86_400_000 - 1);
  return { start, end, from, to, tz };
}

/** GET /v1/finance?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=420 */
async function overview(req) {
  const { start, end, from, to, tz } = rangeOf(req.query || {});
  const tenantId = req.user.tenantId;

  const [payments, expenses, sessions, unpaidSessions, practitioners] = await Promise.all([
    prisma.payment.findMany({
      where: { tenantId, paidAt: { gte: start, lte: end } },
      select: {
        amount: true, method: true, paidAt: true,
        session: { select: { practitionerId: true } },
      },
    }),
    prisma.expense.findMany({
      where: { tenantId, date: { gte: start, lte: end } },
      select: { amount: true, category: true, description: true, date: true },
    }),
    prisma.session.findMany({
      where: { tenantId, sessionDate: { gte: start, lte: end }, deletedAt: null },
      select: { fee: true, paidAmount: true, paymentStatus: true, practitionerId: true },
    }),
    // piutang tidak dibatasi rentang: utang lama tetap utang
    prisma.session.findMany({
      where: { tenantId, deletedAt: null, paymentStatus: { not: 'paid' }, fee: { not: null } },
      select: {
        id: true, sessionDate: true, fee: true, paidAmount: true, paymentStatus: true,
        patient: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { sessionDate: 'asc' },
      take: 200,
    }),
    prisma.practitioner.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);

  const income = payments.reduce((t, p) => t + p.amount, 0);
  const spent = expenses.reduce((t, e) => t + e.amount, 0);

  const byMethod = {};
  for (const p of payments) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;

  // pendapatan per praktisi: ikut pemilik sesinya, bukan penerima uang
  const nameOf = {};
  for (const pr of practitioners) nameOf[pr.id] = pr.name;
  const byPractitioner = {};
  for (const p of payments) {
    const id = p.session?.practitionerId;
    const k = id ? (nameOf[id] || 'Tanpa nama') : 'Tidak tercatat';
    byPractitioner[k] = (byPractitioner[k] || 0) + p.amount;
  }

  const byCategory = {};
  for (const e of expenses) {
    const k = e.category || 'lain-lain';
    byCategory[k] = (byCategory[k] || 0) + e.amount;
  }

  // grafik harian untuk rentang yang diminta (maks 60 titik)
  const days = [];
  for (let t = start.getTime(); t <= end.getTime() && days.length < 60; t += 86_400_000) {
    days.push({ date: new Date(t + tz * 60_000).toISOString().slice(0, 10), income: 0, expense: 0 });
  }
  const slot = (ms) => {
    const d = new Date(ms + tz * 60_000).toISOString().slice(0, 10);
    return days.find((x) => x.date === d);
  };
  for (const p of payments) { const s = slot(p.paidAt.getTime()); if (s) s.income += p.amount; }
  for (const e of expenses) { const s = slot(e.date.getTime()); if (s) s.expense += e.amount; }

  const receivables = unpaidSessions.map((s) => ({
    id: s.id,
    patient_id: s.patient?.id || null,
    patient_name: s.patient?.name || null,
    phone: s.patient?.phone || null,
    session_date: s.sessionDate.toISOString(),
    fee: s.fee,
    paid: s.paidAmount || 0,
    balance: Math.max(0, (s.fee || 0) - (s.paidAmount || 0)),
    status: s.paymentStatus,
  }));

  return {
    ok: true,
    from, to,
    income,
    expense: spent,
    profit: income - spent,
    by_method: byMethod,
    by_practitioner: byPractitioner,
    by_category: byCategory,
    billed: sessions.reduce((t, s) => t + (s.fee || 0), 0),
    sessions_count: sessions.length,
    days,
    receivables,
    receivables_total: receivables.reduce((t, r) => t + r.balance, 0),
  };
}

module.exports = { overview };
