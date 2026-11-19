# 📡 PROTOCOL.md — Spesifikasi Protokol Komunikasi Tinta Estafet

Dokumen ini mendeskripsikan protokol jaringan, format pesan JSON (WebSocket & HTTP REST), struktur *state* per fase, alur sesi penuh, serta batasan server berdasarkan implementasi kode aktual di `server.js` dan `public/app.js`.

---

## 1. KONEKSI

### 1.1 Endpoint WebSocket
- **URL Klien:** `ws://<host>/ws` atau `wss://<host>/ws` (dibuat di `public/app.js` baris `91–93`).
- **Perilaku Upgrade di Server (`server.js` baris `1730–1766`):**
  - Server menangani event `server.on("upgrade", (req, socket) => ...)` secara manual sesuai standar **RFC 6455** tanpa mengecek `req.url`, sehingga setiap request HTTP dengan header `Upgrade: websocket` (termasuk `/ws`) akan di-*upgrade* ke koneksi WebSocket.
  - Begitu handshake `101 Switching Protocols` selesai, server menyimpan objek `socket` ke `wsClients` (`Map<Socket, clientMeta>`) dan langsung mengirim pesan `STATE_UPDATE` awal.

### 1.2 Endpoint HTTP Fallback / REST API
Aplikasi menggunakan pola *hybrid*:
- **Klien $\rightarrow$ Server untuk Goresan Kanvas (`DRAW_STROKE`):** dikirim via **WebSocket** (`type: "ACTION"`) agar bebas latensi, dengan fallback ke `POST /api/action` bila WebSocket sedang tidak `OPEN`.
- **Klien $\rightarrow$ Server untuk Semua Action Lainnya:** dikirim via **`POST /api/action`** agar klien mendapat *response callback* langsung sekaligus memicu `broadcastState()` ke seluruh klien WebSocket.

#### A. `GET /api/state` (`server.js` baris `1618–1638`)
Mengambil *snapshot* state permainan saat ini (digunakan saat inisialisasi halaman).
- **Method:** `GET`
- **Query Parameters:**
  - `role` *(opsional)*: `"player"` (default) atau `"game_master"`.
  - `playerId` *(opsional)*: UUID pemain jika sudah bergabung.
  - `deviceId` *(opsional)*: ID unik perangkat (`dev-...`).
  - `pin` *(opsional)*: PIN Game Master (alternatif dari header `X-GM-Pin`).
- **Headers:**
  - `Cookie`: `tinta_device_id=<deviceId>` (diset otomatis oleh server/klien).
  - `X-GM-Pin` *(wajib bila `role=game_master`)*: `"PIN_DIKIRIM"`. Jika tidak cocok dengan `GM_DEFAULT_PIN`, server otomatis menurunkan `verifiedRole` menjadi `"player"`.
- **Response Body (`200 OK`, `application/json; charset=utf-8`):**
  ```json
  {
    "ok": true,
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "gmVerified": false,
    "state": { "...objek buildClientState..." }
  }
  ```

#### B. `POST /api/action` (`server.js` baris `1641–1694`)
Menjalankan sebuah aksi pemain atau Game Master.
- **Method:** `POST`
- **Headers:**
  - `Content-Type: application/json`
  - `X-GM-Pin: PIN_DIKIRIM` *(dikirim oleh klien jika `client.role === "game_master"`)*
- **Request Body:**
  ```json
  {
    "action": "NAMA_ACTION",
    "payload": {
      "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
    },
    "role": "player",
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "gmPin": ""
  }
  ```
- **Response Body (`200 OK`):**
  Menggabungkan objek hasil `handleAction(...)` dengan `deviceId` dan `state` terbaru:
  ```json
  {
    "ok": true,
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "state": { "...objek buildClientState..." }
  }
  ```

### 1.3 Arsitektur Room (Single Global Room)
- **Hanya ada 1 room global** di dalam memori proses Node.js (`const gameState = { ... }` di `server.js` baris `55–76`).
- Seluruh koneksi HTTP dan WebSocket pada satu instance server berinteraksi dengan objek `gameState` yang sama. Tidak ada konsep `roomId` atau multi-room.

### 1.4 Peran Cookie `tinta_device_id` vs `deviceId` di Dalam Pesan
Sistem menerapkan aturan **1 Perangkat = 1 Pemain** menggunakan `deviceId`:
1. **Di Klien (`public/app.js` baris `12–27`):** Fungsi `getOrCreateDeviceId()` membaca cookie `tinta_device_id` dan `localStorage["tinta_estafet_device_id"]`. Jika belum ada, klien membuat string `dev-<UUID>`, lalu menyimpannya di kedua tempat (`localStorage` dan `document.cookie` dengan `max-age=86400; SameSite=Lax`).
2. **Di Server (`server.js` baris `1607–1615` & `1750–1756`):**
   - Pada setiap request HTTP, jika cookie `tinta_device_id` belum ada, server membuat `dev-<UUID>` dan mengirim header `Set-Cookie: tinta_device_id=...; Path=/; Max-Age=86400; SameSite=Lax`.
   - Saat koneksi WebSocket dibuka (`upgrade`), server mengisi `clientMeta.deviceId` awal dari cookie `tinta_device_id`.
3. **Prioritas Resolusi:**
   - Pada `POST /api/action` (`server.js` baris `1651–1653`), server mengutamakan `data.payload.deviceId`, lalu `data.deviceId`, dan terakhir fallback ke `cookieDeviceId`.
   - Pada WebSocket `IDENTIFY` (`server.js` baris `1818–1820`), `msg.deviceId` di dalam pesan JSON akan menimpa `clientMeta.deviceId` yang berasal dari cookie.
   - Dalam `buildClientState` (`server.js` baris `809–812`), jika `playerId` tidak ditemukan, server mencari pemain non-Bot yang memiliki `p.deviceId === deviceId` dan mengembalikannya pada field `boundPlayer`, sehingga tab/window baru di perangkat yang sama otomatis terikat ke pemain yang sama.

---

## 2. PESAN DARI KLIEN KE SERVER

Klien berkomunikasi melalui **2 kanal**:
1. **Frame Teks WebSocket (`opcode 0x1`)**: memiliki properti `type` (`"IDENTIFY"` atau `"ACTION"`).
2. **HTTP `POST /api/action`**: membungkus `{ action, payload, role, playerId, deviceId, gmPin }`.

*(Catatan tentang Ganti Warna / Ukuran Kuas / Penghapus: perubahan warna `selectedColor`, ukuran kuas `selectedBrushSize`, dan mode `isEraser` hanya disimpan di memori lokal browser di `public/app.js` baris `1237–1261` dan **tidak dikirim sebagai pesan tersendiri ke server**. Warna dan ukuran kuas baru dikirim ke server sebagai bagian dari setiap segmen garis saat aksi `DRAW_STROKE`).*

---

### 2.1 Pesan WebSocket `IDENTIFY`
Dikirim otomatis oleh klien tepat saat koneksi WebSocket `open` (`public/app.js` baris `96–106`), setelah pemain berhasil `JOIN_PLAYER` (`baris 531–539`), dan setelah login GM berhasil (`baris 2116–2125`).

#### A. `IDENTIFY` untuk Pemain Biasa
- **Field Wajib:** `type` (`"IDENTIFY"`).
- **Field Opsional:** `role` (`"player"`), `playerId` (UUID pemain atau `null` jika belum join), `deviceId` (string), `pin` (`""`).
```json
{
  "type": "IDENTIFY",
  "role": "player",
  "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "pin": ""
}
```

#### B. `IDENTIFY` untuk Game Master
- **Field Wajib:** `type` (`"IDENTIFY"`), `role` (`"game_master"`), `pin` (`"PIN_DIKIRIM"`, wajib cocok dengan `GM_DEFAULT_PIN` agar socket ditandai sebagai `game_master`).
- **Field Opsional:** `deviceId`.
```json
{
  "type": "IDENTIFY",
  "role": "game_master",
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "pin": "PIN_DIKIRIM"
}
```

---

### 2.2 Aksi Pemain Biasa & Autentikasi

#### 1. `JOIN_PLAYER`
Dikirim via `POST /api/action` saat pemain menekan tombol *"Masuk & Gabung Grup Otomatis"* di halaman masuk (`ENTRY`). Dapat dikirim di fase mana saja selama jumlah pemain `< maxPlayers`.
- **Field `payload` Wajib:** `name` (string, di-*trim* & dipotong maks 24 karakter; wajib jika perangkat belum terdaftar).
- **Field `payload` Opsional:** `playerId` (UUID sesi sebelumnya), `deviceId` (string).
```json
{
  "action": "JOIN_PLAYER",
  "payload": {
    "name": "Budi",
    "playerId": null,
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  },
  "role": "player",
  "playerId": null,
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "gmPin": ""
}
```

#### 2. `AUTH_GM`
Dikirim via `POST /api/action` saat pengguna memasukkan PIN di modal Akses Game Master. Dapat dilakukan di fase mana saja (jika dilakukan saat `LOBBY` dan perangkat tersebut sebelumnya sudah masuk sebagai pemain, data pemainnya otomatis dihapus dari daftar grup agar tidak menjadi pemain kosong).
- **Field `payload` Wajib:** `pin` (`"PIN_DIKIRIM"`).
- **Field `payload` Opsional:** `playerId`, `deviceId`.
```json
{
  "action": "AUTH_GM",
  "payload": {
    "pin": "PIN_DIKIRIM",
    "playerId": null,
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  },
  "role": "player",
  "playerId": null,
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "gmPin": ""
}
```

#### 3. `DRAW_STROKE` (Streaming Goresan Menggambar)
- **Syarat Fase:** `gameState.phase === "DRAWING"`, `group.status === "DRAWING"`, dan `playerId` harus sama dengan pemain yang sedang mendapat giliran aktif (`members[group.currentTurnIndex].id`).
- **Kapan & Seberapa Sering Dikirim (`public/app.js` baris `1466–1486`):**
  Dikirim secara *real-time* pada event `mousemove` / `touchmove` selama pointer ditekan (`isDrawingPointerDown === true`) setiap kali jarak Euclidean (`Math.hypot(pt.x - lastPoint.x, pt.y - lastPoint.y)`) بين titik baru dan titik terakhir **$\ge 2$ piksel** pada sistem koordinat kanvas `800 x 500`. Server menolak segmen dengan jarak `< 0.2` piksel.
- **Format Titik, Warna, dan Ukuran:**
  - `x1, y1, x2, y2`: angka koordinat pada kanvas `800x500` (di-*clamp* `0..800` untuk `x` dan `0..500` untuk `y`, dibulatkan 1 angka desimal di server).
  - `color`: string hex warna dari daftar `DRAWING_TOOLS.colors` (`"#000000"`, `"#EF4444"`, `"#3B82F6"`, `"#10B981"`, `"#F59E0B"`, `"#8B5CF6"`, `"#EC4899"`, `"#92400E"`), atau `"#FFFFFF"` jika penghapus aktif.
  - `size`: angka ukuran kuas (`3` = Tipis `1.0x tinta`, `6` = Sedang `1.6x tinta`, `11` = Tebal `2.5x tinta`).
  - `isEraser`: boolean (`true` jika memakai penghapus `0x tinta`, `false` jika kuas warna).
- **Contoh JSON (dikirim via WebSocket `type: "ACTION"`):**
```json
{
  "type": "ACTION",
  "action": "DRAW_STROKE",
  "payload": {
    "groupId": 1,
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "segment": {
      "x1": 240.5,
      "y1": 180.0,
      "x2": 245.2,
      "y2": 183.8,
      "color": "#EF4444",
      "size": 6,
      "isEraser": false
    }
  }
}
```

#### 4. `PASS_TURN`
Dikirim via `POST /api/action` saat pemain yang sedang mendapat giliran aktif menekan tombol *"⏭️ Pass / Selesai Giliran"*.
- **Syarat Fase:** `DRAWING` (dan `group.status !== "FINISHED"`, serta `payload.playerId` wajib cocok dengan pemain aktif di grup tersebut).
- **Field `payload` Wajib:** `groupId` (number), `playerId` (string).
```json
{
  "action": "PASS_TURN",
  "payload": {
    "groupId": 1,
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  },
  "role": "player",
  "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "gmPin": ""
}
```

#### 5. `SUBMIT_GUESS`
Dikirim via `POST /api/action` saat pemain dari grup penebak mengirim form tebakan.
- **Syarat Fase:** `gameState.phase === "GUESSING"`, pemain bukan anggota dari grup yang gambarnya sedang ditebak (`player.groupId !== targetGroup.id`), dan pemain tersebut belum pernah menebak benar untuk gambar grup ini.
- **Field `payload` Wajib:** `playerId` (string), `text` (string, di-*trim* dan dipotong maks 60 karakter).
```json
{
  "action": "SUBMIT_GUESS",
  "payload": {
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "text": "Kucing",
    "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  },
  "role": "player",
  "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
  "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "gmPin": ""
}
```

---

### 2.3 Semua Aksi Game Master (`GM_ONLY_ACTIONS`)
Seluruh aksi di bawah ini terdaftar di `GM_ONLY_ACTIONS` (`server.js` baris `1014–1036`). Setiap request via `POST /api/action` **wajib** menyertakan `"role": "game_master"` dan `"gmPin": "PIN_DIKIRIM"` (atau header HTTP `X-GM-Pin: PIN_DIKIRIM`). Jika dikirim lewat WebSocket, koneksi harus sudah terautentikasi sebagai `game_master` melalui `IDENTIFY`.

#### 1. `UPDATE_SETTINGS`
- **Syarat Fase:** Hanya `LOBBY` (dan `groupCount` hanya bisa diubah jika `teamsLocked === false`).
- **Field `payload` Opsional:**
  - `maxPlayers`: `20 | 30 | 40 | 50 | 60`
  - `groupCount`: `2 | 3 | 4 | 5 | 6 | 7 | 8`
  - `inkCapacityMode`: `"HEMAT" | "STANDAR" | "BANYAK"`
  - `turnDurationSeconds`: `0 | 15 | 20 | 30`
  - `passInkBehavior`: `"PORSI_TETAP" | "INHERITED" | "WASTED"`
  - `fuzzyMatching`: `boolean`
```json
{
  "action": "UPDATE_SETTINGS",
  "payload": {
    "maxPlayers": 40,
    "groupCount": 4,
    "inkCapacityMode": "STANDAR",
    "turnDurationSeconds": 20,
    "passInkBehavior": "PORSI_TETAP",
    "fuzzyMatching": true,
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 2. `RESHUFFLE_GROUPS`
Mengacak ulang pembagian grup dan urutan giliran seluruh pemain secara seimbang.
- **Syarat Fase:** Hanya `LOBBY` dan `teamsLocked === false`.
```json
{
  "action": "RESHUFFLE_GROUPS",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 3. `MOVE_PLAYER_GROUP`
Memindahkan seorang pemain ke grup lain secara manual.
- **Syarat Fase:** Hanya `LOBBY`.
- **Field `payload` Wajib:** `playerId` (string), `targetGroupId` (integer `1..groupCount`).
```json
{
  "action": "MOVE_PLAYER_GROUP",
  "payload": {
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "targetGroupId": 2,
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 4. `MOVE_PLAYER_ORDER`
Menaikkan atau menurunkan nomor urut giliran pemain di dalam grupnya.
- **Syarat Fase:** Hanya `LOBBY`.
- **Field `payload` Wajib:** `playerId` (string), `direction` (`"UP"` atau `"DOWN"`).
```json
{
  "action": "MOVE_PLAYER_ORDER",
  "payload": {
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "direction": "UP",
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 5. `ADD_BOT`
Menambahkan pemain Bot ke grup yang anggotanya paling sedikit.
- **Syarat Fase:** Hanya `LOBBY` (dan total pemain belum mencapai `maxPlayers`).
- **Field `payload` Opsional:** `count` (number `1..12`, default `1`).
```json
{
  "action": "ADD_BOT",
  "payload": {
    "count": 4,
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 6. `REMOVE_BOTS`
Menghapus seluruh Bot dari room.
- **Syarat Fase:** Hanya `LOBBY`.
```json
{
  "action": "REMOVE_BOTS",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 7. `KICK_PLAYER`
Mengeluarkan 1 pemain tertentu dan mengirim pesan WebSocket `PLAYER_KICKED` ke socket pemain tersebut.
- **Syarat Fase:** Bisa di fase mana saja (di UI tombolnya tampil di `LOBBY`; jika dipanggil saat `DRAWING`, server otomatis merapikan `turnOrder` dan melanjutkan giliran bila pemain yang sedang menggambar di-kick).
- **Field `payload` Wajib:** `playerId` (string).
```json
{
  "action": "KICK_PLAYER",
  "payload": {
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 8. `UPDATE_WORD_BANK`
Mengganti daftar kata objek (`customWords`).
- **Syarat Fase:** Bebas (di UI diakses dari `LOBBY`).
- **Validasi:** Minimal 6 kata, setiap kata panjangnya $\ge 2$ karakter, dan **tidak boleh mengandung spasi** (wajib 1 kata per objek).
- **Field `payload` Wajib:** `words` (`string[]`).
```json
{
  "action": "UPDATE_WORD_BANK",
  "payload": {
    "words": ["Kucing", "Gajah", "Sepeda", "Payung", "Gunung", "Roket"],
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 9. `START_DRAWING_PHASE`
Memulai fase menggambar estafet (`LOBBY` $\rightarrow$ `DRAWING`), mengunci tim (`teamsLocked = true`), membagikan kata rahasia unik ke tiap grup, dan memulai countdown 3 detik untuk pemain urutan `#1` di semua grup secara paralel.
- **Syarat:** Minimal terdapat `2` pemain di dalam room (`gameState.players.length >= 2`).
```json
{
  "action": "START_DRAWING_PHASE",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 10. `GM_SKIP_MEMBER_TURN`
Melewati giliran anggota kelompok yang sedang aktif menggambar (misal karena kendala sinyal/perangkat) dan langsung memindahkan giliran ke anggota berikutnya tanpa menghanguskan sisa tinta grup.
- **Syarat Fase:** Hanya `DRAWING` dan `group.status !== "FINISHED"`.
- **Field `payload` Wajib:** `groupId` (number).
```json
{
  "action": "GM_SKIP_MEMBER_TURN",
  "payload": {
    "groupId": 1,
    "deviceId": "dev-gm-01"
  },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 11. `FORCE_FINISH_DRAWING`
Menghentikan paksa proses menggambar seluruh grup dan memindahkan fase ke `READY_TO_GUESS`.
- **Syarat Fase:** Dikirim saat `DRAWING`.
```json
{
  "action": "FORCE_FINISH_DRAWING",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 12. `START_GUESSING_PHASE`
Memulai sesi menebak gambar mulai dari Grup 1 (`activeGuessGroupIndex = 0`, fase berubah menjadi `GUESSING`).
- **Syarat Fase:** Dikirim dari fase `READY_TO_GUESS`.
```json
{
  "action": "START_GUESSING_PHASE",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 13. `TOGGLE_CLUE`
Menampilkan atau menyembunyikan Clue huruf awal + `_ _ _` ke seluruh pemain. Setiap kali di-toggle, jumlah huruf yang dibuka di-reset ke `1` (`clueRevealedCount = 1`).
- **Syarat Fase:** Hanya `GUESSING`.
- **Field `payload` Opsional:** `active` (boolean; jika tidak dikirim, server membalik nilai `!gameState.clueActive`).
```json
{
  "action": "TOGGLE_CLUE",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 14. `ADD_CLUE_LETTER`
Menambah `+1` huruf awalan yang ditampilkan pada Clue (maksimal hingga `secretWord.length - 1` huruf).
- **Syarat Fase:** Hanya `GUESSING`.
```json
{
  "action": "ADD_CLUE_LETTER",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 15. `REVEAL_CURRENT_GROUP`
Menghitung skor, mematikan Clue, dan membuka jawaban asli grup yang sedang ditebak (`GUESSING` $\rightarrow$ `REVEAL`).
- **Syarat Fase:** Hanya `GUESSING`.
```json
{
  "action": "REVEAL_CURRENT_GROUP",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 16. `NEXT_GUESS_GROUP`
Melanjutkan sesi menebak ke grup berikutnya (`activeGuessGroupIndex + 1` dengan fase `GUESSING`). Jika seluruh grup sudah ditebak, otomatis memindahkan fase ke `LEADERBOARD`.
- **Syarat Fase:** Dikirim dari fase `REVEAL`.
```json
{
  "action": "NEXT_GUESS_GROUP",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 17. `SHOW_LEADERBOARD`
Menghitung total skor dan menampilkan fase `LEADERBOARD`.
- **Syarat Fase:** Dikirim dari fase `REVEAL` pada grup terakhir.
```json
{
  "action": "SHOW_LEADERBOARD",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 18. `NEXT_ROUND`
Menyimpan akumulasi skor ronde ini ke `accumulatedScores`, menaikkan `roundNumber += 1`, mengunci tim (`teamsLocked = true`), dan mengembalikan fase ke `LOBBY` untuk ronde berikutnya.
- **Syarat Fase:** Dikirim dari `LEADERBOARD`.
```json
{
  "action": "NEXT_ROUND",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 19. `RETURN_TO_LOBBY`
Menghentikan ronde yang sedang berjalan dan mengembalikan semua peserta ke `LOBBY` bersama grupnya tanpa meng-kick peserta.
- **Syarat Fase:** Fase mana saja selain `LOBBY` (tombol muncul di topbar GM saat `phase !== "LOBBY"`).
```json
{
  "action": "RETURN_TO_LOBBY",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 20. `RESET_GAME`
Tombol *"Ulang Ronde 1 & Acak Tim Baru"* di halaman `LEADERBOARD`: mengembalikan ke Ronde 1, menghapus `accumulatedScores`, membuka kunci tim (`teamsLocked = false`), dan mengacak ulang grup tanpa meng-kick peserta.
```json
{
  "action": "RESET_GAME",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

#### 21. `KICK_ALL_PLAYERS`
Tombol *"🗑️ Reset Semua"* di halaman `LOBBY`: mengeluarkan (kick) semua pemain & Bot (`gameState.players = []`), mengirim `PLAYER_KICKED` ke semua socket non-GM, mereset skor ke `0`, dan mengembalikan room ke `Ronde 1` kosong.
```json
{
  "action": "KICK_ALL_PLAYERS",
  "payload": { "deviceId": "dev-gm-01" },
  "role": "game_master",
  "playerId": null,
  "deviceId": "dev-gm-01",
  "gmPin": "PIN_DIKIRIM"
}
```

---

## 3. PESAN DARI SERVER KE KLIEN

### 3.1 Contoh JSON untuk Tiap Tipe Pesan Server

#### A. `STATE_UPDATE` (State Penuh via WebSocket)
```json
{
  "type": "STATE_UPDATE",
  "state": {
    "phase": "GUESSING",
    "roundNumber": 1,
    "teamsLocked": true,
    "strokesOmitted": false,
    "maxPlayers": 40,
    "settings": {
      "maxPlayers": 40,
      "groupCount": 2,
      "inkCapacityMode": "STANDAR",
      "turnDurationSeconds": 20,
      "passInkBehavior": "PORSI_TETAP",
      "fuzzyMatching": true
    },
    "inkCapacityModes": {
      "HEMAT": { "ink_per_player": 1000, "total_group_ink": 1000, "description": "Menantang, butuh efisiensi goresan tinggi" },
      "STANDAR": { "ink_per_player": 2000, "total_group_ink": 2000, "description": "Porsi seimbang untuk setiap pemain" },
      "BANYAK": { "ink_per_player": 4000, "total_group_ink": 4000, "description": "Leluasa untuk detail gambar dan warna" }
    },
    "drawingTools": {
      "visibility_mode": "OPEN_RELAY",
      "colors": ["#000000", "#EF4444", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#92400E"],
      "brush_sizes": [
        { "label": "Tipis", "size": 3, "ink_multiplier": 1.0 },
        { "label": "Sedang", "size": 6, "ink_multiplier": 1.6 },
        { "label": "Tebal", "size": 11, "ink_multiplier": 2.5 }
      ],
      "eraser_allowed": true,
      "undo_allowed": false
    },
    "players": [
      {
        "id": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
        "name": "Budi",
        "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "groupId": 1,
        "turnOrder": 1,
        "isBot": false,
        "connected": true
      }
    ],
    "groups": [
      {
        "id": 1,
        "name": "Grup 1",
        "fullName": "Grup 1 (Merah)",
        "color": "#EF4444",
        "lightColor": "#FEE2E2",
        "secretWord": "???",
        "clueText": "K _ _ _ _ _",
        "clueLength": 6,
        "clueRevealedCount": 1,
        "clueMaxLetters": 5,
        "inkPerPlayer": 2000,
        "initialInk": 2000,
        "remainingInk": 1420,
        "remainingInkPct": 71,
        "turnInkLimit": 0,
        "turnInkRemaining": 0,
        "currentTurnIndex": 1,
        "activePlayerId": null,
        "activePlayerName": null,
        "status": "FINISHED",
        "countdownEndAt": 0,
        "turnEndAt": 0,
        "countdownRemainingSec": 0,
        "turnRemainingSec": 0,
        "members": [
          {
            "id": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
            "name": "Budi",
            "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            "groupId": 1,
            "turnOrder": 1,
            "isBot": false,
            "connected": true
          }
        ],
        "strokes": [
          {
            "x1": 240.5,
            "y1": 180.0,
            "x2": 245.2,
            "y2": 183.8,
            "color": "#EF4444",
            "size": 6,
            "isEraser": false,
            "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566"
          }
        ],
        "correctGuessers": [],
        "scoreBreakdown": {
          "drawerPoints": 0,
          "inkBonus": 0,
          "guesserPoints": 0,
          "roundTotal": 0,
          "accumulatedTotal": 0
        }
      }
    ],
    "boundPlayer": {
      "id": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
      "name": "Budi",
      "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "groupId": 1,
      "turnOrder": 1,
      "isBot": false,
      "connected": true
    },
    "activeGuessGroupIndex": 0,
    "clueActive": true,
    "clueRevealedCount": 1,
    "guessFeed": [],
    "customWordsCount": 78,
    "localIPs": ["172.20.10.2"],
    "port": 3000,
    "serverTime": 1795059568000
  }
}
```

#### B. `STATE_UPDATE` Ringan (`omitStrokes: true`)
Dikirim saat `SUBMIT_GUESS`, `TOGGLE_CLUE`, dan `ADD_CLUE_LETTER`. Field `state.strokesOmitted` bernilai `true` dan properti `strokes` pada seluruh objek di `state.groups` dihilangkan (`undefined` saat `JSON.stringify`), sehingga klien mempertahankan array `strokes` yang sudah ada di memori browser (`public/app.js` baris `236–253`).
```json
{
  "type": "STATE_UPDATE",
  "state": {
    "phase": "GUESSING",
    "roundNumber": 1,
    "teamsLocked": true,
    "strokesOmitted": true,
    "groups": [
      {
        "id": 1,
        "name": "Grup 1",
        "secretWord": "???",
        "clueText": "K U _ _ _ _",
        "clueLength": 6,
        "clueRevealedCount": 2,
        "clueMaxLetters": 5,
        "correctGuessers": [
          {
            "playerId": "8a112233-4455-6677-8899-aabbccddeeff",
            "playerName": "Rina",
            "groupId": 2,
            "isFuzzy": false,
            "rank": 1,
            "points": 30
          }
        ]
      }
    ],
    "guessFeed": [
      {
        "id": "f1d2c3b4-a596-4877-9888-1234567890ab",
        "playerId": "8a112233-4455-6677-8899-aabbccddeeff",
        "playerName": "Rina",
        "groupId": 2,
        "text": "🎉 Berhasil menebak benar! (Tercepat #1 • +30 Poin)",
        "isCorrect": true,
        "isClose": false,
        "rank": 1,
        "points": 30,
        "timestamp": 1795059570000
      }
    ],
    "serverTime": 1795059570000
  }
}
```

#### C. `STROKE_STREAM` (Streaming Goresan Real-Time via WebSocket)
Dikirim setiap kali ada 1 segmen goresan valid pada `applyStrokeSegment` (`server.js` baris `393–397` & `999–1011`).
```json
{
  "type": "STROKE_STREAM",
  "groupId": 1,
  "segment": {
    "x1": 240.5,
    "y1": 180.0,
    "x2": 245.2,
    "y2": 183.8,
    "color": "#EF4444",
    "size": 6,
    "isEraser": false,
    "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566"
  },
  "inkInfo": {
    "remainingInk": 1991,
    "turnInkRemaining": 1991,
    "turnInkLimit": 2000
  }
}
```

#### D. `PLAYER_KICKED` (Notifikasi Dikeluarkan dari Room)
Dikirim via WebSocket ke klien yang dikeluarkan lewat `KICK_PLAYER` atau `KICK_ALL_PLAYERS` (`server.js` baris `1311–1316` & `1572–1575`).
```json
{
  "type": "PLAYER_KICKED",
  "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
  "message": "Kamu telah dikeluarkan dari ruangan oleh Game Master."
}
```

#### E. `ACTION_RESULT` (Ack / Balasan Action via WebSocket & HTTP)
- Bila klien mengirim `{ "type": "ACTION", ... }` via WebSocket (`server.js` baris `1845–1853`), server membalas ke socket tersebut:
  ```json
  {
    "type": "ACTION_RESULT",
    "requestId": "req-01",
    "action": "DRAW_STROKE",
    "result": { "ok": true }
  }
  ```
- Bila klien mengirim via `POST /api/action`, hasil ack maupun error dikembalikan langsung di HTTP Response JSON:
  - **Contoh Ack Sukses `SUBMIT_GUESS` (Hampir Benar):**
    ```json
    {
      "ok": true,
      "isCorrect": false,
      "isFuzzyCorrect": false,
      "isClose": true,
      "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "state": { "...objek buildClientState..." }
    }
    ```
  - **Contoh Error Validasi / Akses:**
    ```json
    {
      "ok": false,
      "requireGmAuth": true,
      "error": "Akses ditolak. Aksi ini khusus Game Master (silakan login ulang dengan PIN terbaru).",
      "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "state": { "...objek buildClientState..." }
    }
    ```

#### F. Frame Control WebSocket: `Ping` & `Pong`
- **Server $\rightarrow$ Klien (Keep-Alive Ping):** Setiap `25.000 ms` (`server.js` baris `793–803`), server menulis raw frame biner RFC 6455 Ping: `Buffer.from([0x89, 0x00])` (FIN + Opcode `0x9`, payload 0 byte).
- **Klien $\rightarrow$ Server (`opcode === 0x9`):** Jika klien mengirim frame Ping, server langsung membalas raw frame Pong `Buffer.from([0x8a, 0x00])` (`server.js` baris `1802–1806`).

---

### 3.2 Struktur State per Fase (`buildClientState` di `server.js` baris `807–954`)

| Fase (`state.phase`) | `group.secretWord` | `group.strokes` | `group.status` & Giliran Aktif |
| :--- | :--- | :--- | :--- |
| **`LOBBY`** | `"???"` untuk semua pemain (`""` bagi GM). | `[]` | `status: "WAITING"`, `currentTurnIndex: 0`, `activePlayerId` mengacu pada `members[0].id`. |
| **`DRAWING`** | Terlihat **hanya** oleh anggota grup itu sendiri (`viewerGroupId === g.id`) dan `game_master`. Grup lain menerima `"???"`. | Dikirim **hanya** ke anggota grup itu sendiri (`viewerGroupId === g.id`) dan `game_master`. Grup lain menerima `[]`. | `status` bernilai `"COUNTDOWN"` (3 detik awal tiap giliran) $\rightarrow$ `"DRAWING"` $\rightarrow$ `"FINISHED"`. `currentTurnIndex` menunjuk indeks `0..members.length-1`, `activePlayerId` berisi `members[g.currentTurnIndex].id`. |
| **`READY_TO_GUESS`** | `"???"` untuk semua pemain; terlihat oleh `game_master`. | `[]` untuk semua klien (termasuk GM, karena kanvas tidak dirender di fase ini). | Seluruh grup memiliki `status: "FINISHED"`. |
| **`GUESSING`** | Grup yang sudah lewat (`idx < activeGuessGroupIndex`) terlihat oleh semua; grup yang sedang ditebak (`idx === activeGuessGroupIndex`) dan grup berikutnya masih `"???"` bagi pemain (terlihat oleh GM). | Dikirim **hanya untuk 1 grup yang sedang ditebak** (`idx === activeGuessGroupIndex`) pada saat fase dimulai / pindah grup. Saat tebakan masuk (`SUBMIT_GUESS`) atau ubah Clue, `strokes` di-omit (`strokesOmitted: true`). | Target grup yang ditebak ditentukan oleh `state.activeGuessGroupIndex`. Jika `state.clueActive === true`, grup tersebut memiliki `clueText` (misal `"K _ _ _ _ _"`). |
| **`REVEAL`** | Kata rahasia grup `idx <= activeGuessGroupIndex` terbuka untuk seluruh pemain. | Dikirim **hanya untuk 1 grup yang sedang di-reveal** (`idx === activeGuessGroupIndex`). | `group.scoreBreakdown` dan `group.correctGuessers` berisi rincian poin gambar tersebut. |
| **`LEADERBOARD`** | Terbuka untuk **semua grup** dan semua pemain. | Dikirim penuh untuk **semua grup** agar galeri karya semua kelompok dapat dirender. | `group.scoreBreakdown.roundTotal` dan `accumulatedTotal` terisi penuh untuk klasemen akhir. |

*(Catatan Privasi `state.guessFeed`: Di `server.js` baris `912–918`, setiap item pada `guessFeed` yang memiliki `item.isClose === true` difilter di server sehingga **hanya disertakan jika `viewer && item.playerId === viewer.id`**. Peserta lain sama sekali tidak menerima entri tebakan yang hampir benar tersebut).*

---

### 3.3 Frekuensi Broadcast & Target Penerima
1. **`broadcastState(options)` (`server.js` baris `990–997`):**
   - **Ke Siapa:** Ke **seluruh** socket di `wsClients`, namun payload JSON dibuat spesifik per penerima lewat `buildClientState(meta.role, meta.playerId, meta.deviceId, options)` agar `secretWord`, `strokes`, dan `guessFeed` (`isClose`) tetap terfilter sesuai hak akses masing-masing klien.
   - **Seberapa Sering:**
     - Setiap kali ada action (`JOIN_PLAYER`, `UPDATE_SETTINGS`, `PASS_TURN`, `SUBMIT_GUESS`, `TOGGLE_CLUE`, dll.).
     - Di dalam `startServerGameLoop` (interval `200 ms`, `server.js` baris `764–790`): server **tidak** melakukan broadcast setiap 200 ms, melainkan **hanya ketika terjadi transisi status** di salah satu grup (saat `now >= group.countdownEndAt` mengubah `COUNTDOWN` $\rightarrow$ `DRAWING`, atau saat `now >= group.turnEndAt` memicu habis waktu giliran). Hitung mundur detik di layar dijalankan secara lokal oleh browser tiap `250 ms` menggunakan selisih `serverTimeOffset` terhadap `countdownEndAt` dan `turnEndAt`.
2. **`broadcastStroke(groupId, segment, inkInfo)` (`server.js` baris `999–1011`):**
   - **Ke Siapa:** **Hanya** ke socket milik anggota grup `groupId` (`viewer.groupId === groupId`) dan socket `game_master`. Anggota grup lain tidak menerima paket ini.
   - **Seberapa Sering:** Setiap kali pemain aktif menggerakkan kursor/jari sejauh $\ge 2$ piksel di atas kanvas.

---

## 4. ALUR LENGKAP (SATU SESI PENUH)

1. **Koneksi Awal & Identifikasi:**
   - Klien membuka halaman $\rightarrow$ menjalankan `connectWebSocket()` ke `/ws` dan `GET /api/state`.
   - Server menerima upgrade WebSocket $\rightarrow$ mengirim `STATE_UPDATE` awal (`phase: "LOBBY"`).
   - Klien mengirim `{ "type": "IDENTIFY", "role": "player", "playerId": null, "deviceId": "dev-..." }`.
2. **Pemain & Game Master Masuk ke Lobby (`LOBBY`):**
   - Pemain mengisi nama dan menekan Masuk $\rightarrow$ `POST /api/action` dengan `action: "JOIN_PLAYER"`.
   - Server menempatkan pemain ke grup yang jumlah anggotanya paling sedikit (`assignNewPlayerToBalancedGroup`), memberikan nomor urut `turnOrder`, lalu memanggil `broadcastState()`.
   - Klien pemain menyimpan `playerId` ke `localStorage` dan mengirim ulang `IDENTIFY` dengan `playerId` tersebut.
   - Game Master membuka modal PIN $\rightarrow$ mengirim `POST /api/action` dengan `action: "AUTH_GM", payload: { pin: "PIN_DIKIRIM" }` $\rightarrow$ setelah sukses mengirim WebSocket `IDENTIFY` dengan `role: "game_master", pin: "PIN_DIKIRIM"`.
3. **Mulai Fase Menggambar (`DRAWING`):**
   - GM menekan *"Mulai Ronde 1 Menggambar"* $\rightarrow$ `POST /api/action` (`START_DRAWING_PHASE`).
   - Server mengunci tim (`teamsLocked = true`), memilih 1 kata rahasia unik per grup (`pickSecretWords`), menghitung total tinta grup (`initialInk = members.length * inkPerPlayer`), lalu memanggil `startGroupMemberTurn(group, 0, true)` untuk setiap grup.
   - Setiap grup masuk ke status `"COUNTDOWN"` selama `3000 ms` (`countdownEndAt = now + 3000`).
4. **Bagaimana Klien Tahu Gilirannya Menggambar:**
   - Dari payload `STATE_UPDATE`, klien mencari grupnya (`myGroup`) dan memeriksa:
     - `isMyCountdown = myGroup.status === "COUNTDOWN" && myGroup.activePlayerId === client.playerId`
     - `isMyTurn = myGroup.status === "DRAWING" && myGroup.activePlayerId === client.playerId` (`public/app.js` baris `1009–1010`).
   - Saat waktu server melewati `countdownEndAt`, loop `200 ms` di server mengubah `myGroup.status` menjadi `"DRAWING"` dan memanggil `broadcastState()`.
   - Hanya ketika `isMyTurn === true`, kanvas klien mengaktifkan listener mouse/touch (`bindInteractiveCanvas`) dan tombol warna/kuas/Pass dapat diklik. Anggota satu grup lainnya melihat kanvas secara `readonly` (*Live Open Relay*).
5. **Proses Menggambar & Pergantian Giliran Estafet:**
   - Saat pemain aktif menggoreskan garis, klien menggambar di kanvas lokalnya sekaligus mengirim WebSocket `{ "type": "ACTION", "action": "DRAW_STROKE", "payload": { "groupId", "playerId", "segment" } }`.
   - Server memvalidasi bahwa `activePlayer.id === playerId`, menghitung biaya tinta `inkCost = isEraser ? 0 : dist * brushInfo.ink_multiplier`, mengurangi `turnInkRemaining` dan `remainingInk`, menyimpan segmen ke `group.strokes`, lalu memanggil `broadcastStroke(...)` ke anggota grup tersebut & GM.
   - Giliran pemain berakhir jika:
     1. Pemain menekan tombol Pass (`PASS_TURN`), atau
     2. Tinta giliran/grup habis (`turnInkRemaining <= 0.5 || remainingInk <= 0.5`), atau
     3. Waktu giliran habis (`now >= group.turnEndAt` saat `turnDurationSeconds > 0`), atau
     4. GM menekan tombol Skip (`GM_SKIP_MEMBER_TURN`).
   - Server memindahkan giliran ke `currentTurnIndex + 1` dengan countdown 3 detik. Ketika seluruh anggota di suatu grup selesai (atau `remainingInk <= 0.5`), `group.status` menjadi `"FINISHED"`.
   - Saat **semua** grup berstatus `"FINISHED"` (atau GM menekan `FORCE_FINISH_DRAWING`), `gameState.phase` otomatis berpindah ke `"READY_TO_GUESS"`.
6. **Sesi Menebak Bergantian (`READY_TO_GUESS` $\rightarrow$ `GUESSING`):**
   - GM menekan tombol mulai menebak $\rightarrow$ `START_GUESSING_PHASE` $\rightarrow$ `startGuessingForGroup(0)` menampilkan kanvas Grup 1 (`activeGuessGroupIndex = 0`) ke seluruh pemain.
   - Pemain dari grup lain (Grup $\neq 1$) mengetik tebakan $\rightarrow$ `POST /api/action` (`SUBMIT_GUESS`).
   - Bila peserta kesulitan, GM dapat menekan `TOGGLE_CLUE` (menampilkan `K _ _ _ _ _`) dan `ADD_CLUE_LETTER` (menambah huruf menjadi `K U _ _ _ _`, dst.).
7. **Bagaimana Jawaban Benar vs Hampir Benar Divalidasi (`handlePlayerGuess` di `server.js` baris `569–700`):**
   - Server menormalisasi tebakan `gLower` dan kata rahasia `sLower` (huruf kecil, trim, spasi berlebih dirapikan) lalu menghitung **Levenshtein Distance** `dist = levenshteinDistance(gLower, sLower)`.
   - **Jawaban BENAR (`isCorrect`):** Hanya jika **`dist === 0`** (100% sama persis tanpa memedulikan huruf besar/kecil).
     - Urutan penebak dicatat di `targetGroup.correctGuessers` dengan `rank = orderIndex + 1` dan poin kecepatan `pointsEarned = Math.max(5, 30 - orderIndex * 3)` (urutan #1 = `+30`, #2 = `+27`, #3 = `+24`, ..., minimal `+5`).
     - Teks tebakan asli **disensor** di `guessFeed` menjadi `"🎉 Berhasil menebak benar! (Tercepat #1 • +30 Poin)"` agar pemain lain tidak melihat jawabannya, dan input pemain tersebut dikunci.
   - **Jawaban HAMPIR BENAR (`isClose`):** Jika `!isCorrect` dan `settings.fuzzyMatching === true`, bernilai `true` apabila memenuhi salah satu syarat:
     1. Panjang kata rahasia $\ge 3$ dan `dist === 1`, atau panjang $\ge 5$ dan `dist === 2`.
     2. Jika spasi/tanda hubung dihapus (`gJoined` vs `sJoined`), jaraknya `0` atau `1` (misal `"kaca mata"` untuk `"Kacamata"`).
     3. Tebakan merupakan substring dari kata rahasia (atau sebaliknya) dengan panjang $\ge 3$ karakter dan $\ge 60\%$ panjang kata rahasia.
     4. Tebakan terdiri dari beberapa kata (`guessTokens`) dan salah satu katanya sama persis atau berjarak Levenshtein 1–2 dari kata rahasia (misal `"Kucing Anggora"` untuk `"Kucing"`).
     - Entri `guessFeed` dengan `isClose: true` difilter di `buildClientState` sehingga **hanya dikirim ke pemain yang mengetiknya saja**.
8. **Reveal Jawaban & Lanjut ke Grup Berikutnya (`REVEAL` $\rightarrow$ `GUESSING` / `LEADERBOARD`):**
   - GM menekan *"Tampilkan Jawaban Asli"* $\rightarrow$ `REVEAL_CURRENT_GROUP`.
   - Server memanggil `recalculateAllScores()` (`server.js` baris `703–744`):
     - **Poin Penggambar (`drawerPoints`):** `correctGuessers.length * 100`.
     - **Bonus Sisa Tinta (`inkBonus`):** `remainingInkPct` (1% sisa tinta = +1 poin), **dengan syarat** `correctGuessers.length >= 1` (jika tidak ada yang berhasil menebak, `inkBonus = 0`).
     - **Poin Penebak (`guesserPoints`):** akumulasi poin kecepatan (`+30` s/d `+5`) yang diperoleh anggota grup tersebut saat menebak gambar grup lain.
   - GM menekan `NEXT_GUESS_GROUP` untuk mengulang langkah 6–8 pada Grup 2, Grup 3, dst.
   - Setelah grup terakhir selesai di-reveal, GM menekan `SHOW_LEADERBOARD` (atau `NEXT_GUESS_GROUP`) untuk masuk ke `LEADERBOARD`, lalu dapat memilih `NEXT_ROUND` (lanjut Ronde 2 dengan tim tetap terkunci dan skor terakumulasi) atau `RESET_GAME`.

---

## 5. BATASAN DAN PERILAKU SERVER

### 5.1 Perilaku Saat Pemain ke-`(maxPlayers + 1)` Join
- Pada `JOIN_PLAYER` (`server.js` baris `1073–1077`), jika perangkat belum terdaftar di `gameState.players` dan `gameState.players.length >= currentMaxPlayers` (default `40`, dapat diatur GM antara `20, 30, 40, 50, 60`), server menolak join dan mengembalikan:
  ```json
  {
    "ok": false,
    "error": "Lobby penuh (Maksimal 40 pemain)."
  }
  ```
- Namun jika perangkat tersebut **sudah** terdaftar sebelumnya di `gameState.players` (berdasarkan `deviceId` atau `playerId`), server **tetap mengizinkan masuk kembali (reconnect)** ke akun pemainnya meskipun jumlah pemain saat itu sudah mencapai `maxPlayers`.

### 5.2 Rate Limit, Validasi Ukuran Payload, dan Batas Percobaan PIN
- **Rate Limit:** **Tidak ada** *rate limiter* per IP atau per socket untuk `SUBMIT_GUESS`, `DRAW_STROKE`, maupun request HTTP.
- **Validasi Ukuran Payload & Input:**
  - **HTTP Body (`POST /api/action`, `server.js` baris `1646`):** Maksimal `1.000.000` karakter (~1 MB). Jika `body.length > 1e6`, koneksi langsung diputus dengan `req.destroy()`.
  - **Nama Pemain (`JOIN_PLAYER`):** Di-*trim* dan dipotong maksimal `24` karakter (`.slice(0, 24)`).
  - **Teks Tebakan (`SUBMIT_GUESS`):** Di-*trim* dan dipotong maksimal `60` karakter (`.slice(0, 60)`).
  - **Koordinat Kanvas (`DRAW_STROKE`):** `x1, x2` di-*clamp* ke `0..800`, `y1, y2` di-*clamp* ke `0..500`.
- **Batas Percobaan PIN Game Master:** **Tidak ada** *rate limit* atau *lockout* pada `AUTH_GM`. Percobaan PIN yang salah langsung mengembalikan `{ "ok": false, "error": "PIN Game Master salah!" }`.

### 5.3 Apa yang Disimpan di Memori & Kapan Dibersihkan Antar Ronde
Seluruh state disimpan di RAM pada variabel `gameState` dan `wsClients`:
- **`gameState.guessFeed`:** Dibatasi maksimal `60` item terbaru (`if (gameState.guessFeed.length > 60) gameState.guessFeed.length = 60`). Dikosongkan (`[]`) setiap kali mulai menggambar (`startDrawingPhase`), setiap pindah grup yang ditebak (`startGuessingForGroup`), serta saat `RETURN_TO_LOBBY`, `RESET_GAME`, dan `KICK_ALL_PLAYERS`.
- **Antar Ronde (`NEXT_ROUND` $\rightarrow$ `START_DRAWING_PHASE`):**
  - **Yang Dipertahankan:** `gameState.players` (beserta `groupId` dan `turnOrder` masing-masing karena `teamsLocked = true`), `gameState.accumulatedScores` (menyimpan total skor akumulasi tiap grup dari ronde-ronde sebelumnya), `gameState.usedWords` (agar kata yang sudah keluar tidak terpilih lagi sampai kata di pool habis), dan `gameState.settings`.
  - **Yang Dibersihkan / Di-reset di Ronde Baru (`startDrawingPhase`):** `group.strokes` dikosongkan (`[]`), `group.correctGuessers` dikosongkan (`[]`), `group.remainingInk` dikembalikan penuh ke `initialInk`, `group.carriedOverInk = 0`, `clueActive = false`, `clueRevealedCount = 1`, dan `scoreBreakdown` ronde berjalan di-reset ke `0` (sambil membawa `accumulatedTotal` dari `accumulatedScores`).

### 5.4 Cara Reconnect (Klien & Server)
1. **Saat Koneksi WebSocket Terputus:**
   - Di server (`socket.on("close")`, `server.js` baris `1862–1869`): server mencari pemain dengan `meta.playerId`, mengubah `p.connected = false`, dan menghapus socket dari `wsClients` (data pemain **tidak** dihapus dari grup).
   - Di klien (`ws.addEventListener("close")`, `public/app.js` baris `133–135`): klien otomatis menjadwalkan `setTimeout(connectWebSocket, 1500)`.
2. **Apa yang Dikirim Klien Saat Reconnect / Refresh Halaman:**
   - Klien membaca `deviceId`, `role`, `playerId`, dan `gmPin` dari `localStorage` (+ cookie `tinta_device_id`).
   - Saat WebSocket baru terbuka, klien mengirim pesan `IDENTIFY`:
     ```json
     {
       "type": "IDENTIFY",
       "role": "player",
       "playerId": "3f9a1c02-7a8e-4e1a-9b24-112233445566",
       "deviceId": "dev-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
       "pin": ""
     }
     ```
3. **Apa yang Dibalas Server (`server.js` baris `1817–1844`):**
   - Server mencocokkan `msg.playerId` (atau mencari pemain non-Bot dengan `pl.deviceId === clientMeta.deviceId` jika `playerId` kosong), menandai `player.connected = true`, mengikat `clientMeta.playerId`, lalu langsung membalas dengan `STATE_UPDATE` penuh (termasuk seluruh `strokes` grup yang berhak dilihat dan objek `boundPlayer`), sehingga klien langsung kembali ke fase dan kanvas yang sedang berjalan tanpa kehilangan progres.

---

## 6. FILE PENDUKUNG & NOMOR BARIS HANDLER UTAMA

### 6.1 `server.js` (Backend HTTP, WebSocket & Game State Machine)
- **Konfigurasi, Konstanta Tinta & State Global (`gameState`):** baris `8–76`
- **Fungsi Helper & Algoritma:**
  - `getLocalIPs()` (Cache IP LAN 30 detik): baris `88–105`
  - `levenshteinDistance(a, b)` (Jarak edit string untuk validasi tebakan): baris `108–128`
  - `syncGroupsStructure()` & `rebalanceGroups()`: baris `140–207`
  - `assignNewPlayerToBalancedGroup(player)`: baris `210–230`
- **Logika Fase Menggambar & Goresan:**
  - `startGroupMemberTurn(group, turnIndex, withCountdown)`: baris `263–302`
  - `scheduleBotDrawing(group, botPlayer, turnIndex, delayMs)`: baris `305–351`
  - `applyStrokeSegment(groupId, playerId, segment)`: baris `354–416`
  - `handlePassTurn(groupId, playerId, isManualPass)`: baris `419–446`
  - `startDrawingPhase()`: baris `461–504`
- **Logika Fase Menebak & Perhitungan Skor:**
  - `startGuessingForGroup(groupIndex)` & `scheduleBotsGuessing(groupIndex)`: baris `507–566`
  - `handlePlayerGuess(playerId, rawText)`: baris `569–700`
  - `recalculateAllScores()`: baris `703–744`
- **Game Loop, State Builder & Fungsi Broadcast:**
  - `startServerGameLoop()` (Loop 200ms transisi giliran + 25s WebSocket Ping): baris `762–804`
  - `buildClientState(role, playerId, deviceId, options)`: baris `807–954`
  - `encodeWsFrame(dataStr)` & `sendWsMessage(ws, obj)`: baris `957–988`
  - `broadcastState(options)`: baris `990–997`
  - `broadcastStroke(groupId, segment, inkInfo)`: baris `999–1011`
- **Dispatcher Aksi Utama:**
  - `GM_ONLY_ACTIONS` & `handleAction(action, payload, clientMeta)`: baris `1014–1590`
- **HTTP Server & WebSocket Frame Parser (`onMessage`):**
  - `http.createServer` (`GET /api/state`, `POST /api/action`, static files): baris `1604–1727`
  - `server.on("upgrade", ...)` (WebSocket Handshake): baris `1730–1766`
  - `socket.on("data", ...)` (Dekoder frame RFC 6455 & handler pesan `IDENTIFY` / `ACTION`): baris `1768–1860`
  - `socket.on("close", ...)` & `socket.on("error", ...)`: baris `1862–1873`

### 6.2 `public/app.js` (Frontend State, Canvas & WebSocket Client)
- `getOrCreateDeviceId()` & objek `client`: baris `12–47`
- `connectWebSocket()` (Handler pesan masuk `PLAYER_KICKED`, `STATE_UPDATE`, `STROKE_STREAM`): baris `90–136`
- `sendAction(action, payload)` (Pengirim HTTP `POST /api/action`): baris `139–176`
- `sendStrokeSegmentWS(groupId, segment)` (Pengirim goresan WebSocket): baris `179–195`
- `handleStateUpdate(newState)` & `computeViewKey(st)`: baris `225–299`
- `renderDrawingView(container, st)` & `bindInteractiveCanvas(canvas, groupId)`: baris `1000–1499`
- `renderGuessingView(container, st)` & `bindGuessFormEvents()`: baris `1557–1851`
- `renderRevealView(container, st)` & `renderLeaderboardView(container, st)`: baris `1857–2079`

### 6.3 `words.js` (Word Bank & Bot Stroke Generator)
- `DEFAULT_WORDS` (78 kata objek 1-kata Bahasa Indonesia): baris `3–22`
- `BOT_NAMES` (40 nama Bot): baris `24–33`
- `generateBotStrokesForTurn(word, turnIndex, totalTurns, colors)`: baris `37–144`
