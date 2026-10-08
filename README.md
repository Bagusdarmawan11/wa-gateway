# Synpera — WhatsApp API Gateway

Platform WhatsApp API multi-user & multi-device oleh PT. Catindo Bagus Perkasa.
Setiap pengguna dapat mendaftar, menghubungkan hingga 5 nomor WhatsApp, dan mengelola
masing-masing device dengan token API, webhook, autoreply, flow builder, dan lainnya.

## Fitur

- Landing page modern (dark/light mode, animasi, liquid glass navbar)
- Register & login (bcrypt + JWT cookie), hide/unhide password
- Multi-device: 1 akun hingga 5 nomor WhatsApp, token API per device
- Kirim teks, gambar, video, audio & dokumen (upload atau URL), personal & grup
- Broadcast dengan jeda acak aman, pesan terjadwal
- Autoreply keyword (personal/grup, contains/exact)
- Flow builder visual (kondisi keyword, delay, balas teks/media)
- Webhook: pesan masuk, status koneksi, status pesan, chaining
- Whitelist IP untuk token API
- Daftar grup WhatsApp per device
- Autoread, silent read, inbox, quick reply, forward attachment, autodelete
- Session WhatsApp tersimpan di database (tidak hilang saat redeploy)

## Struktur

```
src/
  index.js       — server Express & semua route
  auth.js        — register/login, JWT cookie, token API (device + master)
  wa.js          — manajer multi-device Baileys, kirim media, grup, webhook
  flow.js        — eksekutor flow builder
  auth-state.js  — session Baileys per device di PostgreSQL
  db.js          — koneksi Neon + skema & migrasi tabel
public/
  index.html     — landing page
  login.html / register.html
  dashboard.html — dashboard per user
  flow.html      — editor flow visual
  assets/        — logo & favicon Synpera
```

## Deploy ke Render (gratis)

1. **Database**: buat project gratis di [neon.tech](https://neon.tech), salin connection string.
2. **GitHub**: push folder ini ke repo kamu.
3. **Render**: New → Web Service → pilih repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables:
     - `DATABASE_URL` = connection string Neon
     - `JWT_SECRET` = string acak panjang (`openssl rand -hex 32`)
     - `NODE_ENV` = `production`
4. **Anti-tidur** (free tier): cron di [cron-job.org](https://cron-job.org)
   memanggil `https://URL-APP.onrender.com/health` tiap 10 menit.

## Menjalankan lokal

```bash
cp .env.example .env   # isi DATABASE_URL & JWT_SECRET
npm install
npm run dev
```

Buka http://localhost:3000

## API (token device)

Header: `Authorization: Bearer <TOKEN_DEVICE>` (diawali `syn_`).
Master token akun (`wgt_`) juga bisa dipakai — memakai device pertama akun.

| Endpoint | Method | Fungsi |
|---|---|---|
| /api/send | POST | Kirim teks / media (JSON `media_url` atau multipart `file`) |
| /api/broadcast | POST | Broadcast maks 100 nomor, jeda otomatis |
| /api/schedule | POST | Jadwalkan pesan |
| /api/device | GET | Info & status device |

Contoh ada di menu **API & Token** pada dashboard (otomatis terisi token kamu).

## Migrasi dari v2

Semua migrasi database otomatis saat server start:
- Session lama per-user dipindahkan ke "Device 1" milik user tersebut
- Data autoreply/jadwal/log ikut terpindah
- Pengguna cukup login seperti biasa

## Catatan

- Bukan produk resmi WhatsApp/Meta — gunakan secara wajar untuk menghindari banned.
- File media maksimal 20MB per pengiriman.
