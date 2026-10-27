# AcuMedis API

Backend khusus **app Android AcuMedis**. Tanpa web, tanpa cookie — JWT bearer.

Node 20 + Fastify 4 + Prisma 5 (PostgreSQL).

## Endpoint

Publik:

- `GET /api/health` → `{ok, db, version}`
- `POST /v1/auth/login` `{email, password, deviceId?}` → `{accessToken, refreshToken, user}`
- `POST /v1/auth/refresh` `{refreshToken}` → rotasi token
- `POST /v1/auth/logout` `{refreshToken}`

Wajib `Authorization: Bearer <accessToken>`:

- `GET /v1/me`
- `GET /v1/summary?date=YYYY-MM-DD` — ringkasan beranda
- `GET /v1/sync?since=ISO` — tarik semua perubahan (mode offline)
- `GET/POST /v1/patients`, `GET/PATCH/DELETE /v1/patients/:id`
- `GET/POST /v1/sessions`, `GET/PATCH/DELETE /v1/sessions/:id`
- `PATCH /v1/sessions/:id/payment` — tandai lunas/belum
- `POST /v1/sessions/:id/photos` `{base64, mime, type}` — foto lidah (simpan file, bukan base64 di DB)
- `GET/POST/PATCH /v1/appointments`
- `GET/POST/PATCH /v1/stock`
- `GET/POST /v1/expenses`
- `GET /uploads/:name` — file foto

Semua daftar mendukung `?since=ISO` untuk sinkronisasi bertahap.

## Env

| Variabel | Wajib | Keterangan |
|---|---|---|
| `DATABASE_URL` | ya | `postgres://user:pass@host:5432/db` |
| `JWT_SECRET` | ya | minimal 24 karakter |
| `ACCESS_TTL` | tidak | default `30m` |
| `REFRESH_DAYS` | tidak | default `30` |
| `UPLOAD_DIR` | tidak | default `/data/uploads` (butuh volume persisten) |
| `SEED_EMAIL` / `SEED_PASSWORD` / `SEED_CLINIC` | tidak | dipakai `npm run seed` |

## Jalan lokal

```bash
npm install
export DATABASE_URL=postgres://postgres:pw@localhost:5432/acumedis
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx prisma db push
npm run seed
npm start
curl localhost:3000/api/health
```

## Test

```bash
node --test test/auth.test.js test/http.test.js
```

13 test: JWT (4), guard & validasi (9). Tidak butuh DB.

## Docker

```bash
docker build -t acumedis-api .
docker run -p 3000:3000 -v acumedis-uploads:/data/uploads \
  -e DATABASE_URL=... -e JWT_SECRET=... acumedis-api
```

Container menjalankan `prisma db push` saat start supaya tabel selalu sinkron.

## Perbedaan dari backend web lama

- Auth JWT + refresh token rotasi (web: cookie NextAuth)
- Foto disimpan sebagai file, DB hanya URL (web: base64 di kolom)
- Endpoint `/sync` untuk offline (web: tidak ada)
- Soft delete pada pasien/sesi/jadwal agar rekam medis tidak hilang
- Tanpa dashboard web, tanpa halaman publik
