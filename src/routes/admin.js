'use strict';
/**
 * Jembatan admin untuk Z One (hub).
 *
 * GET  /api/admin/cross-app   → { tenants, users } supaya halaman /manage Z One
 *                               bisa menampilkan klinik & praktisi AcuMedis.
 * POST /api/admin/cross-app   → { action, email?, data } untuk kelola.
 *
 * Autentikasi: header `Authorization: Bearer <CROSS_APP_SECRET>` (server-ke-server,
 * tidak lewat sesi pengguna). Endpoint ini TIDAK memakai JWT app.
 *
 * Pemetaan konsep hub → AcuMedis:
 *   tenant (hub)  = Tenant/klinik
 *   user (hub)    = Practitioner
 *   join_token    = Tenant.slug
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db');

const ROLES = ['owner', 'practitioner', 'admin'];

function secrets() {
  const list = [];
  if (process.env.CROSS_APP_SECRET) list.push(process.env.CROSS_APP_SECRET);
  list.push('z-ecosystem-admin-2026');
  return [...new Set(list)].filter(Boolean);
}

function deny(reply) {
  return reply.code(401).send({ error: 'Unauthorized' });
}

function authed(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return !!token && secrets().includes(token);
}

const toTenant = (t) => ({
  id: t.id,
  name: t.name,
  plan: t.plan,
  active: t.isActive,
  expires_at: t.expiresAt ? t.expiresAt.toISOString() : null,
  join_token: t.slug || null,
});

const toUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  tenantId: u.tenantId,
  active: u.isActive,
  role: u.role,
});

/** GET /api/admin/cross-app */
async function get(req, reply) {
  if (!authed(req)) return deny(reply);
  const [tenants, users] = await Promise.all([
    prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.practitioner.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, tenantId: true, isActive: true, role: true },
    }),
  ]);
  return { tenants: tenants.map(toTenant), users: users.map(toUser) };
}

/** slug unik dari nama klinik; dipakai sebagai join token. */
async function uniqueSlug(name) {
  const base =
    String(name || 'klinik')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'klinik';
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    const taken = await prisma.tenant.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

/** POST /api/admin/cross-app  { action, email?, data } */
async function post(req, reply) {
  if (!authed(req)) return deny(reply);

  const { action, email: topEmail, data } = req.body || {};
  const d = data || {};
  const email = String(topEmail || d.email || '').toLowerCase().trim();
  const fail = (status, msg) => reply.code(status).send({ error: msg });

  switch (action) {
    // ---------- tenant / klinik ----------
    case 'createTenant': {
      const name = String(d.name || '').trim();
      if (!name) return fail(400, 'Nama klinik wajib diisi');
      const tenant = await prisma.tenant.create({
        data: { name, slug: await uniqueSlug(name), clinicName: name },
      });
      // hub mengirim email pemilik; kalau praktisi itu sudah ada, pindahkan ke klinik baru
      if (email) {
        const owner = await prisma.practitioner.findUnique({ where: { email } });
        if (owner) {
          await prisma.practitioner.update({ where: { id: owner.id }, data: { tenantId: tenant.id } });
        }
      }
      return { ok: true, tenant: toTenant(tenant) };
    }

    case 'updatePlan': {
      if (!d.tenantId) return fail(400, 'tenantId wajib');
      const patch = {};
      if (d.plan) patch.plan = String(d.plan).slice(0, 40);
      if (d.planExpires !== undefined) {
        patch.expiresAt = d.planExpires ? new Date(d.planExpires) : null;
      }
      const tenant = await prisma.tenant.update({ where: { id: String(d.tenantId) }, data: patch });
      return { ok: true, tenant: toTenant(tenant) };
    }

    case 'deleteTenant': {
      if (!d.tenantId) return fail(400, 'tenantId wajib');
      // nonaktifkan, jangan hapus: data pasien & rekam medis ikut terhapus kalau dihapus
      const tenant = await prisma.tenant.update({
        where: { id: String(d.tenantId) },
        data: { isActive: false },
      });
      return { ok: true, tenant: toTenant(tenant) };
    }

    case 'reactivateTenant': {
      if (!d.tenantId) return fail(400, 'tenantId wajib');
      const tenant = await prisma.tenant.update({
        where: { id: String(d.tenantId) },
        data: { isActive: true },
      });
      return { ok: true, tenant: toTenant(tenant) };
    }

    case 'setJoinToken': {
      if (!d.tenantId) return fail(400, 'tenantId wajib');
      const tenant = await prisma.tenant.update({
        where: { id: String(d.tenantId) },
        data: { slug: await uniqueSlug((await prisma.tenant.findUnique({ where: { id: String(d.tenantId) } }))?.name) },
      });
      return { ok: true, joinToken: tenant.slug };
    }

    // ---------- pengguna / praktisi ----------
    case 'create': {
      if (!email) return fail(400, 'Email wajib diisi');
      if (!d.password) return fail(400, 'Password wajib diisi');
      const exists = await prisma.practitioner.findUnique({ where: { email } });
      if (exists) return fail(409, 'Email sudah terdaftar');

      const tenantId = d.tenantId ? String(d.tenantId) : (await prisma.tenant.findFirst())?.id;
      if (!tenantId) return fail(400, 'Belum ada klinik; buat klinik dulu');

      const user = await prisma.practitioner.create({
        data: {
          tenantId,
          name: String(d.name || email.split('@')[0]).slice(0, 80),
          email,
          password: await bcrypt.hash(String(d.password), 10),
          role: ROLES.includes(d.role) ? d.role : 'practitioner',
        },
      });
      return { ok: true, user: toUser(user) };
    }

    case 'delete': {
      if (!email) return fail(400, 'Email wajib diisi');
      const user = await prisma.practitioner.findUnique({ where: { email } });
      if (!user) return fail(404, 'Pengguna tidak ditemukan');
      // nonaktifkan + cabut semua sesi refresh supaya tidak bisa dipakai lagi
      const updated = await prisma.practitioner.update({ where: { id: user.id }, data: { isActive: false } });
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true, user: toUser(updated) };
    }

    case 'reactivate': {
      if (!email) return fail(400, 'Email wajib diisi');
      const user = await prisma.practitioner.update({ where: { email }, data: { isActive: true } });
      return { ok: true, user: toUser(user) };
    }

    case 'moveTenant': {
      if (!email) return fail(400, 'Email wajib diisi');
      if (!d.tenantId) return fail(400, 'tenantId wajib');
      const user = await prisma.practitioner.update({
        where: { email },
        data: { tenantId: String(d.tenantId) },
      });
      return { ok: true, user: toUser(user) };
    }

    case 'updateRole': {
      if (!email) return fail(400, 'Email wajib diisi');
      if (!ROLES.includes(d.role)) return fail(400, `Role harus salah satu: ${ROLES.join(', ')}`);
      const user = await prisma.practitioner.update({
        where: { email },
        data: { role: d.role },
      });
      return { ok: true, user: toUser(user) };
    }

    default:
      return fail(400, `Aksi tidak dikenal: ${action}`);
  }
}

module.exports = { get, post };
