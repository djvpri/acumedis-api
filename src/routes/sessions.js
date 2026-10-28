'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { prisma } = require('../db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Simpan foto lidah ke volume upload, kembalikan URL publiknya.
 * Gagal menyimpan file tidak boleh menggagalkan penyimpanan sesi: rekam medis
 * lebih penting daripada fotonya.
 */
async function saveTongue(tenantId, base64, mime) {
  const ext = PHOTO_EXT[String(mime || 'image/jpeg')] || 'jpg';
  const raw = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${tenantId}-tongue-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return `/uploads/${name}`;
  } catch (e) {
    console.warn('[sessions] gagal simpan foto lidah:', e.message);
    return null;
  }
}

function toSession(s) {
  return {
    id: s.id,
    patient_id: s.patientId,
    patient_name: s.patient?.name || null,
    practitioner_id: s.practitionerId,
    session_date: s.sessionDate.toISOString(),
    chief_complaint: s.chiefComplaint,
    tongue_color: s.tongueColor,
    tongue_coating: s.tongueCoating,
    pulse_quality: s.pulseQuality,
    pain_scale: s.painScale,
    tcm_diagnosis: s.tcmDiagnosis,
    points_used: s.pointsUsed,
    duration_minutes: s.durationMinutes,
    notes: s.notes,
    ai_recommendation: s.aiRecommendation,
    fee: s.fee,
    payment_status: s.paymentStatus,
    photos: (s.photos || []).map(p => ({
      id: p.id, type: p.photoType, url: p.fileUrl, analysis: p.aiAnalysis,
    })),
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

const include = {
  patient: { select: { id: true, name: true } },
  photos: true,
};

async function list(req) {
  const { patientId, since, from, to, unpaid, limit } = req.query || {};
  const where = { tenantId: req.user.tenantId, deletedAt: null };
  if (patientId) where.patientId = String(patientId);
  if (unpaid === '1' || unpaid === 'true') where.paymentStatus = { not: 'paid' };
  if (since) where.updatedAt = { gte: new Date(String(since)) };
  if (from || to) {
    where.sessionDate = {};
    if (from) where.sessionDate.gte = new Date(String(from));
    if (to) where.sessionDate.lte = new Date(String(to));
  }

  const rows = await prisma.session.findMany({
    where,
    include,
    orderBy: { sessionDate: 'desc' },
    take: Math.min(parseInt(limit || '100', 10) || 100, 500),
  });
  return { ok: true, count: rows.length, sessions: rows.map(toSession) };
}

async function detail(req, reply) {
  const s = await prisma.session.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include,
  });
  if (!s) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });
  return { ok: true, session: toSession(s) };
}

async function create(req, reply) {
  const b = req.body || {};
  if (!b.patient_id) return reply.code(400).send({ ok: false, error: 'patient_id wajib' });
  if (!b.chief_complaint || !String(b.chief_complaint).trim()) {
    return reply.code(400).send({ ok: false, error: 'keluhan utama wajib diisi' });
  }

  const patient = await prisma.patient.findFirst({
    where: { id: String(b.patient_id), tenantId: req.user.tenantId, deletedAt: null },
  });
  if (!patient) return reply.code(404).send({ ok: false, error: 'pasien tidak ditemukan' });

  const status = b.payment_status === 'paid' || b.payment_status === 'partial'
    ? b.payment_status : 'unpaid';

  // foto & teks AI dihitung dulu: null = tidak ada foto, jangan buat baris kosong
  const photoUrl = b.photo_base64
    ? await saveTongue(req.user.tenantId, b.photo_base64, b.photo_mime)
    : null;
  const aiText = b.ai_text ? String(b.ai_text).slice(0, 4000) : null;

  const s = await prisma.session.create({
    data: {
      tenantId: req.user.tenantId,
      patientId: patient.id,
      practitionerId: req.user.sub,
      sessionDate: b.session_date ? new Date(b.session_date) : new Date(),
      chiefComplaint: String(b.chief_complaint).trim(),
      // foto lidah base64 (opsional) disimpan sekalian, supaya satu request
      // tidak perlu dua kali kirim gambar dari HP
      photos: photoUrl
        ? { create: { photoType: 'tongue', fileUrl: photoUrl, aiAnalysis: aiText } }
        : undefined,
      // catatan AI ikut disimpan supaya saran yang dulu dipakai tetap bisa ditelusuri
      aiRecommendation: b.ai_recommendation && typeof b.ai_recommendation === 'object'
        ? b.ai_recommendation : undefined,
      tongueColor: b.tongue_color || null,
      tongueCoating: b.tongue_coating || null,
      pulseQuality: b.pulse_quality || null,
      painScale: Number.isInteger(b.pain_scale) ? b.pain_scale : null,
      tcmDiagnosis: b.tcm_diagnosis || null,
      pointsUsed: Array.isArray(b.points_used) ? b.points_used.map(String) : [],
      durationMinutes: Number.isFinite(b.duration_minutes) ? b.duration_minutes : null,
      notes: b.notes || null,
      fee: Number.isFinite(b.fee) ? b.fee : null,
      paymentStatus: status,
    },
    include,
  });
  return reply.code(201).send({ ok: true, session: toSession(s) });
}

async function update(req, reply) {
  const existing = await prisma.session.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });

  const b = req.body || {};
  const s = await prisma.session.update({
    where: { id: existing.id },
    data: {
      chiefComplaint: b.chief_complaint !== undefined ? String(b.chief_complaint).trim() : undefined,
      tongueColor: b.tongue_color !== undefined ? b.tongue_color : undefined,
      tongueCoating: b.tongue_coating !== undefined ? b.tongue_coating : undefined,
      pulseQuality: b.pulse_quality !== undefined ? b.pulse_quality : undefined,
      painScale: Number.isInteger(b.pain_scale) ? b.pain_scale : undefined,
      tcmDiagnosis: b.tcm_diagnosis !== undefined ? b.tcm_diagnosis : undefined,
      pointsUsed: Array.isArray(b.points_used) ? b.points_used.map(String) : undefined,
      durationMinutes: Number.isFinite(b.duration_minutes) ? b.duration_minutes : undefined,
      notes: b.notes !== undefined ? b.notes : undefined,
      fee: Number.isFinite(b.fee) ? b.fee : undefined,
      paymentStatus: ['paid', 'unpaid', 'partial'].includes(b.payment_status)
        ? b.payment_status : undefined,
    },
    include,
  });
  return { ok: true, session: toSession(s) };
}

/** PATCH /v1/sessions/:id/payment {payment_status} — dipakai tombol "tandai lunas". */
async function setPayment(req, reply) {
  const { payment_status } = req.body || {};
  if (!['paid', 'unpaid', 'partial'].includes(payment_status)) {
    return reply.code(400).send({ ok: false, error: 'payment_status tidak valid' });
  }
  const r = await prisma.session.updateMany({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    data: { paymentStatus: payment_status },
  });
  if (r.count === 0) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });
  return { ok: true };
}

async function remove(req, reply) {
  const r = await prisma.session.updateMany({
    where: { id: req.params.id, tenantId: req.user.tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (r.count === 0) return reply.code(404).send({ ok: false, error: 'sesi tidak ditemukan' });
  return { ok: true };
}

module.exports = { list, detail, create, update, setPayment, remove, toSession };
