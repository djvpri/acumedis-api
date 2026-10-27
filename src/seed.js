'use strict';
/**
 * Seed awal: 1 klinik + 1 akun owner + beberapa pasien & sesi contoh.
 * Idempotent — aman dijalankan berulang.
 *   SEED_EMAIL, SEED_PASSWORD, SEED_CLINIC dari env.
 */
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');

async function main() {
  const email = (process.env.SEED_EMAIL || 'admin@acumedis.app').toLowerCase();
  const password = process.env.SEED_PASSWORD || 'acumedis123';
  const clinicName = process.env.SEED_CLINIC || 'Klinik AcuMedis';

  let tenant = await prisma.tenant.findFirst({ where: { slug: 'acumedis' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: clinicName, slug: 'acumedis', city: 'Badau', province: 'Kalimantan Barat' },
    });
    console.log('tenant dibuat:', tenant.id);
  } else {
    console.log('tenant ada:', tenant.id);
  }

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.practitioner.upsert({
    where: { email },
    update: { password: hash, tenantId: tenant.id, isActive: true },
    create: {
      tenantId: tenant.id, name: 'dr. Ayu Lestari', email,
      password: hash, role: 'owner', currency: 'IDR', defaultFee: 150000,
    },
  });
  console.log('akun:', user.email, '(role', user.role + ')');

  const count = await prisma.patient.count({ where: { tenantId: tenant.id } });
  if (count === 0) {
    const p1 = await prisma.patient.create({
      data: {
        tenantId: tenant.id, name: 'Siti Rahma', gender: 'female',
        birthDate: new Date('1991-04-12'), phone: '081234567890', address: 'Badau',
      },
    });
    const p2 = await prisma.patient.create({
      data: {
        tenantId: tenant.id, name: 'Budi Santoso', gender: 'male',
        birthDate: new Date('1985-11-02'), phone: '081298765432', address: 'Badau',
      },
    });

    await prisma.session.create({
      data: {
        tenantId: tenant.id, patientId: p1.id, practitionerId: user.id,
        chiefComplaint: 'Nyeri punggung bawah menjalar ke kaki',
        tongueColor: 'Pucat', painScale: 6,
        pointsUsed: ['LI4', 'GB34', 'BL40'], durationMinutes: 30,
        tcmDiagnosis: 'Bi Gan xu + lembap', fee: 150000, paymentStatus: 'paid',
        notes: 'Duduk lama di kantor, anjurkan peregangan tiap 2 jam.',
      },
    });
    await prisma.session.create({
      data: {
        tenantId: tenant.id, patientId: p2.id, practitionerId: user.id,
        chiefComplaint: 'Insomnia', tongueColor: 'Merah', painScale: 3,
        pointsUsed: ['HT7', 'SP6'], durationMinutes: 30,
        tcmDiagnosis: 'Xin shen bu ning', fee: 150000, paymentStatus: 'unpaid',
      },
    });

    const today = new Date();
    const at = (h, m) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), h, m));
    await prisma.appointment.createMany({
      data: [
        { tenantId: tenant.id, patientId: p1.id, practitionerId: user.id,
          scheduledAt: at(1, 30), reason: 'Kontrol nyeri punggung', queueNumber: 1 },
        { tenantId: tenant.id, patientId: p2.id, practitionerId: user.id,
          scheduledAt: at(2, 15), reason: 'Evaluasi tidur', queueNumber: 2 },
      ],
    });

    await prisma.stockItem.createMany({
      data: [
        { tenantId: tenant.id, name: 'Jarum akupunktur 0.25x40', category: 'Habis pakai',
          quantity: 320, minQuantity: 100, unit: 'pcs' },
        { tenantId: tenant.id, name: 'Kapas alkohol', category: 'Habis pakai',
          quantity: 4, minQuantity: 6, unit: 'pack' },
      ],
    });

    await prisma.expense.create({
      data: { tenantId: tenant.id, description: 'Beli kapas & alkohol', amount: 85000, category: 'Supplies' },
    });

    console.log('data contoh dibuat: 2 pasien, 2 sesi, 2 jadwal, 2 stok, 1 pengeluaran');
  } else {
    console.log('pasien sudah ada:', count, '— seed data contoh dilewati');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
