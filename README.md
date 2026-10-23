# Bot CS WhatsApp

Bot customer service untuk WhatsApp. Menjawab pertanyaan pelanggan dari
knowledge base yang kamu tulis sendiri, memproses gambar, dan meneruskan ke
kamu begitu pertanyaannya di luar cakupan.

Bot ini generik: tidak ada isi bisnis yang ditanam di kode. Semua jawaban
berasal dari `knowledge.md`.

## Yang dibutuhkan

- Node.js 20 atau lebih baru (dites di 24)
- Nomor WhatsApp yang mau dipakai bot
- API key provider AI yang OpenAI-compatible

## Setup

```bash
npm install
cp .env.example .env
```

Buka `.env`, isi minimal empat ini:

| Variabel | Isi |
|---|---|
| `AI_API_KEY` | API key dari provider |
| `AI_MODEL` | ID model, misal `nvidia/nemotron-3.5-super-vl:free` |
| `BUSINESS_NAME` | Nama usahamu — dipakai di system prompt |
| `OWNER_NUMBER` | Nomormu, format `62812...` tanpa tanda plus |

Lalu isi `knowledge.md`. **Ini bagian terpentingnya** — bot hanya tahu apa
yang tertulis di file itu. File bawaan masih berisi contoh; kalau tidak
diganti, bot akan menjawab pelanggan dengan informasi karangan.

## Menjalankan

```bash
npm start
```

QR muncul di terminal. Scan dari HP: **WhatsApp → Pengaturan → Perangkat
tertaut → Tautkan perangkat**. Sesi disimpan di `auth/`, jadi scan hanya
sekali. Kalau kamu logout dari HP, jalankan ulang dan scan lagi.

Jalankan di laptop dulu untuk uji coba. Kalau sudah yakin, pindahkan ke VPS
supaya tetap hidup saat laptopmu mati.

## Semua variabel `.env`

| Variabel | Default | Keterangan |
|---|---|---|
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible |
| `AI_API_KEY` | — | **Wajib** |
| `AI_MODEL` | — | **Wajib.** ID model dari provider |
| `AI_VISION_MODEL` | = `AI_MODEL` | Opsional. Model untuk pesan bergambar |
| `BUSINESS_NAME` | — | **Wajib** |
| `OWNER_NUMBER` | — | **Wajib.** Tujuan eskalasi |
| `OPEN_HOUR` | `8` | Jam buka |
| `CLOSE_HOUR` | `23` | Jam tutup |
| `OFFLINE_NOTICE` | `true` | Tambah baris "admin offline" di luar jam kerja |
| `ACCESS_MODE` | `PUBLIC` | `PUBLIC` atau `WHITELIST` |
| `WHITELIST` | — | Nomor dipisah koma, dipakai kalau `ACCESS_MODE=WHITELIST` |
| `DEBOUNCE_SEC` | `3` | Jeda mengumpulkan pesan beruntun |
| `RATE_IN_MAX` | `20` | Batas pesan masuk per nomor |
| `RATE_IN_WINDOW_SEC` | `60` | Jendela waktu batas masuk |
| `RATE_IN_COOLDOWN_MIN` | `5` | Lama diam setelah batas masuk terlampaui |
| `RATE_OUT_MAX` | `15` | Batas pesan keluar, lintas semua chat |
| `RATE_OUT_WINDOW_SEC` | `60` | Jendela waktu batas keluar |
| `CHUNK_DELAY_SEC` | `1` | Jeda antar potongan balasan panjang |
| `MAX_IMAGE_MB` | `5` | Gambar lebih besar dari ini dilewati |

**ID model sengaja tidak ditanam di kode.** Daftar model gratis bergerak
terlalu cepat — yang hidup bulan ini bisa mati bulan depan. Kalau bot tiba-tiba
membalas "sedang sibuk" padahal API key benar, cek dulu apakah modelnya masih
ada.

## Menyetel batas

Angka di `.env` adalah titik awal, bukan hasil pengukuran. Jalankan seminggu,
lalu lihat `data/log.jsonl` dan setel sesuai lalu lintas nyata.

Dua batas punya tujuan yang berbeda:

- **Batas masuk** (`RATE_IN_*`) — anti-spam. Pelanggan normal mengirim 3–8
  pesan beruntun; di atas 20 berarti bukan pelanggan.
- **Batas keluar** (`RATE_OUT_*`) — yang ini relevan terhadap risiko nomor
  diblokir. Yang terlihat seperti bot adalah pesan yang **dikirim**, bukan
  yang diterima. Kalau batasnya tercapai, pengiriman **ditunda, bukan
  dibuang** — membuang balasan berarti pelanggan hilang tanpa suara.

## Isi folder `data/`

- `log.jsonl` — satu baris JSON per kejadian: waktu, nomor, arah, teks, ada
  gambar atau tidak, kena eskalasi atau tidak. Berguna untuk menyetel batas
  dan mencari tahu kenapa bot menjawab begitu.
- `history.json` — 20 pesan terakhir per chat, supaya percakapan nyambung
  setelah bot restart.

Keduanya **tidak pernah menyimpan isi gambar atau base64** — gambar hanya
dicatat sebagai penanda. Setelah ribuan gambar lewat, folder ini tetap
hitungan kilobyte.

## Takeover manual

Balas manual di sebuah chat, dan bot berhenti membalas di chat itu selama 30
menit. Balasan bot sendiri dikenali lewat ID pesannya, jadi bot tidak salah
menganggap dirinya manusia.

## Risiko

Baileys adalah library **tidak resmi**, dan memakainya melanggar ToS
WhatsApp. Nomormu bisa diblokir.

Risiko utamanya bukan bot yang membalas pesan masuk — itu jauh lebih aman
daripada yang dibayangkan orang. Risikonya ada pada **mengirim pesan ke nomor
yang belum menghubungi lebih dulu**. Rate limit di sini cuma sabuk pengaman,
bukan perlindungan utama.

Yang benar-benar melindungi nomormu: **jangan pernah pakai nomor ini untuk
menghubungi orang yang belum chat duluan.**

Pertimbangkan juga memakai nomor terpisah dari nomor utamamu, supaya kalau
kenapa-kenapa bisnismu tetap jalan.

## Testing

```bash
npm test
```

Tes berjalan tanpa menyentuh jaringan maupun WhatsApp. Yang tidak bisa
diotomasi — scan QR, kirim gambar, takeover — harus diuji manual dengan nomor
sungguhan.
