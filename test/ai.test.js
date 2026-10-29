import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAI, dropTrailingPeriods, quotaKind } from '../ai.js'

const CHAT = 'a@s.whatsapp.net'

const BASE = 'https://google.test/v1beta/openai'
const flash = { name: 'google', baseUrl: BASE, apiKey: 'kg', model: 'gemini-2.5-flash' }
const lite = { name: 'google', baseUrl: BASE, apiKey: 'kg', model: 'gemini-2.5-flash-lite' }

const config = {
  ai: [flash, lite],
  businessName: 'Toko Uji',
}

// Helper: tangkap URL, header, dan body yang dikirim ke provider, balas teks
// yang ditentukan. `fails` = jumlah panggilan pertama yang sengaja digagalkan.
function fakeFetch(replyText, { ok = true, status = 200, fails = 0 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({
      url,
      authorization: init.headers.Authorization,
      ...JSON.parse(init.body),
    })
    if (calls.length <= fails) return { ok: false, status, json: async () => ({}), text: async () => '' }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: replyText } }] }) }
  }
  return { impl, calls }
}

/** Respon 429 dengan nama metrik quota Google ("PerDay" / "PerMinute"). */
function quotaFetch(metric, { status = 429 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body) })
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { details: [{ violations: [{ quotaMetric: metric }] }] } }),
    }
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
  assert.equal(res.failed, false, 'balasan normal bukan kegagalan sistem')
})

// Helper: system prompt yang benar-benar dikirim ke provider.
async function systemOf() {
  const { impl, calls } = fakeFetch('halo')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'halo' })
  return calls[0].messages.find(m => m.role === 'system').content
}

test('system prompt meminta nada hangat dengan emoji yang tidak pelit', async () => {
  const system = await systemOf()
  assert.match(system, /ramah/i, 'nada ramah harus diminta lewat prompt, bukan diserahkan ke model')
  assert.match(system, /hangat/i, 'pelanggan mengeluh botnya cuek — kehangatan harus diminta eksplisit')
  assert.match(system, /emoji/i, 'izin pakai emoji harus eksplisit')
  assert.match(system, /2 sampai 4|2-4/, 'batas lama 1-3 terbukti masih terasa kering di pemakaian nyata')
})

test('system prompt melarang titik di akhir kalimat, tanpa merusak harga dan penomoran', async () => {
  const system = await systemOf()
  assert.match(system, /titik/i, 'aturan tanpa titik akhir harus eksplisit')
  assert.match(system, /angka|Rp\s?75\.000/, 'titik di dalam angka harus disebut sebagai pengecualian')
  assert.match(system, /penomoran|daftar|1\./, 'titik penomoran juga pengecualian; kalau tidak, daftar jadi "1 2 3"')
})

test('system prompt meminta kata yang ditarik, bukan dipotong', async () => {
  const system = await systemOf()
  assert.match(system, /yaa/, 'permintaan langsung pemilik: "ya" harus jadi "yaa"')
})

test('system prompt meminta sapaan "kak" dipakai beberapa kali', async () => {
  const system = await systemOf()
  assert.doesNotMatch(
    system,
    /"kak" atau "kamu"/,
    'selama "kamu" ditawarkan sebagai pilihan, model akan berpindah dari "kak"',
  )
  assert.match(
    system,
    /beberapa kali|berulang|lebih dari sekali/,
    '"kak" sekali di awal balasan masih terasa kering — pemilik minta lebih banyak',
  )
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

test('HTTP 429 tanpa metrik quota: bot menunggu lalu menyerah ke admin', async () => {
  // 429 tanpa metrik yang terbaca dianggap batas per menit: bot menunggu
  // sebentar lalu mencoba lagi, dan akhirnya menyerah ke admin.
  let n = 0
  const impl = async () => {
    n++
    return { ok: false, status: 429, json: async () => ({}), text: async () => '' }
  }
  const ai = createAI({
    config,
    knowledge: 'x',
    fetchImpl: impl,
    retryDelayMs: 0,
    maxRetries: 1,
    sleepImpl: async () => {},
  })
  let waitCalled = false
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalled = true } })
  assert.equal(res.escalated, true)
  assert.equal(res.reply, 'Pesan kakak sudah kami teruskan ke admin, nanti akan dibalas langsung yaa kak :D')
  assert.equal(res.failed, true, 'kegagalan sistem ditandai supaya owner tidak dibanjiri notifikasi')
  assert.equal(waitCalled, true, 'pesan tunggu dikirim saat gagal menghubungi AI')
  assert.ok(n >= 3, `harus mencoba beberapa kali, baru ${n}`)
})

test('gagal menghubungi AI memanggil onWait lalu berhasil setelah coba ulang', async () => {
  let n = 0
  const impl = async () => {
    n++
    if (n <= 2) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Halo kak, ada yang bisa dibantu?' } }] }) }
  }
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  let waitCalls = 0
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalls++ } })
  assert.equal(waitCalls, 1, 'onWait hanya dipanggil sekali saat pertama kali gagal')
  assert.equal(res.failed, false)
  assert.equal(res.reply, 'Halo kak, ada yang bisa dibantu?')
  assert.equal(n, 3)
})

test('retry berhenti jika shouldStop bernilai true (misal takeover)', async () => {
  // Takeover nyata ditandai langsung dari luar (pemilik membalas manual),
  // bukan lewat onWait — pesan tunggu baru keluar setelah satu putaran
  // chain penuh gagal.
  let n = 0
  const impl = async () => { n++; return { ok: false, status: 500, json: async () => ({}) } }
  let waitCalled = false
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const res = await ai.ask({
    jid: CHAT,
    text: 'halo',
    onWait: () => { waitCalled = true },
    shouldStop: () => true,
  })
  assert.equal(res.failed, true)
  assert.equal(n, 1, 'langsung berhenti saat takeover')
  assert.equal(waitCalled, false, 'takeover sebelum satu putaran penuh: pesan tunggu tidak perlu')
})

test('satu model gagal tidak memicu pesan tunggu; satu putaran penuh gagal baru memicu', async () => {
  // Dua model dipakai justru supaya kegagalan satu model tidak
  // dirasakan pelanggan. Pesan tunggu keluar hanya setelah keduanya
  // sama-sama gagal sekali.
  const { impl, calls } = fakeFetch('Halo kak!', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  let waitCalls = 0
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalls++ } })
  assert.equal(waitCalls, 0, 'model kedua belum dicoba; pelanggan tidak perlu tahu apa-apa')
  assert.equal(res.failed, false)
  assert.equal(res.reply, 'Halo kak!')
  assert.deepEqual(calls.map(c => c.model), ['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
})

test('pesan tunggu hanya dikirim sekali walau putaran kedua juga gagal dulu', async () => {
  // 2 putaran gagal (4 percobaan), percobaan kelima berhasil. Pesan tunggu
  // muncul sekali, di ujung putaran pertama.
  const { impl } = fakeFetch('akhirnya', { fails: 4 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  let waitCalls = 0
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalls++ } })
  assert.equal(waitCalls, 1)
  assert.equal(res.failed, false)
})

test('hasil ask menyebut model yang menjawab, bukan cuma nama provider', async () => {
  const { impl } = fakeFetch('Halo kak!', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.answeredBy, 'google')
  assert.equal(res.model, 'gemini-2.5-flash-lite', 'console perlu model, bukan nama provider saja')
})

test('riwayat di-reset otomatis jika jeda chat melebihi batas session timeout', async () => {
  const { impl } = fakeFetch('jawaban')
  const ai = createAI({ config, knowledge: 'KB', fetchImpl: impl, sessionTimeoutMs: 50 })
  await ai.ask({ jid: CHAT, text: 'pesan lama' })
  assert.equal(ai.snapshot()[CHAT].length, 2)

  // Tunggu melewati session timeout
  await new Promise((r) => setTimeout(r, 70))

  await ai.ask({ jid: CHAT, text: 'pesan baru setelah timeout' })
  assert.deepEqual(
    ai.snapshot()[CHAT].map(m => m.content),
    ['pesan baru setelah timeout', 'jawaban'],
    'sesi baru dimulai setelah jeda lama',
  )
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
  assert.equal(calls[0].model, 'gemini-2.5-flash')
  assert.equal(calls[0].url, `${BASE}/chat/completions`)
})

test('riwayat bisa disimpan lalu dipulihkan setelah bot restart', async () => {
  const { impl } = fakeFetch('jawaban')
  const ai = createAI({ config, knowledge: 'KB', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'halo' })
  const saved = ai.snapshot()
  assert.deepEqual(saved[CHAT].map(m => m.content), ['halo', 'jawaban'])

  const { impl: impl2, calls } = fakeFetch('lanjutan')
  const ai2 = createAI({ config, knowledge: 'KB', fetchImpl: impl2 })
  ai2.restore(saved)
  await ai2.ask({ jid: CHAT, text: 'lanjut' })
  assert.deepEqual(
    calls[0].messages.filter(m => m.role !== 'system').map(m => m.content),
    ['halo', 'jawaban', 'lanjut'],
    'percakapan nyambung, pelanggan tidak perlu mengulang dari awal',
  )
})

test('riwayat rusak di disk tidak membuat bot gagal start', () => {
  const ai = createAI({ config, knowledge: 'KB', fetchImpl: fakeFetch('x').impl })
  ai.restore({ [CHAT]: 'bukan array', 'lain@s.whatsapp.net': null })
  assert.deepEqual(ai.snapshot(), {})
})

test('penanda eskalasi tetap terbaca walau tidak di awal balasan', async () => {
  // Model kecil dan gratis rutin menambah pembuka atau menebalkan penandanya.
  // Kalau hanya awal balasan yang dicek, penanda itu ikut terkirim ke
  // pelanggan DAN pemilik tidak pernah diberi tahu ada pertanyaan nyangkut.
  for (const mentah of [
    '**[[ESCALATE]]** Maaf, aku tanyakan dulu ke admin ya.',
    'Baik, aku teruskan ke admin dulu. [[ESCALATE]]',
  ]) {
    const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch(mentah).impl })
    const res = await ai.ask({ jid: CHAT, text: 'ada diskon?' })
    assert.equal(res.escalated, true, mentah)
    assert.equal(res.reply.includes('ESCALATE'), false, `penanda bocor ke pelanggan: ${mentah}`)
    assert.ok(res.reply.length > 0, `balasan jadi kosong: ${mentah}`)
  }
})

test('pertanyaan berulang dijawab dari cache tanpa memanggil provider lagi', async () => {
  const { impl, calls } = fakeFetch('Buka jam 8 pagi sampai 11 malam yaa kak')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  const first = await ai.ask({ jid: CHAT, text: 'Jam buka?' })
  const second = await ai.ask({ jid: 'b@s.whatsapp.net', text: 'jam buka' })
  assert.equal(calls.length, 1, 'pertanyaan yang sama dari chat lain tidak memanggil LLM')
  assert.equal(second.reply, first.reply)
  assert.equal(second.answeredBy, 'cache')
  assert.equal(second.attempts, 0)
})

test('pertanyaan pendek dan pesan panjang tidak di-cache: jawabannya bergantung konteks', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  const panjang = 'aku butuh makalah tentang sejarah indonesia 10 halaman deadline besok'
  await ai.ask({ jid: CHAT, text: 'iya' })
  await ai.ask({ jid: CHAT, text: 'iya' })
  await ai.ask({ jid: CHAT, text: panjang })
  await ai.ask({ jid: CHAT, text: panjang })
  assert.equal(calls.length, 4)
})

test('jawaban eskalasi tidak di-cache, pertanyaan berikutnya tetap dicek', async () => {
  const { impl, calls } = fakeFetch('[[ESCALATE]] aku tanyakan admin dulu yaa')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'bisa nego harganya?' })
  await ai.ask({ jid: CHAT, text: 'bisa nego harganya?' })
  assert.equal(calls.length, 2)
})

test('balasan yang hanya berisi penanda tidak dikirim kosong', async () => {
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('[[ESCALATE]]').impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.escalated, true)
  assert.equal(res.reply, '')
})

test('titik di akhir kalimat dibuang dari balasan', async () => {
  // Prompt saja tidak cukup: model kecil dan gratis tetap menaruh titik.
  // Aturan gaya harus dijamin kode, bukan diserahkan ke model.
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('Halo kak, stoknya ada.').impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.reply, 'Halo kak, stoknya ada')
})

test('titik dibuang di setiap baris, bukan cuma di akhir balasan', async () => {
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('Bisa kak.\nKirim alamatnya ya.').impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.reply, 'Bisa kak\nKirim alamatnya ya')
})

test('harga yang berakhir titik tetap utuh', async () => {
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('Totalnya Rp75.000.').impl })
  const res = await ai.ask({ jid: CHAT, text: 'berapa?' })
  assert.equal(res.reply, 'Totalnya Rp75.000', 'yang dibuang titik akhir kalimatnya, bukan titik di dalam harganya')
})

test('penomoran "1." tidak ikut kehilangan titiknya', async () => {
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('Caranya:\n1.\n2.').impl })
  const res = await ai.ask({ jid: CHAT, text: 'gimana?' })
  assert.equal(res.reply, 'Caranya:\n1.\n2.', '"1." yang kehilangan titik berubah jadi angka yang menggantung')
})

test('tanda tanya, tanda seru, dan elipsis tidak ikut dibuang', async () => {
  const ai = createAI({ config, knowledge: 'x', fetchImpl: fakeFetch('Mau aku bantu siapkan? 😊\nSiap kak!\nAduh...').impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.reply, 'Mau aku bantu siapkan? 😊\nSiap kak!\nAduh...')
})

test('base64 tidak tertinggal di riwayat', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'ini apa?', image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' } })
  await ai.ask({ jid: CHAT, text: 'lanjut' })
  assert.equal(JSON.stringify(calls[1].messages).includes('base64'), false)
  assert.equal(calls[1].model, 'gemini-2.5-flash')
})

test('model pertama gagal, percobaan berikutnya pindah ke model kedua', async () => {
  // 1 panggilan gagal (flash), lalu berhasil (flash-lite). Tanpa fallback,
  // bot membalas pesan handover padahal model cadangan masih hidup.
  const { impl, calls } = fakeFetch('Halo kak, stoknya ada 😊', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const res = await ai.ask({ jid: CHAT, text: 'ada stok?' })
  assert.equal(res.failed, false)
  assert.equal(res.reply, 'Halo kak, stoknya ada 😊')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `${BASE}/chat/completions`)
  assert.equal(calls[1].model, 'gemini-2.5-flash-lite')
  assert.equal(calls[1].authorization, 'Bearer kg', 'semua model pakai API key yang sama')
})

test('setelah model terakhir, putaran berikutnya kembali ke model pertama', async () => {
  // 3 panggilan gagal: flash → flash-lite → flash lagi. maxRetries 5 memberi
  // enam percobaan, jadi model pertama diberi dua kesempatan.
  const { impl, calls } = fakeFetch('akhirnya', { fails: 3 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0, maxRetries: 5 })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.failed, false)
  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.slice(0, 3).map(c => c.model),
    ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    'urutan fallback melingkar, bukan berhenti di model terakhir',
  )
  assert.equal(calls[3].model, 'gemini-2.5-flash-lite', 'putaran kedua pindah ke model berikutnya lagi')
})

test('limit harian: langsung pindah ke model berikutnya tanpa mencoba model yang sama lagi', async () => {
  const { impl, calls } = quotaFetch('GenerateRequestsPerDayPerProjectPerModel-FreeTier')
  const ai = createAI({
    config: { ...config, ai: [flash, lite] },
    knowledge: 'x',
    fetchImpl: impl,
    retryDelayMs: 0,
  })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.failed, true, 'semua model kena limit harian → eskalasi')
  assert.equal(res.reason, 'quota-harian')
  assert.deepEqual(
    calls.map(c => c.model),
    ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    'model yang kena limit tidak diulang',
  )
})

test('limit harian di semua model: eskalasi ke admin tanpa menunggu lama', async () => {
  const { impl, calls } = quotaFetch('GenerateRequestsPerDayPerProjectPerModel-FreeTier')
  const ai = createAI({
    config: { ...config, ai: [flash, lite] },
    knowledge: 'x',
    fetchImpl: impl,
    sleepImpl: async () => { throw new Error('tidak boleh menunggu') },
  })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.failed, true)
  assert.equal(res.reason, 'quota-harian')
  assert.equal(calls.length, 2, 'cukup mencoba tiap model sekali')
})

test('model yang kena limit harian dilewati di chat berikutnya', async () => {
  // Batas harian tidak hilang hanya karena pelanggan berikutnya chat.
  let n = 0
  const impl = async (url, init) => {
    n++
    const model = JSON.parse(init.body).model
    if (model === 'gemini-2.5-flash') {
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => JSON.stringify({ quotaMetric: 'GenerateRequestsPerDayPerProjectPerModel' }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Halo kak' } }] }) }
  }
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const first = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(first.failed, false)
  assert.equal(first.model, 'gemini-2.5-flash-lite', 'langsung pindah ke model kedua')

  const second = await ai.ask({ jid: 'lain@s.whatsapp.net', text: 'halo lagi' })
  assert.equal(second.failed, false)
  assert.equal(second.model, 'gemini-2.5-flash-lite', 'model yang kena limit dilewati')
  assert.equal(n, 3, 'model yang kena limit tidak dicoba lagi di chat berikutnya')
})

test('limit per menit: tunggu sebentar lalu coba lagi', async () => {
  let n = 0
  const impl = async (url, init) => {
    n++
    const model = JSON.parse(init.body).model
    if (model === 'gemini-2.5-flash') {
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => JSON.stringify({ quotaMetric: 'GenerateRequestsPerMinutePerProjectPerModel' }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Halo kak' } }] }) }
  }
  const slept = []
  const ai = createAI({
    config,
    knowledge: 'x',
    fetchImpl: impl,
    retryDelayMs: 0,
    sleepImpl: async (ms) => { slept.push(ms) },
  })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.failed, false)
  assert.equal(res.model, 'gemini-2.5-flash-lite')
  assert.equal(slept.length, 0, 'model kedua langsung dicoba, tidak perlu nunggu')
})

test('nama metrik quota dibaca dari pesan error Google', () => {
  assert.equal(quotaKind(429, '{"quotaMetric":"GenerateRequestsPerDayPerProjectPerModel"}'), 'daily')
  assert.equal(quotaKind(429, '{"quotaMetric":"GenerateRequestsPerMinutePerProjectPerModel"}'), 'minute')
  assert.equal(quotaKind(500, '{"quotaMetric":"GenerateRequestsPerDayPerProjectPerModel"}'), null)
})
