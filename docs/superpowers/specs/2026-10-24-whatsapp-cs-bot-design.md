# Bot CS WhatsApp — Design

**Tanggal:** 2026-10-24
**Status:** Disetujui, siap masuk tahap plan

## Tujuan

Bot WhatsApp yang jadi lapis pertama customer service. Menjawab pertanyaan
pelanggan memakai knowledge base yang diisi sendiri oleh pemilik bisnis, dan
mengalihkan ke manusia begitu pertanyaannya di luar cakupan itu.

Bot ini generik: tidak ada konten bisnis yang ditanam di kode. Semua isi
jawaban berasal dari `knowledge.md`.

## Non-tujuan

Hal-hal berikut sengaja tidak dibangun. Bukan karena sulit, tapi karena tidak
diminta:

- Tidak ada katalog produk terstruktur, cek stok, alur order, ongkir, atau
  pembayaran. Semua itu cukup ditulis sebagai teks di `knowledge.md`.
- Tidak ada dashboard, database, atau API admin.
- Tidak ada balasan untuk grup atau status broadcast.
- Tidak ada multi-akun. Satu proses = satu nomor WhatsApp.

## Struktur

```
My Personal Assistants/
├── config.js      # muat & validasi .env + knowledge.md
├── pipeline.js    # logika murni: filter, ekstraksi, debounce, rate limit, antrian, takeover
├── ai.js          # provider call, system prompt, riwayat, deteksi eskalasi
├── index.js       # lem Baileys — sengaja tipis, tanpa logika
├── knowledge.md   # diisi pemilik — sumber semua jawaban
├── .env           # konfigurasi & rahasia
├── .gitignore
├── auth/          # sesi WhatsApp (auto-generated, JANGAN di-commit)
└── data/          # history.json + log.jsonl (auto-generated)
```

Empat file kode. `config.js` dipakai bersama `index.js` dan `ai.js`; `pipeline.js`
memisahkan logika murni dari Baileys supaya filter dan rate limiter bisa diuji
tanpa menyambung ke WhatsApp lebih dulu.

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible |
| `AI_API_KEY` | — | Wajib diisi |
| `AI_MODEL` | — | Wajib diisi; ID model dari provider |
| `AI_VISION_MODEL` | = `AI_MODEL` | Opsional. Model untuk pesan bergambar |
| `BUSINESS_NAME` | — | Dipakai di system prompt |
| `OWNER_NUMBER` | — | Nomor tujuan eskalasi, format `62812...` |
| `OPEN_HOUR` | `8` | Jam buka |
| `CLOSE_HOUR` | `23` | Jam tutup |
| `OFFLINE_NOTICE` | `true` | Tambah baris "admin offline" di luar jam kerja |
| `ACCESS_MODE` | `PUBLIC` | `PUBLIC` \| `WHITELIST` |
| `WHITELIST` | — | Nomor dipisah koma, dipakai kalau `ACCESS_MODE=WHITELIST` |
| `DEBOUNCE_SEC` | `3` | Jeda kumpulkan pesan beruntun |
| `RATE_IN_MAX` | `20` | Batas pesan masuk per nomor |
| `RATE_IN_WINDOW_SEC` | `60` | Jendela waktu batas masuk |
| `RATE_IN_COOLDOWN_MIN` | `5` | Lama diam setelah batas masuk terlampaui |
| `RATE_OUT_MAX` | `15` | Batas pesan keluar, lintas semua chat |
| `RATE_OUT_WINDOW_SEC` | `60` | Jendela waktu batas keluar |
| `CHUNK_DELAY_SEC` | `1` | Jeda antar potongan balasan panjang |
| `MAX_IMAGE_MB` | `5` | Gambar lebih besar dari ini dilewati |

`AI_BASE_URL` sengaja jadi variabel supaya pindah provider (Groq, Gemini,
DeepSeek, apa pun yang OpenAI-compatible) cukup ganti dua baris, tanpa ubah
kode. **ID model tidak pernah ditanam di kode**, karena daftar model gratis
bergerak terlalu cepat — `.env` yang mengisinya, dan bot gagal start dengan
pesan jelas kalau kosong.

## Alur Pesan

```
messages.upsert
   │
   ├─ type !== 'notify'                        → abaikan
   ├─ jid grup (@g.us) / status@broadcast      → abaikan
   ├─ pesan yang DIKIRIM BOT sendiri           → abaikan  (lihat "Takeover")
   ├─ fromMe === true (manusia)                → tandai chat paused, abaikan
   ├─ ACCESS_MODE=WHITELIST & di luar daftar   → abaikan
   ├─ tipe tak didukung (stiker/audio/video/dokumen) → abaikan
   ├─ rate limit masuk terlampaui              → diamkan, catat log
   │
   ▼
Debounce 3 detik — kumpulkan pesan beruntun dari nomor yang sama
   │
   ▼
Antrian (berurutan, satu per satu, lintas semua chat)
   │
   ├─ unduh gambar kalau ada
   ├─ kirim ke provider (knowledge.md + riwayat + pesan baru)
   ├─ balasan mengandung [[ESCALATE]]?
   │     ya  → balas pesan penahan, teruskan ke OWNER_NUMBER
   │     tidak → tambah baris offline kalau di luar jam kerja
   ├─ typing indicator + jeda 1–3 detik
   ├─ kirim balasan (dipecah kalau > 4000 karakter, jeda 1 detik antar potongan)
   ├─ simpan ke riwayat (maks 20 pesan terakhir per chat)
   └─ tulis ke data/log.jsonl
```

## Rate Limiting

Angka-angka di bawah adalah titik awal yang bisa disetel, bukan hasil
pengukuran. Semuanya ada di `.env` supaya bisa disetel setelah melihat lalu
lintas nyata.

**Dua batas, dua tujuan berbeda:**

- **Batas masuk** (`RATE_IN_MAX`, 20/60 detik per nomor) — murni anti-spam.
  Pelanggan normal mengirim 3–8 pesan beruntun; di atas 20 berarti bukan
  pelanggan. Terlampaui → nomor itu didiamkan `RATE_IN_COOLDOWN_MIN`.
- **Batas keluar** (`RATE_OUT_MAX`, 15/60 detik lintas semua chat) — ini yang
  relevan terhadap risiko pemblokiran nomor. Yang terlihat seperti bot adalah
  pesan yang **dikirim**, bukan yang diterima.

**Batas keluar menunda, tidak membuang.** Kalau batas tercapai, pesan menunggu
sampai jendela waktunya longgar. Membuang balasan berarti pelanggan hilang
tanpa suara dan pemilik tidak pernah tahu — itu lebih buruk daripada masalah
yang mau dicegah.

**Jeda antar potongan.** Balasan panjang dipecah jadi beberapa pesan; tanpa
jeda, tiga pesan terkirim dalam hitungan milidetik dan itu justru pola bot.

## Dukungan Gambar

Pelanggan sering mengirim foto produk lalu bertanya. Pesan bergambar diproses,
bukan diabaikan.

- Deteksi lewat `getContentType(m.message) === 'imageMessage'`, unduh dengan
  `downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })`.
  Parameter `reuploadRequest` wajib — media lama bisa sudah hilang dari server
  WhatsApp, dan tanpa itu unduhan gagal permanen.
- Dikirim ke provider dalam format vision OpenAI-compatible: `content` berupa
  array berisi `{ type: 'text', text }` dan
  `{ type: 'image_url', image_url: { url: 'data:<mimetype>;base64,...' } }`.
- `AI_VISION_MODEL` opsional. Kosong → pakai `AI_MODEL`. Dipisah supaya bisa
  pakai model murah untuk teks dan model bervisi untuk gambar.
- **Base64 tidak pernah masuk riwayat.** Riwayat menyimpan teks saja; gambar
  dicatat sebagai `'[gambar]'` plus caption kalau ada. Menyimpan base64 di
  `history.json` akan membengkakkan file itu sampai puluhan MB dalam sehari.
  Gambar hanya ikut pada permintaan yang sedang diproses.
- Gambar lebih besar dari `MAX_IMAGE_MB`, atau unduhan gagal → bot membalas
  minta kirim ulang, bukan diam dan bukan crash.

Stiker, audio, video, dan dokumen tetap diabaikan.

## Komponen

### `index.js` — koneksi & perakitan

- `useMultiFileAuthState('auth')` untuk sesi. Belum ada sesi → render QR ke
  terminal. **`printQRInTerminal` sudah tidak berfungsi di Baileys terkini** —
  QR di-render sendiri dari event `connection.update` memakai `qrcode-terminal`.
- `markOnlineOnConnect: false`. **Ini bukan detail kecil:** kalau bot menandai
  dirinya online, WhatsApp berhenti mengirim push notification, dan HP pemilik
  tidak akan bunyi saat ada chat pelanggan masuk — padahal justru itu yang
  dibutuhkan untuk takeover manual.
- Reconnect otomatis saat `connection.update` berstatus `close`, kecuali
  `DisconnectReason.loggedOut` — kalau logout, hentikan proses dan beri tahu
  bahwa perlu scan QR ulang.
- **Antrian:** satu rantai promise berurutan lintas semua chat. Tidak ada pesan
  yang diproses paralel, sehingga batas keluar bisa ditegakkan dan pola kirim
  tetap manusiawi.
- `index.js` tidak berisi logika yang bisa diuji; semuanya didelegasikan ke
  `pipeline.js`, `config.js`, dan `ai.js`.

### `pipeline.js` — logika murni

Seluruh isi file ini bisa diuji tanpa menyentuh WhatsApp:

- `extractText(msg)` → `string | null`. Membaca `conversation`,
  `extendedTextMessage.text`, dan `imageMessage.caption`.
- `extractImage(msg)` → `imageMessage | null`.
- `shouldIgnore(msg)` → `boolean`. `true` untuk grup, status, dan pesan yang
  tidak punya teks **maupun** gambar.
- `chunkText(text, size)` → `string[]`, memotong di batas baris.
- `createDebouncer({ waitMs, onFlush })` → `{ add(jid, item) }`.
- `createRateLimiter({ max, windowMs, cooldownMs })` → `{ check(jid) }`.
- `createQueue()` → `{ push(fn) }`.
- `createTakeover({ pauseMs })` → `{ noteSent, isOwn, pause, isPaused }`.

### `ai.js` — provider & percakapan

- `createAI({ config, knowledge, fetchImpl })` → `{ ask({ jid, text, image }) }`
  yang mengembalikan `{ reply, escalated }`.
- **System prompt** dibangun dari `BUSINESS_NAME`, isi `knowledge.md`, dan
  aturan tetap: jawab singkat, bahasa Indonesia, dan **jangan pernah mengarang**
  informasi yang tidak ada di knowledge base.
- **Eskalasi tanpa panggilan API kedua:** model diinstruksikan menulis penanda
  `[[ESCALATE]]` di awal balasan kalau jawabannya tidak ada di knowledge base.
  `ai.js` mendeteksi penanda itu, membuangnya, dan mengembalikan
  `escalated: true`. Lebih murah dan lebih sederhana daripada meminta output
  JSON lalu mem-parse-nya.
- **Riwayat:** `Map<jid, Array<{role, content}>>` berisi teks saja, dipotong ke
  20 pesan terakhir per chat. Ditulis ke `data/history.json` dengan debounce
  ~2 detik, bukan setiap pesan.
- **Retry:** jika gagal menghubungi AI, kirim pesan tunggu "Baik kak, mohon ditunggu sebentar yaa kak." dan terus mengulang panggilan AI tiap 5 detik sampai berhasil. `ask` **tidak pernah melempar** — kontraknya selalu mengembalikan objek.
- `knowledge.md` hilang atau kosong → gagal start dengan pesan jelas.

### `knowledge.md` — sumber jawaban

Markdown bebas. Tidak ada schema. Dibaca apa adanya dan disuntik ke system
prompt, diisi placeholder + contoh struktur supaya pemilik tahu harus menulis
apa.

## Takeover Manusia

Kalau pemilik membalas manual di sebuah chat, bot berhenti membalas di chat itu
selama 30 menit.

**Masalah yang harus ditangani:** balasan bot sendiri juga punya `fromMe: true`,
jadi "ada pesan fromMe" saja tidak cukup untuk menyimpulkan pemilik sedang turun
tangan. Setiap pesan yang dikirim bot dicatat ID-nya di sebuah `Set`. Saat
menerima `fromMe: true`:

- ID ada di `Set` → itu balasan bot sendiri, abaikan diam-diam.
- ID tidak ada di `Set` → itu manusia, tandai chat paused 30 menit.

## Error Handling

| Kejadian | Perilaku |
|---|---|
| API gagal atau membalas 4xx/5xx | Kirim "Baik kak, mohon ditunggu sebentar yaa kak.", lalu terus retry tiap 5 detik. Proses tetap hidup. |
| Gambar gagal diunduh | Balas minta kirim ulang. Jangan crash. |
| Koneksi WA putus | Reconnect otomatis. Kalau `loggedOut`, berhenti dan beri tahu. |
| `knowledge.md` hilang atau kosong | Gagal start dengan pesan jelas. |
| Batas keluar tercapai | Tunda pengiriman sampai jendela longgar. Jangan buang. |
| Pesan tak didukung | Lewati, catat ke log. |
| Error tak tertangkap | Dicatat, proses tidak keluar. |

## Keamanan

- `auth/` berisi kredensial sesi WhatsApp. Wajib masuk `.gitignore`. Kalau
  folder ini bocor, orang lain bisa mengambil alih nomor.
- `.env` juga masuk `.gitignore`. `knowledge.md` tidak, karena isinya bukan
  rahasia.
- Batas kepercayaan ada di `OWNER_NUMBER` dan `WHITELIST`: nomor yang tidak
  berhak tidak boleh bisa memicu eskalasi atau membaca isi log.

## Testing

`node --test` bawaan, tanpa framework. Seluruh tes berjalan tanpa menyentuh
jaringan maupun WhatsApp.

- `ai.js`: knowledge masuk ke system prompt; `[[ESCALATE]]` memicu flag dan
  terbuang dari teks; riwayat dipotong ke 20; HTTP 429 dan kegagalan jaringan
  menghasilkan fallback tanpa melempar; **base64 gambar tidak tertinggal di
  riwayat**.
- `config.js`: env kosong menyebut semua variabel yang kurang sekaligus;
  default terisi benar; whitelist dipecah bersih; `knowledge.md` kosong dan
  hilang sama-sama ditolak.
- `pipeline.js`: ekstraksi teks dan gambar; pesan tak didukung diabaikan; grup
  dan status diabaikan; `chunkText` tidak kehilangan karakter; rate limiter
  memblokir setelah batasnya; antrian tetap jalan setelah satu tugas gagal;
  balasan bot sendiri bukan takeover; pause berlaku per chat; debouncer
  menggabungkan pesan beruntun jadi satu.

Sisanya pengujian manual di Task 4: scan QR, kirim pertanyaan di dalam dan di
luar knowledge base, kirim gambar, kirim stiker, balas manual untuk menguji
takeover, dan periksa isi `data/`.

## Risiko yang Diterima

Baileys adalah library tidak resmi dan penggunaannya melanggar ToS WhatsApp.
Risiko utamanya adalah pengiriman pesan massal ke nomor yang tidak pernah
menghubungi lebih dulu. Bot yang **hanya membalas** pesan masuk jauh lebih aman
daripada gambaran itu, dan rate limit di sini berfungsi sebagai sabuk pengaman,
bukan sebagai perlindungan utama. Yang benar-benar melindungi nomor ini: jangan
pernah memakainya untuk mengirim pesan ke nomor yang belum chat duluan.
