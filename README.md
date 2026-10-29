# Bot CS WhatsApp

Bot customer service untuk WhatsApp. Menjawab pertanyaan pelanggan dari
knowledge base yang kamu tulis sendiri, memproses gambar, dan meneruskan ke
kamu begitu pertanyaannya di luar cakupan.

Bot ini generik: tidak ada isi bisnis yang ditanam di kode. Semua jawaban
berasal dari `knowledge.md`.

## Yang dibutuhkan

- Node.js 20 atau lebih baru (dites di 24)
- Nomor WhatsApp yang mau dipakai bot
- API key Google AI Studio

## Setup

```bash
npm install
cp .env.example .env
```

Buka `.env`, isi minimal lima ini:

| Variabel | Isi |
|---|---|
| `AI_API_KEY` | API key Google AI Studio |
| `AI_MODELS` | ID model dipisah koma, misal `gemini-2.5-flash,gemini-2.5-flash-lite` — urutan = urutan fallback |
| `BUSINESS_NAME` | Nama usahamu — dipakai di system prompt |
| `OWNER_NUMBER` | Nomormu, format `62812...` tanpa tanda plus |

Lalu isi `knowledge.md`. **Ini bagian terpentingnya** — bot hanya tahu apa
yang tertulis di file itu. File bawaan masih berisi contoh; kalau tidak
diganti, bot akan menjawab pelanggan dengan informasi karangan.

## Menjalankan

```bash
npm start
```

Bot menyalakan server HTTP di port `3000` (lokal) atau `PORT` (Railway). QR
WhatsApp tersedia di `/qr` — buka URL dari log, lalu scan dari HP: **WhatsApp
→ Pengaturan → Perangkat tertaut → Tautkan perangkat**.

QR ASCII tetap muncul di log untuk debugging, tapi QR di halaman `/qr` jauh
lebih andal untuk dipindai. Halaman ini dilindungi token — URL lengkapnya ada
di log boot.

Sesi disimpan di `auth/`, jadi scan hanya sekali. Kalau kamu logout dari HP,
jalankan ulang dan scan lagi.

### Deploy Railway

1. Push project ke Git
2. Deploy ke Railway dari repo
3. Tambahkan Variables di Railway:
   - `AI_API_KEY`, `AI_MODELS`
   - `BUSINESS_NAME`
   - `OWNER_NUMBER`
   - (Opsional) `QR_TOKEN` — kalau kosong, token acak dibuat tiap boot
4. Railway mengisi `PORT` otomatis — tidak perlu ditambahkan manual
5. Buka log Railway, cari baris yang menampilkan URL `/qr`
6. Buka URL itu dari HP, scan QR

Setelah login pertama, sesi tersimpan di volume Railway dan bot reconnect
otomatis tanpa perlu scan ulang.

## Semua variabel `.env`

| Variabel | Default | Keterangan |
|---|---|---|
| `AI_BASE_URL` | endpoint Google | Endpoint OpenAI-compatible. Ganti hanya kalau pakai proxy sendiri |
| `AI_API_KEY` | — | **Wajib.** API key Google AI Studio |
| `AI_MODELS` | — | **Wajib.** ID model dipisah koma, urutan = urutan fallback |
| `BUSINESS_NAME` | — | **Wajib** |
| `OWNER_NUMBER` | — | **Wajib.** Tujuan eskalasi |
| `ACCESS_MODE` | `PUBLIC` | `PUBLIC` atau `WHITELIST` |
| `WHITELIST` | — | Nomor dipisah koma, dipakai kalau `ACCESS_MODE=WHITELIST` |
| `DEBOUNCE_SEC` | `8` | Jeda mengumpulkan pesan beruntun jadi satu balasan |
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

## Fallback antar model

Provider tunggal: Google AI Studio. Yang dibedakan adalah modelnya. Urutan di
`AI_MODELS` adalah urutan fallback:

```env
AI_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash
```

Setiap pesan dicoba ke model pertama dulu. Kalau gagal — error HTTP, timeout,
respons rusak — percobaan berikutnya pindah ke model kedua, dan setelah model
terakhir putar kembali ke yang pertama, sampai batas retry habis.

Kalau model kena limit (HTTP 429), bot **tidak** mengulang model yang sama.
Langsung pindah ke model berikutnya, dan model itu ditandai agar tidak
dicoba lagi di chat berikutnya:

- **Limit per menit** — ditunggu sebentar, lalu dicoba lagi.
- **Limit harian** — model itu dianggur satu jam. Kalau **semua** model kena
  limit harian, bot berhenti menunggu dan langsung mengeskalasi ke kamu:
  pelanggan dapat pesan "sudah kami teruskan ke admin" dan kamu diberi tahu.

Batas harian Google direset tengah malam waktu Pasifik (± 14:00 WIB). Bot
tahu jenis limitnya dari nama metrik di pesan error Google (`PerDay` vs
`PerMinute`), jadi tidak perlu tebak.

Semua model Google bisa melihat gambar, jadi pesan bergambar memakai chain
yang sama dengan pesan teks.

## Cache jawaban

Pertanyaan yang berulang — jam buka, ongkir, cara bayar — dijawab dari cache
di memori tanpa memanggil LLM. Kuncinya teks yang sudah dinormalkan (huruf
kecil, tanda baca dibuang), jadi "Jam buka?" dan "jam buka" dianggap sama dan
berlaku lintas pelanggan.

Yang tidak pernah di-cache: pesan bergambar, pertanyaan di bawah 6 karakter atau
di atas 60 karakter (jawabannya bergantung konteks chat), dan jawaban yang
dieskalasi. Cache hilang saat bot restart — itu disengaja, supaya jawaban lama
tidak bertahan setelah `knowledge.md` diperbarui.

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
