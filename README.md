# WA Gateway — WhatsApp API Gateway Pribadi

Sistem seperti Fonnte versi pribadi: kirim pesan, broadcast, autoreply, dan penjadwalan lewat API ber-token, dengan dashboard web. Dibangun dengan **Baileys + Express + Neon PostgreSQL**, siap jalan 24 jam gratis di **Render**.

## Fitur

- ✅ Koneksi WhatsApp via QR (session tersimpan di Neon, tidak hilang saat redeploy)
- ✅ Dashboard web: scan QR, kelola token, autoreply, jadwal, log pesan
- ✅ API ber-token untuk orang lain: `/api/send`, `/api/broadcast`, `/api/schedule`
- ✅ Broadcast dengan jeda acak (mengurangi risiko banned)
- ✅ Autoreply keyword (mode *mengandung* / *persis*)
- ✅ Pesan terjadwal (cron tiap menit)
- ✅ Log semua pesan masuk & keluar

---

## 1. Siapkan Database Neon (gratis)

1. Buat akun di [neon.tech](https://neon.tech) → **Create Project**
2. Salin **connection string**, bentuknya:
   ```
   postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

## 2. Upload ke GitHub

```bash
cd wa-gateway
git init
git add .
git commit -m "WA Gateway"
git branch -M main
git remote add origin https://github.com/USERNAME/wa-gateway.git
git push -u origin main
```

## 3. Deploy ke Render (gratis)

1. Buat akun di [render.com](https://render.com) (login dengan GitHub)
2. **New → Web Service** → pilih repo `wa-gateway`
3. Render otomatis membaca `render.yaml`. Isi 2 environment variable saat diminta:
   - `DATABASE_URL` → connection string Neon dari langkah 1
   - `ADMIN_TOKEN` → buat token rahasia sendiri (untuk login dashboard)
4. Klik **Deploy**

## 4. Jaga agar tidak "tidur" (penting!)

Free tier Render tidur setelah 15 menit tanpa request. Solusi gratis:

1. Buka [cron-job.org](https://cron-job.org) → buat akun gratis
2. Buat cron job: URL `https://NAMA-APP.onrender.com/health`, interval **tiap 10 menit**

Server akan tetap bangun 24 jam.

## 5. Hubungkan WhatsApp

1. Buka `https://NAMA-APP.onrender.com`
2. Masukkan `ADMIN_TOKEN`
3. Di tab **Status & QR**, scan QR dengan WhatsApp → *Perangkat Tertaut*
4. Selesai! Session tersimpan di Neon, tidak perlu scan ulang saat restart.

---

## Cara Pakai API (untuk dibagikan ke orang lain)

Buat token di dashboard (tab **API Token**), lalu berikan ke pemakai.

### Kirim pesan
```bash
curl -X POST https://NAMA-APP.onrender.com/api/send \
  -H "Authorization: Bearer wgt_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"target":"08123456789","message":"Halo!"}'
```

### Broadcast (maks 100 nomor/request)
```bash
curl -X POST https://NAMA-APP.onrender.com/api/broadcast \
  -H "Authorization: Bearer wgt_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"targets":["08111","08222"],"message":"Promo!","delay_ms":4000}'
```

### Jadwalkan pesan
```bash
curl -X POST https://NAMA-APP.onrender.com/api/schedule \
  -H "Authorization: Bearer wgt_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"target":"08123456789","message":"Reminder meeting","run_at":"2026-10-08T09:00:00+07:00"}'
```

---

## Menjalankan secara lokal (opsional)

```bash
cp .env.example .env   # isi DATABASE_URL & ADMIN_TOKEN
npm install
npm run dev
# buka http://localhost:3000
```

## Catatan Penting

- ⚠️ Ini **bukan API resmi WhatsApp**. Broadcast masif/agresif bisa menyebabkan nomor **di-banned permanen**. Gunakan jeda antar pesan, jangan spam.
- 🔒 Jangan pernah commit file `.env` ke GitHub (sudah ada di `.gitignore`).
- 🔑 Ganti `ADMIN_TOKEN` secara berkala dan jangan bagikan ke pemakai biasa — mereka cukup pakai token API-nya masing-masing.
