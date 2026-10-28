'use strict';
/**
 * Pembayaran per sesi. Satu baris = satu transaksi, jadi sesi bisa dibayar
 * bertahap dan status tidak pernah diset manual.
 *
 * status sesi diturunkan dari jumlah pembayaran:
 *   belum ada → unpaid, kurang dari fee → partial, sudah cukup → paid
 */
const { prisma } = require('../db');

const METHODS = ['cash', 'transfer', 'qris', 'other'];

function toPayment(p) {
  return {
    id: p.id,
    session_id: p.sessionId,
    patient_name: p.session?.patient?.name || null,
    session_date: p.session?.sessionDate ? p.session.sessionDate.toISOString() : null,
    amount: p.amount,
    method: p.method,
    note: p.note,
    paid_at: p.paidAt.toISOString(),
    created_by: p.createdBy,
  };
}

const include = {
  session: {
    select: {
      id: true, sessionDate: true, fee: true,
      patient: { select: { name: true } },
    },
  },
};

/** Hitung ulang paidAmount + paymentStatus sesi dari tabel Payment. */
async function recalc(sessionId) {
  const [session, agg] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: { fee: true } }),
    prisma.payment.aggregate({ where: { sessionId }, _sum: { amount: true } }),
  ]);
  if (!session) return null;

  const paid = agg._sum.amount || 0;
  const fee = session.fee || 0;
  let status = 'unpaid';
  if (paid > 0) status = fee > 0 && paid + 0.005 < fee ? 'partial' : 'paid';

  await prisma.session.update({
    where: { id: sessionId },
    data: { paidAmount: paid, paymentStatus: status },
  });
  return { paid, status, fee };
}

/** POST /v1/sessions/:id/payments {amount, method?, note?, paid_at?} */
async function create(req, reply) {
  const s = await prisma.session.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
    select: { id: true, fee: true },
  });
  if (!s) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });

  const b = req.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply.code(400).send({ ok: false, error: 'jumlah bayar harus lebih dari 0' });
  }

  // yang diperiksa adalah TOTAL, bukan satu pembayaran: 3x100rb untuk biaya
  // 250rb harus ditolak, bukan diterima karena tiap baris di bawah biaya
  if (s.fee) {
    const sudah = await prisma.payment.aggregate({ where: { sessionId: s.id }, _sum: { amount: true } });
    const sisa = s.fee - (sudah._sum.amount || 0);
    if (amount > sisa + 0.005) {
      return reply.code(400).send({
        ok: false,
        error: sisa <= 0.005
          ? 'sesi ini sudah lunas'
          : 'jumlah melebihi sisa tagihan (' + sisa + ')',
        balance: Math.max(0, sisa),
      });
    }
  }

  const p = await prisma.payment.create({
    data: {
      tenantId: req.user.tenantId,
      sessionId: s.id,
      amount,
      method: METHODS.includes(b.method) ? b.method : 'cash',
      note: b.note || null,
      paidAt: b.paid_at ? new Date(String(b.paid_at)) : new Date(),
      createdBy: req.user.sub,
    },
    include,
  });
  const state = await recalc(s.id);
  return reply.code(201).send({ ok: true, payment: toPayment(p), session: state });
}

/** GET /v1/payments?from&to&sessionId — buku kas masuk. */
async function list(req) {
  const { from, to, sessionId, limit } = req.query || {};
  const where = { tenantId: req.user.tenantId };
  if (sessionId) where.sessionId = String(sessionId);
  if (from || to) {
    where.paidAt = {};
    if (from) where.paidAt.gte = new Date(String(from));
    if (to) where.paidAt.lte = new Date(String(to));
  }
  const rows = await prisma.payment.findMany({
    where,
    include,
    orderBy: { paidAt: 'desc' },
    take: Math.min(parseInt(limit || '300', 10) || 300, 1000),
  });
  return {
    ok: true,
    count: rows.length,
    total: rows.reduce((t, p) => t + p.amount, 0),
    payments: rows.map(toPayment),
  };
}

/** DELETE /v1/payments/:id — hanya untuk mengoreksi salah input. */
async function remove(req, reply) {
  const p = await prisma.payment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!p) return reply.code(404).send({ ok: false, error: 'pembayaran tidak ditemukan' });

  await prisma.payment.delete({ where: { id: p.id } });
  const state = await recalc(p.sessionId);
  return { ok: true, session: state };
}

module.exports = { create, list, remove, recalc, toPayment };
