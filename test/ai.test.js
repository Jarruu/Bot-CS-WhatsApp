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

test('HTTP 429 diperlakukan sebagai gagal, bukan crash', async () => {
  let n = 0
  const impl = async () => { n++; return { ok: false, status: 429, json: async () => ({}) } }
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  const res = await ai.ask({ jid: CHAT, text: 'halo' })
  assert.equal(res.escalated, true)
  assert.ok(res.reply.length > 0)
  assert.equal(res.failed, true, 'kegagalan sistem ditandai supaya owner tidak dibanjiri notifikasi')
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
  assert.equal(calls[1].model, 'model-teks')
})
