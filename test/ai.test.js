import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAI } from '../ai.js'

const CHAT = 'a@s.whatsapp.net'

const zaiChat = { name: 'zai', baseUrl: 'https://zai.test/api/paas/v4', apiKey: 'kz', model: 'glm-4.7-flash' }
const cfChat = { name: 'cloudflare', baseUrl: 'https://cloudflare.test/ai/v1', apiKey: 'kc', model: 'llama-3.1-8b-instruct' }
const zaiVision = { ...zaiChat, model: 'glm-4.6v-flash' }
const cfVision = { ...cfChat, model: 'llama-3.2-11b-vision-instruct' }

const config = {
  ai: {
    chat: [zaiChat, cfChat],
    vision: [zaiVision, cfVision],
  },
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
    if (calls.length <= fails) return { ok: false, status, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: replyText } }] }) }
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

test('HTTP 429 diperlakukan sebagai gagal setelah batas retry habis', async () => {
  let n = 0
  const impl = async () => { n++; return { ok: false, status: 429, json: async () => ({}) } }
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0, maxRetries: 5 })
  let waitCalled = false
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalled = true } })
  assert.equal(res.escalated, true)
  assert.equal(res.reply, 'Pesan kakak sudah kami teruskan ke admin, nanti akan dibalas langsung yaa kak :D')
  assert.equal(res.failed, true, 'kegagalan sistem ditandai supaya owner tidak dibanjiri notifikasi')
  assert.equal(waitCalled, true, 'pesan tunggu dikirim saat gagal menghubungi AI')
  assert.equal(n, 6) // 1 percobaan awal + 5 kali retry
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

test('satu provider gagal tidak memicu pesan tunggu; satu putaran penuh gagal baru memicu', async () => {
  // Dua provider dipakai justru supaya kegagalan satu provider tidak
  // dirasakan pelanggan. Pesan tunggu keluar hanya setelah zai DAN
  // cloudflare sama-sama gagal sekali.
  const { impl, calls } = fakeFetch('Halo kak!', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  let waitCalls = 0
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalls++ } })
  assert.equal(waitCalls, 0, 'cloudflare masih belum dicoba; pelanggan tidak perlu tahu apa-apa')
  assert.equal(res.failed, false)
  assert.equal(res.reply, 'Halo kak!')
  assert.deepEqual(calls.map(c => c.model), ['glm-4.7-flash', 'llama-3.1-8b-instruct'])
})

test('chain satu provider: kegagalan pertama langsung memicu pesan tunggu', async () => {
  // Tanpa cadangan, putaran penuh = satu percobaan — perilaku lama tetap.
  const { impl } = fakeFetch('Halo kak!', { fails: 1 })
  const ai = createAI({
    config: { ...config, ai: { chat: [zaiChat], vision: [] } },
    knowledge: 'x',
    fetchImpl: impl,
    retryDelayMs: 0,
  })
  let waitCalls = 0
  const res = await ai.ask({ jid: CHAT, text: 'halo', onWait: () => { waitCalls++ } })
  assert.equal(waitCalls, 1)
  assert.equal(res.failed, false)
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
  assert.equal(res.answeredBy, 'cloudflare')
  assert.equal(res.model, 'llama-3.1-8b-instruct', 'console perlu model, bukan nama provider saja')
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
  assert.equal(calls[0].model, 'glm-4.6v-flash')
  assert.equal(calls[0].url, 'https://zai.test/api/paas/v4/chat/completions',
    'pesan bergambar dipakai ke provider vision pertama, bukan provider chat pertama')
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
  assert.equal(calls[1].model, 'glm-4.7-flash')
})

test('provider pertama gagal, percobaan berikutnya pindah ke provider kedua', async () => {
  // 1 panggilan gagal (zai), lalu berhasil (cloudflare). Tanpa fallback,
  // bot membalas pesan handover padahal provider cadangan masih hidup.
  const { impl, calls } = fakeFetch('Halo kak, stoknya ada 😊', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const res = await ai.ask({ jid: CHAT, text: 'ada stok?' })
  assert.equal(res.failed, false)
  assert.equal(res.reply, 'Halo kak, stoknya ada 😊')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://zai.test/api/paas/v4/chat/completions')
  assert.equal(calls[1].url, 'https://cloudflare.test/ai/v1/chat/completions')
  assert.equal(calls[1].model, 'llama-3.1-8b-instruct')
  assert.equal(calls[1].authorization, 'Bearer kc', 'tiap provider pakai API key-nya sendiri')
})

test('setelah provider terakhir, putaran berikutnya kembali ke provider pertama', async () => {
  // 3 panggilan gagal: zai → cloudflare → zai lagi. maxRetries 5 memberi
  // enam percobaan, jadi provider pertama diberi dua kesempatan.
  const { impl, calls } = fakeFetch('akhirnya', { fails: 3 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0, maxRetries: 5 })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.failed, false)
  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.slice(0, 3).map(c => c.model),
    ['glm-4.7-flash', 'llama-3.1-8b-instruct', 'glm-4.7-flash'],
    'urutan fallback melingkar, bukan berhenti di provider terakhir',
  )
  assert.equal(calls[3].model, 'llama-3.1-8b-instruct', 'putaran kedua pindah ke provider berikutnya lagi')
})

test('fallback vision mengikuti chain vision, bukan chain chat', async () => {
  const { impl, calls } = fakeFetch('itu tas kuliah', { fails: 1 })
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl, retryDelayMs: 0 })
  const res = await ai.ask({
    jid: CHAT,
    text: 'ini apa?',
    image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' },
  })
  assert.equal(res.failed, false)
  assert.deepEqual(
    calls.map(c => c.model),
    ['glm-4.6v-flash', 'llama-3.2-11b-vision-instruct'],
  )
})

test('tanpa provider bervisi, pesan bergambar memakai chain chat', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({
    config: { ...config, ai: { chat: [zaiChat], vision: [] } },
    knowledge: 'x',
    fetchImpl: impl,
  })
  await ai.ask({
    jid: CHAT,
    text: 'ini apa?',
    image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' },
  })
  assert.equal(calls[0].model, 'glm-4.7-flash')
})
