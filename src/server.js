'use strict';

const Fastify = require('fastify');
const { prisma } = require('./db');
const { requireAuth } = require('./auth');

const auth = require('./routes/auth');
const sso = require('./routes/sso');
const logs = require('./routes/logs');
const admin = require('./routes/admin');
const reset = require('./routes/reset');
const settings = require('./routes/settings');
const ai = require('./routes/ai');
const patients = require('./routes/patients');
const sessions = require('./routes/sessions');
const appointments = require('./routes/appointments');
const photos = require('./routes/photos');
const reports = require('./routes/reports');
const inventory = require('./routes/inventory');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = process.env.APP_VERSION || '1.0.0';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
  console.error('FATAL: JWT_SECRET wajib diisi minimal 24 karakter');
  process.exit(1);
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 12 * 1024 * 1024 });

// Health & version: tanpa auth, dipakai app untuk cek server dan cek update
app.get('/', async () => ({ ok: true, service: 'acumedis-api', version: VERSION }));
app.get('/api/health', async () => {
  let db = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = 'up';
  } catch { /* tetap laporkan down */ }
  return { ok: db === 'up', service: 'acumedis-api', version: VERSION, db };
});

// Auth (publik)
app.post('/v1/auth/login', auth.login);
app.post('/v1/auth/refresh', auth.refresh);
app.post('/v1/auth/logout', auth.logout);

// SSO Z One (device-code): start & poll dipanggil app, claim dipanggil server Z One
app.post('/v1/auth/sso/start', sso.start);
app.post('/v1/auth/sso/claim', sso.claim);
app.get('/v1/auth/sso/poll', sso.poll);
app.post('/v1/auth/sso/exchange', sso.exchange);

// Reset password dengan kode 6 digit (dibuat admin dari Z One)
app.post('/v1/auth/reset/verify', reset.verify);

// Log error dari app — publik, identitas perangkat lewat header X-Device-Id
app.post('/v1/logs', logs.create);

// Jembatan admin Z One (hub): auth Bearer CROSS_APP_SECRET, bukan JWT app
app.get('/api/admin/cross-app', admin.get);
app.post('/api/admin/cross-app', admin.post);

// Semua di bawah ini wajib Bearer token
app.register(async (r) => {
  r.addHook('preHandler', requireAuth);

  r.get('/v1/me', auth.me);
  r.get('/v1/summary', reports.summary);
  r.get('/v1/sync', reports.sync);

  // pengaturan klinik + daftar praktisi
  r.get('/v1/settings', settings.get);
  r.patch('/v1/settings', settings.update);
  r.post('/v1/practitioners', settings.createPractitioner);
  r.patch('/v1/practitioners/:id', settings.updatePractitioner);
  r.delete('/v1/practitioners/:id', settings.removePractitioner);

  // analisis foto lidah (Gemini, kunci di server)
  r.post('/v1/ai/tongue', ai.tongue);

  // baca & purge log error (owner/admin)
  r.get('/v1/logs', logs.list);
  r.delete('/v1/logs', logs.purge);

  r.get('/v1/patients', patients.list);
  r.get('/v1/patients/:id', patients.detail);
  r.post('/v1/patients', patients.create);
  r.patch('/v1/patients/:id', patients.update);
  r.delete('/v1/patients/:id', patients.remove);

  r.get('/v1/sessions', sessions.list);
  r.get('/v1/sessions/:id', sessions.detail);
  r.post('/v1/sessions', sessions.create);
  r.patch('/v1/sessions/:id', sessions.update);
  r.patch('/v1/sessions/:id/payment', sessions.setPayment);
  r.delete('/v1/sessions/:id', sessions.remove);
  r.post('/v1/sessions/:id/photos', photos.upload);
  r.delete('/v1/sessions/:id/photos/:photoId', photos.remove);

  r.get('/v1/appointments', appointments.list);
  r.post('/v1/appointments', appointments.create);
  r.patch('/v1/appointments/:id', appointments.update);
  r.delete('/v1/appointments/:id', appointments.remove);

  r.get('/v1/stock', inventory.listStock);
  r.post('/v1/stock', inventory.createStock);
  r.patch('/v1/stock/:id', inventory.updateStock);
  r.get('/v1/expenses', inventory.listExpenses);
  r.post('/v1/expenses', inventory.createExpense);
});

// Foto: dipakai app dengan header Authorization; URL-nya relatif
app.get('/uploads/:name', photos.serve);

const start = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async () => {
  try { await app.close(); } catch { /* ignore */ }
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
