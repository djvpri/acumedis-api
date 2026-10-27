'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { prisma } = require('../db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';

function ensureDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** POST /v1/sessions/:id/photos  {base64, type} → simpan file, balikan URL. */
async function upload(req, reply) {
  const session = await prisma.session.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    select: { id: true, tenantId: true },
  });
  if (!session) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });

  const { base64, mime, type } = req.body || {};
  const ext = ALLOWED[String(mime)];
  if (!base64 || !ext) {
    return reply.code(400).send({ ok: false, error: 'base64 dan mime (image/jpeg|png|webp) wajib' });
  }

  const raw = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0) return reply.code(400).send({ ok: false, error: 'data gambar kosong' });
  if (buf.length > 8 * 1024 * 1024) {
    return reply.code(413).send({ ok: false, error: 'gambar maksimal 8 MB' });
  }

  ensureDir();
  const name = `${session.tenantId}-${session.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);

  const photo = await prisma.sessionPhoto.create({
    data: {
      sessionId: session.id,
      photoType: ['tongue', 'body', 'other'].includes(type) ? type : 'tongue',
      fileUrl: `/uploads/${name}`,
    },
  });

  return reply.code(201).send({
    ok: true,
    photo: { id: photo.id, type: photo.photoType, url: photo.fileUrl },
  });
}

async function remove(req, reply) {
  const photo = await prisma.sessionPhoto.findUnique({
    where: { id: req.params.photoId },
    include: { session: { select: { tenantId: true } } },
  });
  if (!photo || photo.session.tenantId !== req.user.tenantId) {
    return reply.code(404).send({ ok: false, error: 'foto tidak ditemukan' });
  }
  const file = path.join(UPLOAD_DIR, path.basename(photo.fileUrl));
  try { fs.unlinkSync(file); } catch { /* file sudah hilang, abaikan */ }
  await prisma.sessionPhoto.delete({ where: { id: photo.id } });
  return { ok: true };
}

/** Serve file upload (dipakai app untuk menampilkan foto). */
async function serve(req, reply) {
  const name = path.basename(String(req.params.name));
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return reply.code(404).send({ ok: false, error: 'tidak ada' });
  const buf = fs.readFileSync(file);
  const ext = path.extname(name).slice(1);
  const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'application/octet-stream';
  return reply.header('Content-Type', mime).header('Cache-Control', 'private, max-age=86400').send(buf);
}

module.exports = { upload, remove, serve };
