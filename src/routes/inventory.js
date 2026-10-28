'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { prisma } = require('../db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const RECEIPT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Simpan foto struk; gagal simpan file tidak boleh menggagalkan pencatatan. */
function saveReceipt(tenantId, base64, mime) {
  const ext = RECEIPT_EXT[String(mime || 'image/jpeg')] || 'jpg';
  const raw = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${tenantId}-struk-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return `/uploads/${name}`;
  } catch (e) {
    console.warn('[expense] gagal simpan struk:', e.message);
    return null;
  }
}

function runCatchingDelete(file) {
  try { fs.unlinkSync(file); } catch { /* file sudah tidak ada */ }
}

function toStock(s) {
  return {
    id: s.id, name: s.name, category: s.category,
    quantity: s.quantity, min_quantity: s.minQuantity, unit: s.unit,
    low: s.quantity <= s.minQuantity,
  };
}

async function listStock(req) {
  const { low } = req.query || {};
  const rows = await prisma.stockItem.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { name: 'asc' },
  });
  const items = rows.map(toStock);
  return {
    ok: true,
    count: items.length,
    low_count: items.filter(i => i.low).length,
    items: low === '1' || low === 'true' ? items.filter(i => i.low) : items,
  };
}

async function createStock(req, reply) {
  const b = req.body || {};
  if (!b.name) return reply.code(400).send({ ok: false, error: 'nama barang wajib' });
  const s = await prisma.stockItem.create({
    data: {
      tenantId: req.user.tenantId,
      name: String(b.name).trim(),
      category: b.category || null,
      quantity: Number.isFinite(b.quantity) ? b.quantity : 0,
      minQuantity: Number.isFinite(b.min_quantity) ? b.min_quantity : 0,
      unit: b.unit || null,
    },
  });
  return reply.code(201).send({ ok: true, item: toStock(s) });
}

async function updateStock(req, reply) {
  const existing = await prisma.stockItem.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) return reply.code(404).send({ ok: false, error: 'barang tidak ditemukan' });
  const b = req.body || {};
  const s = await prisma.stockItem.update({
    where: { id: existing.id },
    data: {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      category: b.category !== undefined ? b.category : undefined,
      quantity: Number.isFinite(b.quantity) ? b.quantity : undefined,
      minQuantity: Number.isFinite(b.min_quantity) ? b.min_quantity : undefined,
      unit: b.unit !== undefined ? b.unit : undefined,
    },
  });
  return { ok: true, item: toStock(s) };
}

function toExpense(e) {
  return {
    id: e.id, description: e.description, amount: e.amount,
    category: e.category, date: e.date.toISOString(),
    receipt_url: e.receiptUrl,
  };
}

async function listExpenses(req) {
  const { from, to } = req.query || {};
  const where = { tenantId: req.user.tenantId };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(String(from));
    if (to) where.date.lte = new Date(String(to));
  }
  const rows = await prisma.expense.findMany({ where, orderBy: { date: 'desc' }, take: 300 });
  return {
    ok: true, count: rows.length,
    total: rows.reduce((t, e) => t + e.amount, 0),
    expenses: rows.map(toExpense),
  };
}

async function createExpense(req, reply) {
  const b = req.body || {};
  if (!b.description || !Number.isFinite(b.amount)) {
    return reply.code(400).send({ ok: false, error: 'description dan amount wajib' });
  }
  // struk opsional: disimpan di volume yang sama dengan foto lidah
  const receipt = b.receipt_base64
    ? saveReceipt(req.user.tenantId, b.receipt_base64, b.receipt_mime)
    : null;

  const e = await prisma.expense.create({
    data: {
      tenantId: req.user.tenantId,
      description: String(b.description).trim(),
      amount: b.amount,
      category: b.category || null,
      date: b.date ? new Date(String(b.date)) : new Date(),
      receiptUrl: receipt,
    },
  });
  return reply.code(201).send({ ok: true, expense: toExpense(e) });
}

async function updateExpense(req, reply) {
  const existing = await prisma.expense.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) return reply.code(404).send({ ok: false, error: 'pengeluaran tidak ditemukan' });

  const b = req.body || {};
  const e = await prisma.expense.update({
    where: { id: existing.id },
    data: {
      description: b.description !== undefined ? String(b.description).trim() : undefined,
      amount: Number.isFinite(b.amount) ? b.amount : undefined,
      category: b.category !== undefined ? b.category : undefined,
      date: b.date ? new Date(String(b.date)) : undefined,
    },
  });
  return { ok: true, expense: toExpense(e) };
}

/** Hapus pengeluaran + file struknya, supaya volume tidak menumpuk sampah. */
async function removeExpense(req, reply) {
  const e = await prisma.expense.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!e) return reply.code(404).send({ ok: false, error: 'pengeluaran tidak ditemukan' });

  if (e.receiptUrl) {
    runCatchingDelete(path.join(UPLOAD_DIR, path.basename(e.receiptUrl)));
  }
  await prisma.expense.delete({ where: { id: e.id } });
  return { ok: true };
}

module.exports = {
  listStock, createStock, updateStock,
  listExpenses, createExpense, updateExpense, removeExpense,
};
