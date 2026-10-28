'use strict';
/**
 * Analisis foto lidah dengan Gemini.
 *
 * POST /v1/ai/tongue  { image: "<base64>", mime? }
 *   → { tongue, diagnosis, treatment, points: [], notes }
 *
 * Kunci API disimpan di server (env GEMINI_API_KEY), TIDAK pernah dikirim ke
 * aplikasi: APK bisa dibongkar, env tidak.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 6 * 1024 * 1024;
const PROMPT = `Kamu asisten klinik akupunktur/TCM berbahasa Indonesia.
Lihat foto lidah ini dan beri jawaban HANYA dalam JSON valid, tanpa markdown:
{
  "tongue": "warna & kondisi lidah yang terlihat, 3-8 kata",
  "diagnosis": "pola TCM singkat, maksimal 2 kalimat",
  "treatment": "saran pengobatan ringkas: prinsip terapi + herbal/akupunktur, maksimal 4 poin dipisah ';'",
  "points": ["kode titik akupunktur, maksimal 6, mis. LI4"],
  "notes": "catatan bahwa ini saran bantu, bukan diagnosis final"
}
Jika gambar bukan lidah atau terlalu buram, isi "tongue" dengan "tidak terbaca" dan lainnya kosong.`;

async function tongue(req, reply) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return reply.code(503).send({ ok: false, error: 'Analisis AI belum dikonfigurasi di server' });

  const { image, mime } = req.body || {};
  if (!image) return reply.code(400).send({ ok: false, error: 'Foto wajib dikirim' });

  const b64 = String(image).replace(/^data:[^;]+;base64,/, '');
  if (b64.length * 0.75 > MAX_BYTES) {
    return reply.code(413).send({ ok: false, error: 'Foto terlalu besar (maks 6 MB)' });
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mime || 'image/jpeg', data: b64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      // 2.5-flash memakai token untuk "thinking" sebelum menjawab. Dengan 700
      // token, jawaban JSON sering terpotong di tengah → gagal di-parse.
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let res, text;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    text = await res.text();
  } catch (e) {
    return reply.code(502).send({ ok: false, error: 'Tidak dapat menghubungi layanan AI' });
  }

  if (!res.ok) {
    const msg = (() => { try { return JSON.parse(text)?.error?.message || ''; } catch { return ''; } })();
    return reply.code(502).send({ ok: false, error: 'AI menolak: ' + (msg || res.status) });
  }

  let parsed = null;
  let finish = '';
  let raw = '';
  try {
    const d = JSON.parse(text);
    finish = d.candidates?.[0]?.finishReason || '';
    raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    // sertakan cuplikan balasan: tanpa ini "tidak bisa dibaca" tidak bisa ditelusuri
    const why = finish === 'MAX_TOKENS' ? 'jawaban AI terpotong' : finish || 'balasan bukan JSON';
    return reply.code(502).send({
      ok: false,
      error: `Balasan AI tidak bisa dibaca (${why})`,
      detail: raw.slice(0, 300),
    });
  }

  return {
    ok: true,
    tongue: String(parsed.tongue || '').slice(0, 120),
    diagnosis: String(parsed.diagnosis || '').slice(0, 400),
    treatment: String(parsed.treatment || '').slice(0, 600),
    points: Array.isArray(parsed.points)
      ? parsed.points.map((p) => String(p).toUpperCase().slice(0, 12)).slice(0, 6)
      : [],
    notes: String(parsed.notes || 'Saran bantu, bukan diagnosis final.').slice(0, 200),
  };
}

module.exports = { tongue };
