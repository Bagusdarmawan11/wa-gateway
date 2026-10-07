# WA Gateway v2 — WhatsApp API Gateway Multi-User

Seperti Fonnte, tapi milikmu sendiri. Setiap pengguna bisa daftar, login, scan QR dengan
nomor WhatsApp-nya masing-masing, dan mendapat API token pribadi.

## Fitur

- 🌐 **Landing page** modern dengan liquid glass navbar + animasi
- 👤 **Register & Login** (password ter-hash bcrypt, sesi via cookie JWT)
- 📱 **Multi-session** — tiap user menghubungkan nomor WA sendiri via scan QR
- ✉️ **Kirim teks, gambar, video, audio & dokumen** (upload file atau via URL)
- 📡 **Broadcast** dengan jeda acak 2–6 detik (anti-banned)
- 🗓️ **Pesan terjadwal** (cron tiap menit)
- ⚡ **Autoreply** berbasis keyword (mode contains / exact)
- 🔑 **API token per user** (bisa di-regenerate)
- 📜 **Riwayat pesan** masuk & keluar
- 💾 **Session WA tersimpan di Neon** — tidak hilang saat redeploy

## Struktur

```
src/
  index.js       — server Express & semua route
  auth.js        — register/login, JWT cookie, token API
  wa.js          — manajer multi-session Baileys + kirim media
  auth-state.js  — session Baileys disimpan ke PostgreSQL
  db.js          — koneksi Neon + skema tabel
public/
  index.html     — landing page
  login.html     — halaman masuk
  register.html  — halaman daftar
  dashboard.html — dashboard per user
```

## Deploy ke Render (gratis)

1. **Database**: buat project gratis di [neon.tech](https://neon.tech), salin connection string.
2. **GitHub**: push folder ini ke repo kamu.
3. **Render**: New → Web Service → pilih repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables:
     - `DATABASE_URL` = connection string Neon
     - `JWT_SECRET` = string acak panjang (misal hasil `openssl rand -hex 32`)
     - `NODE_ENV` = `production`
4. **Anti-tidur** (free tier): buat cron di [cron-job.org](https://cron-job.org)
   yang memanggil `https://URL-APP-RENDER.onrender.com/health` tiap 10 menit.

## Menjalankan lokal

```bash
cp .env.example .env   # isi DATABASE_URL & JWT_SECRET
npm install
npm run dev
```

Buka http://localhost:3000

## API (untuk pemegang token)

Semua endpoint butuh header: `Authorization: Bearer <API_TOKEN>`

### Kirim teks
```bash
curl -X POST https://URL-APP/api/send \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"628xxxxxxxxxx","message":"Halo!"}'
```

### Kirim file (gambar / video / audio / dokumen)
```bash
curl -X POST https://URL-APP/api/send \
  -H "Authorization: Bearer TOKEN" \
  -F "target=628xxxxxxxxxx" \
  -F "message=Caption di sini" \
  -F "file=@invoice.pdf"
```

### Kirim media via URL
```json
POST /api/send
{"target":"628xxx","media_url":"https://contoh.com/gambar.jpg","message":"caption"}
```

### Broadcast (maks 100 nomor)
```json
POST /api/broadcast
{"targets":["628xxx","628yyy"],"message":"Promo!","delay_ms":3000}
```

### Pesan terjadwal
```json
POST /api/schedule
{"target":"628xxx","message":"Reminder","run_at":"2026-10-10T09:00:00+07:00"}
```

## Catatan penting

- Ini **bukan** API resmi WhatsApp. Hindari spam/broadcast masif ke nomor asing agar
  nomor tidak terkena banned.
- File media maksimal 20MB per pengiriman.
- Data lama dari v1 (single-user) otomatis diklaim oleh user pertama yang mendaftar.
