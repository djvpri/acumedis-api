'use strict';
/**
 * Pengaturan klinik + daftar praktisi.
 *
 *  GET   /v1/settings                 → klinik + praktisi (semua role boleh baca)
 *  PATCH /v1/settings                 → ubah nama tempat praktek, alamat, no HP (owner/admin)
 *  POST  /v1/practitioners            → tambah praktisi (owner/admin)
 *  PATCH /v1/practitioners/:id        → ubah nama/telepon/role/aktif (owner/admin)
 *  DELETE /v1/practitioners/:id       → nonaktifkan, bukan hapus (owner/admin)
 *
 * Praktisi TIDAK dihapus permanen: riwayat sesi terapi menunjuk ke userId, dan
 * rekam medis harus tetap bisa ditelusuri siapa yang menangani.
 */
const bcrypt = require('bcryptjs');
const { prisma } = require('../db');

const ROLES = ['owner', 'practitioner', 'admin'];
const canWrite = (req) => ['owner', 'admin'].includes(req.user?.role);

const toPractitioner = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  active: u.isActive,
});

const toClinic = (t) => ({
  id: t.id,
  name: t.name,
  clinicName: t.clinicName || t.name,
  address: t.address,
  phone: t.phone,
  city: t.city,
});

async function get(req, reply) {
  const user = await prisma.practitioner.findUnique({
    where: { id: req.user.sub },
    include: { tenant: true },
  });
  if (!user?.tenant) return reply.code(404).send({ ok: false, error: 'klinik tidak ditemukan' });

  const staff = await prisma.practitioner.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, email: true, phone: true, role: true, isActive: true },
  });

  return { ok: true, clinic: toClinic(user.tenant), practitioners: staff.map(toPractitioner) };
}

async function update(req, reply) {
  if (!canWrite(req)) return reply.code(403).send({ ok: false, error: 'khusus owner' });

  const b = req.body || {};
  const data = {};
  if (b.clinicName !== undefined) data.clinicName = String(b.clinicName).slice(0, 80).trim();
  if (b.name !== undefined) data.name = String(b.name).slice(0, 80).trim();
  if (b.address !== undefined) data.address = String(b.address).slice(0, 200).trim() || null;
  if (b.phone !== undefined) data.phone = String(b.phone).slice(0, 32).trim() || null;
  if (!Object.keys(data).length) return reply.code(400).send({ ok: false, error: 'tidak ada perubahan' });

  const updated = await prisma.tenant.update({ where: { id: req.user.tenantId }, data });
  return { ok: true, clinic: toClinic(updated) };
}

async function createPractitioner(req, reply) {
  if (!canWrite(req)) return reply.code(403).send({ ok: false, error: 'khusus owner' });

  const b = req.body || {};
  const name = String(b.name || '').slice(0, 80).trim();
  const email = String(b.email || '').toLowerCase().trim();
  const password = String(b.password || '');
  if (!name) return reply.code(400).send({ ok: false, error: 'Nama praktisi wajib diisi' });
  if (!email) return reply.code(400).send({ ok: false, error: 'Email wajib diisi' });
  if (password.length < 8) return reply.code(400).send({ ok: false, error: 'Password minimal 8 karakter' });

  const exists = await prisma.practitioner.findUnique({ where: { email } });
  if (exists) return reply.code(409).send({ ok: false, error: 'Email sudah terdaftar' });

  const created = await prisma.practitioner.create({
    data: {
      tenantId: req.user.tenantId,
      name,
      email,
      phone: b.phone ? String(b.phone).slice(0, 32).trim() : null,
      password: await bcrypt.hash(password, 10),
      role: ROLES.includes(b.role) ? b.role : 'practitioner',
    },
  });
  return reply.code(201).send({ ok: true, practitioner: toPractitioner(created) });
}

async function updatePractitioner(req, reply) {
  if (!canWrite(req)) return reply.code(403).send({ ok: false, error: 'khusus owner' });

  const target = await prisma.practitioner.findUnique({ where: { id: req.params.id } });
  if (!target) return reply.code(404).send({ ok: false, error: 'praktisi tidak ditemukan' });
  if (target.tenantId !== req.user.tenantId) {
    return reply.code(403).send({ ok: false, error: 'praktisi bukan anggota klinik ini' });
  }

  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = String(b.name).slice(0, 80).trim();
  if (b.phone !== undefined) data.phone = String(b.phone).slice(0, 32).trim() || null;
  if (b.role !== undefined && ROLES.includes(b.role)) data.role = b.role;
  if (b.active !== undefined) data.isActive = !!b.active;
  if (!Object.keys(data).length) return reply.code(400).send({ ok: false, error: 'tidak ada perubahan' });

  const updated = await prisma.practitioner.update({ where: { id: target.id }, data });
  return { ok: true, practitioner: toPractitioner(updated) };
}

async function removePractitioner(req, reply) {
  if (!canWrite(req)) return reply.code(403).send({ ok: false, error: 'khusus owner' });
  if (req.params.id === req.user.sub) {
    return reply.code(400).send({ ok: false, error: 'Tidak bisa menonaktifkan akun sendiri' });
  }

  const target = await prisma.practitioner.findUnique({ where: { id: req.params.id } });
  if (!target) return reply.code(404).send({ ok: false, error: 'praktisi tidak ditemukan' });
  if (target.tenantId !== req.user.tenantId) {
    return reply.code(403).send({ ok: false, error: 'praktisi bukan anggota klinik ini' });
  }

  const updated = await prisma.practitioner.update({
    where: { id: target.id },
    data: { isActive: false },
  });
  await prisma.refreshToken.updateMany({
    where: { userId: target.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { ok: true, practitioner: toPractitioner(updated) };
}

module.exports = { get, update, createPractitioner, updatePractitioner, removePractitioner };
