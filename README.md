# 🎨 Tinta Estafet — Multiplayer Drawing Relay Party Game

Aplikasi web *full-stack real-time* untuk permainan estafet menggambar multipemain (**Tinta Estafet**), dibangun sesuai *blueprint* `1.0.0-prototype` + fitur tambahan *Future Enhancements*.

## 🚀 Cara Menjalankan di Laptop (Lokal)

1. Buka terminal di folder project ini, lalu jalankan:
   ```bash
   node server.js
   ```
2. Buka browser dan kunjungi:
   - **Layar Utama / Game Master:** `http://localhost:3000`
   - **PIN Default Game Master:** `1234`

## 🌐 Cara Agar Pemain Bisa Masuk Pakai Internet / Kuota Masing-Masing

Ada 2 cara mudah agar teman-teman bisa scan QR Code menggunakan kuota internet HP masing-masing (tanpa harus satu Wi-Fi):

### Opsi A: Instan dari Laptop dengan Cloudflare Tunnel (Gratis, Tanpa Registrasi)
Saat `node server.js` sedang berjalan di port `3000`, buka terminal baru dan jalankan:
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Atau menggunakan `localtunnel`:
```bash
npx localtunnel --port 3000
```
Kamu akan mendapatkan URL publik `https://xxxx.trycloudflare.com`. Buka URL tersebut di browser Game Master — **QR Code otomatis mengarah ke link publik tersebut** sehingga semua pemain bebas masuk memakai kuota internet masing-masing!

### Opsi B: Deploy Permanen ke Cloud Hosting (Railway / Render / Fly.io)
Project ini **tidak memiliki ketergantungan library eksternal rumit** (*zero external dependency*, murni Node.js bawaan), sehingga bisa langsung di-*deploy* ke **Railway.app** atau **Render.com**:
- **Build Command:** *(kosongkan atau `npm install`)*
- **Start Command:** `node server.js`

---

## ✨ Fitur yang Tersedia
- **2 Peran (`Player` & `Game Master`):**
  - **Player:** Masuk cukup ketik nama panggilan $\rightarrow$ otomatis dibagi ke grup secara acak & seimbang (selisih maks 1 orang).
  - **Game Master (PIN `1234`):** Menampilkan QR Code SVG otomatis, menyalin link undangan, mengatur jumlah grup (`2–6`), kapasitas tinta (`HEMAT 2200`, `STANDAR 3200`, `BANYAK 4500`), durasi giliran (`15s`, `20s`, `30s`), aturan sisa tinta saat Pass (`INHERITED` / `WASTED`), mengacak ulang grup, menambahkan **Bot cerdas**, dan mengedit **Custom Word Bank**.
- **6 Fase State Machine Lengkap:**
  1. `LOBBY`
  2. `DRAWING` (*Open Relay* dengan *Real-time WebSocket Stroke Streaming*, 8 warna, 3 ukuran kuas dengan *ink multiplier* `1.0x`, `1.6x`, `2.5x`, tanpa tombol Undo)
  3. `READY_TO_GUESS`
  4. `GUESSING` (Sensor jawaban benar di *live chat*, *Fuzzy Matching* toleransi typo 1 huruf)
  5. `REVEAL` (Rincian poin penggambar `+100/penebak`, bonus sisa tinta `1% = +1 poin` dengan syarat min. 1 penebak benar, dan poin penebak `+50`)
  6. `LEADERBOARD` (Klasemen akhir, tabel rincian skor, galeri karya semua grup, serta opsi Multi-Ronde dengan akumulasi skor).
