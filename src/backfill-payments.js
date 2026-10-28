'use strict';
/**
 * Sekali jalan setelah kolom paidAmount ada: isi dari data lama.
 * Sesi yang sudah "paid" dianggap lunas penuh, "partial" dianggap nol
 * (tidak ada catatan jumlahnya), "unpaid" nol.
 */
const { prisma } = require('../db');

async function backfill() {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let fixed = 0;

  for (const t of tenants) {
    const paid = await prisma.session.findMany({
      where: { tenantId: t.id, paymentStatus: 'paid', fee: { not: null } },
      select: { id: true, fee: true, sessionDate: true, practitionerId: true },
    });

    for (const s of paid) {
      const has = await prisma.payment.count({ where: { sessionId: s.id } });
      if (has > 0) continue;

      await prisma.payment.create({
        data: {
          tenantId: t.id,
          sessionId: s.id,
          amount: s.fee,
          method: 'cash',
          note: 'Data lama (migrasi)',
          paidAt: s.sessionDate,
          createdBy: s.practitionerId,
        },
      });
      await prisma.session.update({ where: { id: s.id }, data: { paidAmount: s.fee } });
      fixed++;
    }
  }
  return fixed;
}

module.exports = { backfill };

// bisa dijalankan langsung: node src/backfill-payments.js
if (require.main === module) {
  backfill()
    .then((n) => { console.log('pembayaran lama dibuat:', n); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('gagal:', e.message); process.exit(1); });
}
