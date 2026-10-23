# Bot CS WhatsApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot WhatsApp yang menjawab pertanyaan pelanggan dari `knowledge.md` — teks maupun gambar — dan mengalihkan ke pemilik saat jawabannya tidak ada di sana.

**Architecture:** Empat modul dengan tanggung jawab tunggal. `config.js` memuat dan memvalidasi konfigurasi. `pipeline.js` berisi seluruh logika murni (filter, ekstraksi, debounce, rate limit, antrian, takeover, gerbang kirim) yang bisa diuji tanpa menyentuh WhatsApp. `ai.js` memanggil provider AI. `index.js` hanya lem yang menyambungkan Baileys ke ketiganya — file ini sengaja tipis supaya tidak ada logika yang tersembunyi di balik koneksi jaringan.

**Tech Stack:** Node.js ≥20.6 (ESM, `node --test` bawaan, `--env-file` bawaan), `@whiskeysockets/baileys`, `qrcode-terminal`. Tidak ada dependency lain.

**Spec:** `docs/superpowers/specs/2026-10-24-whatsapp-cs-bot-design.md`

## Global Constraints

Semua nilai di bawah diambil persis dari spec. Setiap task mengikutinya.

- `AI_BASE_URL` default `https://openrouter.ai/api/v1` (endpoint OpenAI-compatible).
- **Tidak ada ID model yang ditanam di kode.** `AI_MODEL` wajib diisi lewat `.env`. `AI_VISION_MODEL` opsional, kosong berarti ikut `AI_MODEL`.
- Debounce pesan masuk: **3 detik**.
- Batas masuk: **20 pesan / 60 detik per nomor**; terlampaui → nomor itu didiamkan **5 menit**.
- Batas keluar: **15 pesan / 60 detik lintas semua chat**. Tercapai → **tunda, jangan buang**.
- Takeover: pemilik balas manual → chat itu di-pause **30 menit**.
- Riwayat: maksimum **20 pesan terakhir per chat**, **teks saja**.
- Balasan dipecah kalau lebih dari **4000 karakter**, jeda **1 detik** antar potongan.
- Jeda sebelum kirim: **1–3 detik** acak, didahului `sendPresenceUpdate('composing', jid)`.
- Retry API: **1 kali**. `ask` tidak pernah melempar.
- Gambar lebih besar dari **5 MB** dilewati.
- Jam operasional: **08.00–23.00** (`OPEN_HOUR=8`, `CLOSE_HOUR=23`).
- `ACCESS_MODE` default `PUBLIC`; alternatif `WHITELIST`.
- `markOnlineOnConnect: false` — kalau `true`, HP pemilik berhenti menerima push notification.
- Tulis `data/history.json` dengan **debounce ~2 detik**, bukan tiap pesan.
- Balasan berbahasa Indonesia dan singkat.
- **Jangan pernah mengarang.** Di luar `knowledge.md` → penanda `[[ESCALATE]]`.
- **Fail fast:** env wajib kosong, atau `knowledge.md` hilang/kosong → proses berhenti dengan pesan yang menyebut nama variabelnya.
- `auth/`, `.env`, `data/` masuk `.gitignore`.

## Review Focus

Lima hal yang spec mengimplikasikan tapi tidak diuji oleh tes fitur mana pun. Masing-masing punya tes yang dipasang di task pemilik kodenya, kecuali yang terakhir — itu hanya bisa diuji manual.

1. **Pesan tak didukung** (stiker, audio, video, dokumen) — harus dilewati diam-diam, bukan crash dan bukan balasan kosong. → Task 3.
2. **Balasan bot sendiri terdeteksi sebagai takeover.** Balasan bot juga `fromMe: true`; salah deteksi membuat bot mem-pause dirinya sendiri lalu berhenti menjawab pelanggan tanpa suara. → Task 3.
3. **Batas keluar tercapai** — yang diharapkan: pengiriman **tertunda**, bukan dibuang. Membuang balasan berarti pelanggan hilang tanpa jejak. → Task 3.
4. **Provider membalas HTTP 429 atau 5xx** (free tier gampang kena) — yang diharapkan: pesan fallback terkirim, proses tetap hidup. → Task 1.
5. **Gambar gagal diunduh atau media sudah kedaluwarsa** — yang diharapkan: bot minta kirim ulang, bukan diam. Butuh socket sungguhan, jadi diuji manual di Task 4.

---

### Task 1: `ai.js` — provider, system prompt, eskalasi, riwayat, gambar

**Files:**
- Create: `package.json`
- Create: `test/ai.test.js`
- Create: `ai.js`

**Interfaces:**
- Consumes: `config` dan `knowledge` (string) — keduanya disuntikkan, jadi task ini bisa dikerjakan lebih dulu. Bentuk `config` yang dipakai di sini: `aiBaseUrl`, `aiApiKey`, `aiModel`, `aiVisionModel`, `businessName`, `hours`, `offlineNotice`.
- Produces: `createAI({ config, knowledge, fetchImpl })` → `{ ask({ jid, text, image }) }`.
  - `image` berbentuk `{ data: Buffer, mimetype: string }` atau tidak ada sama sekali.
  - `ask` mengembalikan `Promise<{ reply: string, escalated: boolean }>` dan **tidak pernah melempar**.

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/ai.test.js`. Enam tes, memakai `fetchImpl` palsu:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAI } from '../ai.js'

const CHAT = 'a@s.whatsapp.net'

const config = {
  aiBaseUrl: 'https://contoh.test/v1',
  aiApiKey: 'kunci-uji',
  aiModel: 'model-teks',
  aiVisionModel: 'model-gambar',
  businessName: 'Toko Uji',
  hours: { open: 8, close: 23 },
  offlineNotice: true,
}

// Helper: tangkap body yang dikirim ke provider, balas teks yang ditentukan.
function fakeFetch(replyText, { ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return { ok, status, json: async () => ({ choices: [{ message: { content: replyText } }] }) }
  }
  return { impl, calls }
}

test('isi knowledge muncul di system prompt', async () => {
  const { impl, calls } = fakeFetch('halo')
  const ai = createAI({ config, knowledge: 'Harga kopi Rp15.000.', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'berapa?' })
  const system = calls[0].messages.find(m => m.role === 'system').content
  assert.match(system, /Harga kopi Rp15\.000\./)
})

test('penanda [[ESCALATE]] memicu escalated dan dibuang dari teks', async () => {
  const { impl } = fakeFetch('[[ESCALATE]] Maaf, saya cek dulu ke admin ya.')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  const res = await ai.ask({ jid: CHAT, text: 'ada diskon?' })
  assert.equal(res.escalated, true)
  assert.equal(res.reply.includes('[[ESCALATE]]'), false)
})

test('riwayat dipotong ke 20 pesan terakhir', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  for (let i = 0; i < 25; i++) {
    await ai.ask({ jid: CHAT, text: `pesan ${i}` })
  }
  const terakhir = calls.at(-1).messages
  assert.equal(terakhir.filter(m => m.role !== 'system').length, 20)
  assert.equal(terakhir.at(-1).content, 'pesan 24')
})

test('HTTP 429 diperlakukan sebagai gagal, bukan crash', async () => {
  let n = 0
  const impl = async () => { n++; return { ok: false, status: 429, json: async () => ({}) } }
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.escalated, true)
  assert.ok(res.reply.length > 0)
  assert.equal(n, 2) // sekali gagal, sekali retry
})

test('gambar dikirim sebagai data URI, dan memakai model bervisi', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({
    jid: CHAT,
    text: 'ini apa?',
    image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' },
  })
  const last = calls[0].messages.at(-1)
  assert.equal(Array.isArray(last.content), true)
  const img = last.content.find(c => c.type === 'image_url')
  assert.match(img.image_url.url, /^data:image\/jpeg;base64,/)
  assert.equal(calls[0].model, 'model-gambar')
})

test('base64 tidak tertinggal di riwayat', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'ini apa?', image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' } })
  await ai.ask({ jid: CHAT, text: 'lanjut' })
  assert.equal(JSON.stringify(calls[1].messages).includes('base64'), false)
  assert.equal(calls[1].model, 'model-teks')
})
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/ai.test.js`
Expected: FAIL — `Cannot find module '../ai.js'`

- [ ] **Step 3: Inisialisasi repo dan `package.json`**

Folder ini belum repo git. Jalankan `git init` lebih dulu — langkah commit di setiap task membutuhkannya, dan `.gitignore` di Task 2 harus sudah ada sebelum file kredensial apa pun muncul.

```json
{
  "name": "wa-cs-bot",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file=.env index.js",
    "test": "node --test test/"
  }
}
```

Jalankan `npm install @whiskeysockets/baileys qrcode-terminal`. **Kalau versi mayor Baileys yang terpasang adalah 7 atau lebih, `auth` wajib ada di `makeWASocket` dan `printQRInTerminal` sudah tidak berfungsi** — Task 4 sudah ditulis dengan asumsi itu.

- [ ] **Step 4: Implementasi `ai.js`**

Ekspor `createAI({ config, knowledge, fetchImpl = fetch })`. Urutan kerja `ask({ jid, text, image })`:

1. Ambil atau buat `history[jid]` (`Map<jid, Array<{role, content}>>`).
2. Dorong pesan pengguna sebagai **teks biasa**: `text` kalau ada; kalau ada gambar, tambahkan `' [gambar]'` di belakangnya; kalau hanya gambar tanpa teks, isinya `'[gambar]'`. **Base64 tidak pernah masuk ke sini** — itu yang mencegah `history.json` membengkak.
3. Potong riwayat ke 20 entri terakhir, lalu susun `messages = [{ role: 'system', content: systemPrompt }, ...history[jid]]`.
4. Kalau ada gambar, ganti elemen terakhir dengan bentuk array:
   `[{ type: 'text', text: text || 'Gambar dari pelanggan.' }, { type: 'image_url', image_url: { url: 'data:<mimetype>;base64,<data>' } }]`.
   Gambar hanya ikut pada permintaan yang sedang berjalan, tidak pernah tersimpan.
5. Pilih model: `image ? config.aiVisionModel : config.aiModel`.
6. `POST` ke `${config.aiBaseUrl}/chat/completions`, header `Authorization: Bearer ${config.aiApiKey}`, body `{ model, messages }`.
7. Ambil `data.choices[0].message.content`. `!response.ok` atau bentuk body tidak sesuai → lempar, biar ditangkap retry.
8. Gagal → coba sekali lagi. Masih gagal → kembalikan
   `{ reply: 'Maaf, sistem kami sedang sibuk. Mohon coba lagi sebentar lagi ya.', escalated: true }`.
   **Jangan melempar** — kontraknya selalu mengembalikan objek.
9. Sukses → dorong balasan sebagai `{ role: 'assistant', content: reply }` ke riwayat, potong lagi ke 20.
10. Deteksi `[[ESCALATE]]` di awal balasan: buang penanda beserta spasi sesudahnya, set `escalated: true`.

System prompt berisi `config.businessName`, isi `knowledge`, dan aturan tetap: jawab **singkat**, bahasa **Indonesia**, sopan, dan **jangan pernah mengarang** informasi yang tidak ada di knowledge base — kalau jawabannya tidak ada, balas diawali `[[ESCALATE]]`.

- [ ] **Step 5: Jalankan tes, pastikan lulus**

Run: `node --test test/ai.test.js`
Expected: PASS, 6 tes lulus.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json ai.js test/ai.test.js
git commit -m "feat: add AI provider layer with vision, escalation and history"
```

---

### Task 2: `config.js` — pemuatan dan validasi konfigurasi

**Files:**
- Create: `.env.example`
- Create: `.gitignore`
- Create: `test/config.test.js`
- Create: `config.js`

**Interfaces:**
- Produces: `loadConfig(env)` → objek dengan bentuk persis:
  ```js
  {
    aiBaseUrl: string, aiApiKey: string, aiModel: string, aiVisionModel: string,
    businessName: string, ownerNumber: string,
    hours: { open: number, close: number },
    offlineNotice: boolean,
    access: { mode: 'PUBLIC'|'WHITELIST', whitelist: string[] },
    limits: {
      debounceSec: number, rateInMax: number, rateInWindowSec: number,
      rateInCooldownMin: number, rateOutMax: number, rateOutWindowSec: number,
      chunkDelaySec: number, maxImageMb: number,
    },
  }
  ```
  Melempar `Error` yang menyebut **semua** variabel yang kurang sekaligus.
- Produces: `loadKnowledge(path)` → `string`. Melempar kalau file tidak ada **atau** isinya kosong setelah `trim()`.

- [ ] **Step 1: Tulis tes yang gagal**

`test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, loadKnowledge } from '../config.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FULL = {
  AI_API_KEY: 'k', AI_MODEL: 'm',
  BUSINESS_NAME: 'Toko', OWNER_NUMBER: '628123',
}

test('env kosong menyebut semua variabel yang kurang sekaligus', () => {
  assert.throws(() => loadConfig({}), /AI_API_KEY[\s\S]*AI_MODEL[\s\S]*BUSINESS_NAME[\s\S]*OWNER_NUMBER/)
})

test('default terisi benar', () => {
  const c = loadConfig(FULL)
  assert.equal(c.aiBaseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(c.aiVisionModel, 'm', 'kosong berarti ikut AI_MODEL')
  assert.deepEqual(c.hours, { open: 8, close: 23 })
  assert.equal(c.offlineNotice, true)
  assert.equal(c.access.mode, 'PUBLIC')
  assert.deepEqual(c.access.whitelist, [])
})

test('batas dan debounce punya default yang benar', () => {
  const { limits } = loadConfig(FULL)
  assert.deepEqual(limits, {
    debounceSec: 3, rateInMax: 20, rateInWindowSec: 60, rateInCooldownMin: 5,
    rateOutMax: 15, rateOutWindowSec: 60, chunkDelaySec: 1, maxImageMb: 5,
  })
})

test('batas bisa ditimpa lewat env', () => {
  const { limits } = loadConfig({ ...FULL, RATE_IN_MAX: '50', DEBOUNCE_SEC: '5' })
  assert.equal(limits.rateInMax, 50)
  assert.equal(limits.debounceSec, 5)
})

test('whitelist dipecah dan dibersihkan', () => {
  const c = loadConfig({ ...FULL, ACCESS_MODE: 'WHITELIST', WHITELIST: ' 6281 , 6282 ,' })
  assert.deepEqual(c.access.whitelist, ['6281', '6282'])
})

test('knowledge.md kosong atau hilang ditolak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'))
  const p = join(dir, 'knowledge.md')
  writeFileSync(p, '   \n\n  ')
  assert.throws(() => loadKnowledge(p), /kosong/)
  assert.throws(() => loadKnowledge(join(tmpdir(), 'tidak-ada-xyz.md')), /tidak ditemukan/)
})
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../config.js'`

- [ ] **Step 3: Implementasi `config.js`**

`loadConfig` membaca dari objek `env` yang diberikan (bukan `process.env` langsung) supaya bisa diuji. Kumpulkan variabel wajib yang kosong ke dalam satu array, lalu lempar satu `Error` yang menyebut semuanya. Terapkan semua default dari Global Constraints; nilai numerik lewat `Number()`. `aiVisionModel` diisi `env.AI_VISION_MODEL || env.AI_MODEL`.

`loadKnowledge` membaca file dan melempar kalau `trim()` menghasilkan string kosong — pesannya harus memuat kata "kosong" supaya tes cocok, dan "tidak ditemukan" kalau filenya tidak ada.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test test/config.test.js`
Expected: PASS, 6 tes lulus.

- [ ] **Step 5: Buat `.env.example` dan `.gitignore`**

`.env.example` — setiap variabel dari tabel spec, dengan komentar singkat dan nilai default untuk yang punya default. `AI_MODEL` **sengaja dibiarkan kosong** dengan catatan memeriksa daftar model gratis terkini di `https://openrouter.ai/models?max_price=0`; ID model gratis berubah terlalu cepat untuk ditanam di kode, dan `AI_VISION_MODEL` perlu model yang mendukung input gambar.

`.gitignore` minimal berisi `node_modules/`, `auth/`, `.env`, `data/`. Tiga yang terakhir bukan sekadar kerapian: `auth/` berisi kredensial sesi WhatsApp — kalau ikut ter-commit, siapa pun yang punya repo itu bisa mengambil alih nomor.

- [ ] **Step 6: Jalankan seluruh tes**

Run: `npm test`
Expected: PASS, 12 tes lulus (6 dari Task 1, 6 dari Task 2).

- [ ] **Step 7: Commit**

```bash
git add .env.example .gitignore config.js test/config.test.js
git commit -m "feat: add config loading with fail-fast validation"
```

---

### Task 3: `pipeline.js` — logika murni

**Files:**
- Create: `test/pipeline.test.js`
- Create: `pipeline.js`

**Interfaces:**
- Produces:
  - `extractText(msg)` → `string | null`. Membaca `conversation`, `extendedTextMessage.text`, dan `imageMessage.caption`.
  - `extractImage(msg)` → `imageMessage | null`.
  - `shouldIgnore(msg)` → `boolean`. `true` untuk grup (`@g.us`), `status@broadcast`, dan pesan yang tidak punya teks **maupun** gambar.
  - `chunkText(text, size = 4000)` → `string[]`. Memotong di batas baris; tidak pernah mengembalikan potongan kosong.
  - `createDebouncer({ waitMs, onFlush })` → `{ add(jid, item) }`. `onFlush(jid, items)` dipanggil sekali setelah `waitMs` tanpa penambahan baru.
  - `createRateLimiter({ max, windowMs, cooldownMs })` → `{ check(jid) }`, `check` mengembalikan `true` kalau boleh diproses.
  - `createSendGate({ max, windowMs })` → `{ waitTurn() }`. Promise yang selesai saat pengiriman boleh dilakukan — **menunggu, bukan menolak**.
  - `createQueue()` → `{ push(fn) }`. Berurutan, satu per satu; kegagalan satu tugas tidak menghentikan antrian.
  - `createTakeover({ pauseMs = 1_800_000 })` → `{ noteSent(id), isOwn(id), pause(jid), isPaused(jid) }`.

- [ ] **Step 1: Tulis tes yang gagal**

`test/pipeline.test.js`. Perhatikan Review Focus nomor 1, 2, dan 3 — ketiganya diuji di sini:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractText, extractImage, shouldIgnore, chunkText,
  createDebouncer, createRateLimiter, createSendGate, createQueue, createTakeover,
} from '../pipeline.js'

const CHAT = 'a@s.whatsapp.net'
const IMG = { imageMessage: { mimetype: 'image/jpeg', fileLength: 1000 } }

test('teks diambil dari conversation, extendedTextMessage, dan caption gambar', () => {
  assert.equal(extractText({ message: { conversation: 'halo' } }), 'halo')
  assert.equal(extractText({ message: { extendedTextMessage: { text: 'hai' } } }), 'hai')
  assert.equal(extractText({ message: { imageMessage: { caption: 'lihat ini' } } }), 'lihat ini')
})

test('pesan tanpa teks menghasilkan null, bukan crash', () => {
  assert.equal(extractText({ message: { stickerMessage: {} } }), null)
  assert.equal(extractText({ message: { audioMessage: {} } }), null)
  assert.equal(extractText({}), null)
  assert.equal(extractText({ message: null }), null)
})

test('gambar dikenali, non-gambar tidak', () => {
  assert.equal(extractImage({ message: IMG })?.mimetype, 'image/jpeg')
  assert.equal(extractImage({ message: { stickerMessage: {} } }), null)
  assert.equal(extractImage({}), null)
})

test('grup, status, dan pesan tak didukung diabaikan; teks dan gambar lolos', () => {
  assert.equal(shouldIgnore({ key: { remoteJid: 'g@g.us' }, message: { conversation: 'x' } }), true)
  assert.equal(shouldIgnore({ key: { remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }), true)
  assert.equal(shouldIgnore({ key: { remoteJid: CHAT }, message: { stickerMessage: {} } }), true)
  assert.equal(shouldIgnore({ key: { remoteJid: CHAT }, message: { audioMessage: {} } }), true)
  assert.equal(shouldIgnore({ key: { remoteJid: CHAT }, message: { conversation: 'ok' } }), false)
  assert.equal(shouldIgnore({ key: { remoteJid: CHAT }, message: IMG }), false)
})

test('chunkText membagi teks panjang tanpa kehilangan karakter', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `baris ${i}`).join('\n')
  const parts = chunkText(text, 4000)
  assert.ok(parts.length > 1)
  assert.equal(parts.join('\n'), text)
  assert.ok(parts.every(p => p.length > 0 && p.length <= 4000))
})

test('debouncer menggabungkan pesan beruntun jadi satu flush', async () => {
  const flushes = []
  const d = createDebouncer({ waitMs: 20, onFlush: (jid, items) => flushes.push([jid, items]) })
  d.add(CHAT, { text: 'a' })
  d.add(CHAT, { text: 'b' })
  d.add(CHAT, { text: 'c' })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0][1].map(i => i.text), ['a', 'b', 'c'])
})

test('rate limiter mengizinkan sampai batas lalu memblokir', () => {
  const rl = createRateLimiter({ max: 3, windowMs: 60_000, cooldownMs: 300_000 })
  for (let i = 0; i < 3; i++) assert.equal(rl.check(CHAT), true, `pesan ke-${i + 1}`)
  assert.equal(rl.check(CHAT), false)
  assert.equal(rl.check('lain@s.whatsapp.net'), true, 'nomor lain tidak terpengaruh')
})

test('send gate menunda, bukan membuang', async () => {
  const gate = createSendGate({ max: 2, windowMs: 50 })
  const t0 = Date.now()
  await gate.waitTurn()
  await gate.waitTurn()
  await gate.waitTurn() // harus menunggu jendela pertama longgar
  assert.ok(Date.now() - t0 >= 40, 'pengiriman ketiga tertunda')
})

test('antrian berurutan dan tetap jalan setelah satu tugas gagal', async () => {
  const q = createQueue()
  const order = []
  q.push(async () => { order.push('a') })
  await q.push(async () => { order.push('b'); throw new Error('gagal') })
  await q.push(async () => { order.push('c') })
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('balasan bot sendiri bukan takeover', () => {
  const t = createTakeover()
  t.noteSent('BOT1')
  assert.equal(t.isOwn('BOT1'), true)
  assert.equal(t.isOwn('MANUSIA1'), false)
})

test('pause berlaku per chat', () => {
  const t = createTakeover()
  t.pause(CHAT)
  assert.equal(t.isPaused(CHAT), true)
  assert.equal(t.isPaused('lain@s.whatsapp.net'), false)
})
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/pipeline.test.js`
Expected: FAIL — `Cannot find module '../pipeline.js'`

- [ ] **Step 3: Implementasi `pipeline.js`**

Catatan implementasi untuk bagian yang tidak ditentukan tanda tangan dan tesnya:

- `chunkText`: potong di batas `\n` terakhir sebelum `size`. Gabungan potongan dengan `\n` harus sama persis dengan input — ini yang diuji, jadi jangan menambah atau membuang baris.
- `createDebouncer`: `Map<jid, { items, timer }>`. Setiap `add` mengulang timer; saat timer habis, panggil `onFlush(jid, items)` lalu hapus entri.
- `createRateLimiter`: `Map<jid, number[]>`. Buang timestamp lebih tua dari `windowMs`. Kalau jumlah dalam jendela sudah mencapai `max`, set blokir sampai `now + cooldownMs`.
- `createSendGate`: antrean timestamp pengiriman global. `waitTurn` menghitung; kalau sudah `max` dalam `windowMs` terakhir, tunggu sampai timestamp tertua kedaluwarsa, lalu lanjut. **Jangan pernah menolak** — selalu selesaikan promise-nya.
- `createQueue`: rantai promise, satu variabel di closure. Tangkap error per tugas lalu catat, supaya rantai tidak putus.
- `createTakeover`: `Set` untuk ID pesan yang dikirim bot, `Map` untuk waktu berakhirnya pause.

- [ ] **Step 4: Jalankan tes, pastikan lulus**

Run: `node --test test/pipeline.test.js`
Expected: PASS, 11 tes lulus.

- [ ] **Step 5: Commit**

```bash
git add pipeline.js test/pipeline.test.js
git commit -m "feat: add pure message pipeline logic"
```

---

### Task 4: `index.js` — koneksi Baileys dan perakitan

**Files:**
- Create: `index.js`
- Create: `knowledge.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `loadConfig`, `loadKnowledge` (Task 2); `createAI` (Task 1); seluruh ekspor `pipeline.js` (Task 3).
- Produces: titik masuk yang dijalankan `npm start`.

- [ ] **Step 1: Buat `knowledge.md`**

Placeholder berisi judul, satu paragraf petunjuk, dan contoh struktur (tentang kami, jam operasional, kontak, FAQ, cara kirim gambar). Isinya jelas-jelas contoh supaya pemilik tahu harus menggantinya.

- [ ] **Step 2: Implementasi `index.js`**

Urutan start: muat config → muat knowledge → `createAI` → sambung Baileys. Kalau `loadConfig` atau `loadKnowledge` melempar, cetak pesannya dan `process.exit(1)` **sebelum** menyentuh Baileys. Buat seluruh objek dari `pipeline.js` di sini, dengan angka dari `config.limits`.

Koneksi, sesuai API Baileys terkini:

- `const { state, saveCreds } = await useMultiFileAuthState('auth')`, lalu `makeWASocket({ auth: state, markOnlineOnConnect: false })`. **Jangan** memakai `printQRInTerminal` — sudah tidak berfungsi. `markOnlineOnConnect: false` wajib: kalau bot menandai dirinya online, HP pemilik berhenti menerima push notification.
- Tangani `connection.update`: saat ada `qr`, render dengan `qrcode-terminal` ke terminal. Saat `connection === 'open'`, catat sudah tersambung. Saat `connection === 'close'`, ambil status code lewat `lastDisconnect?.error?.output?.statusCode`; kalau sama dengan `DisconnectReason.loggedOut`, cetak bahwa perlu scan QR ulang lalu `process.exit(0)`; selain itu sambung ulang.
- `sock.ev.on('creds.update', saveCreds)`.

Penanganan pesan di `messages.upsert`:

- Loop `for (const msg of event.messages)` — ada beberapa pesan per event.
- Lewati kalau `event.type !== 'notify'`.
- **Takeover, urutan ini penting.** Kalau `msg.key.fromMe`:
  - `takeover.isOwn(msg.key.id)` → balasan bot sendiri, lewati tanpa efek apa pun.
  - selain itu → `takeover.pause(jid)`.
  Keduanya `return`; jangan pernah lanjut memproses pesan `fromMe`.
- `shouldIgnore(msg)` → lewati.
- `takeover.isPaused(jid)` → lewati.
- `ACCESS_MODE === 'WHITELIST'` dan nomor tidak ada di daftar → lewati.
- `rateLimiter.check(jid)` gagal → lewati.
- `debouncer.add(jid, { text: extractText(msg), image: extractImage(msg), msg })`.

Isi `onFlush(jid, items)` — dorong ke antrian, lalu di dalamnya:

1. Gabungkan teks dari semua item dengan `\n`. Ambil gambar dari item terakhir yang punya.
2. Kalau ada gambar dan `fileLength > maxImageMb * 1_048_576` → balas minta kirim ulang ukuran lebih kecil, selesai.
3. Kalau ada gambar → unduh dengan
   `downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })`.
   Bungkus `try/catch`: gagal → balas minta kirim ulang, catat ke log, selesai. **Jangan biarkan error ini naik ke atas.**
4. `sendPresenceUpdate('composing', jid)`, tunggu jeda acak 1–3 detik.
5. `ask({ jid, text, image })`.
6. Tambahkan baris offline kalau sekarang di luar `hours` dan `offlineNotice` aktif.
7. `chunkText` hasilnya, lalu untuk **setiap** potongan: `await sendGate.waitTurn()`, `sendMessage`, `takeover.noteSent(sent.key.id)`, dan tunggu `chunkDelaySec` detik sebelum potongan berikutnya.
8. Kalau `escalated`, kirim ringkasan ke `${config.ownerNumber}@s.whatsapp.net` berisi nomor pelanggan dan pertanyaannya.
9. Tulis setiap kejadian ke `data/log.jsonl` (satu objek JSON per baris): waktu, JID, arah, teks, **boolean** `adaGambar`, dan boolean `eskalasi`. **Jangan pernah menulis isi gambar atau base64 ke log** — hanya penanda bahwa ada gambar.

Simpan riwayat ke `data/history.json` dengan debounce ~2 detik, dan panggil penulisan terakhir saat proses menerima `SIGINT`. Tangani `unhandledRejection` dan `uncaughtException` dengan mencatatnya — proses tidak boleh mati.

- [ ] **Step 3: Periksa sendiri tanpa menyambung ke WhatsApp**

Run: `node -e "import('./config.js').then(m => m.loadConfig({}))"`
Expected: gagal dengan pesan yang menyebut keempat variabel wajib.

Run: `npm test`
Expected: PASS, 23 tes lulus.

- [ ] **Step 4: Uji manual ujung ke ujung**

Ini bagian yang tidak bisa diotomasi — butuh nomor sungguhan dan waktu. Jangan lewati; seluruh Review Focus nomor 5 hanya teruji di sini.

1. Salin `.env.example` ke `.env`, isi `AI_API_KEY`, `AI_MODEL`, `AI_VISION_MODEL`, `BUSINESS_NAME`, `OWNER_NUMBER`.
2. `npm start` → QR muncul di terminal → scan dari HP.
3. Kirim pertanyaan yang **ada** di `knowledge.md`. Harapan: dibalas.
4. Kirim 3 pesan beruntun cepat. Harapan: **satu** balasan, bukan tiga.
5. Kirim pertanyaan yang **tidak ada** di `knowledge.md`. Harapan: dibalas pesan penahan, **dan** `OWNER_NUMBER` menerima notifikasi eskalasi.
6. Kirim gambar beserta pertanyaan. Harapan: dijawab sesuai isi gambar.
7. Kirim gambar tanpa teks sama sekali. Harapan: tetap dijawab, bukan error.
8. Kirim stiker. Harapan: tidak ada balasan, tidak ada crash.
9. Dari `OWNER_NUMBER`, balas manual di chat itu. Lalu kirim pesan lagi dari nomor pelanggan. Harapan: tidak dibalas selama 30 menit.
10. **Uji jalur gagal unduh gambar** (Review Focus nomor 5). Kegagalan ini tidak bisa dipicu dari luar, jadi picu dari dalam: sementara tambahkan `throw new Error('uji')` di awal blok unduh gambar, jalankan ulang, lalu kirim gambar. Harapan: bot membalas minta kirim ulang, proses tetap hidup, dan kejadiannya tercatat di log. **Hapus kembali baris itu setelah selesai.**
11. **Cek HP pemilik:** pastikan notifikasi chat pelanggan benar-benar masuk. Kalau tidak, `markOnlineOnConnect` salah.
12. Cek `data/history.json` **dan** `data/log.jsonl` sama-sama **tidak** mengandung string `base64`. Lalu cek ukuran seluruh folder `data/` — setelah belasan gambar lewat, ukurannya harus tetap hitungan kilobyte.

- [ ] **Step 5: Tulis `README.md`**

Cara setup, cara menjalankan, isi tiap variabel `.env`, cara menyetel batas setelah melihat lalu lintas nyata, dan peringatan bahwa Baileys tidak resmi sehingga nomor berisiko diblokir — dengan catatan bahwa risiko utamanya adalah mengirim ke nomor yang belum menghubungi lebih dulu.

- [ ] **Step 6: Commit**

```bash
git add index.js knowledge.md README.md
git commit -m "feat: wire Baileys connection to message pipeline"
```

---

## Catatan Penyimpangan dari Spec

Spec awal menyebut "dua file kode". Plan ini memakai **empat** (`config.js`, `pipeline.js`, `ai.js`, `index.js`).

Alasannya: `config.js` dipakai bersama oleh `index.js` dan `ai.js`, jadi menaruhnya di salah satu berarti yang lain mengimpor dari tempat yang salah. `pipeline.js` memisahkan logika murni dari Baileys — tanpa pemisahan itu, menguji `extractImage`, debouncer, dan send gate berarti harus menyambung ke WhatsApp lebih dulu. Empat modul kecil dengan satu tanggung jawab masing-masing lebih mudah diuji daripada dua modul besar.
