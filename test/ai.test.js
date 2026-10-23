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

test('base64 tidak tertinggal di riwayat', async () => {
  const { impl, calls } = fakeFetch('ok')
  const ai = createAI({ config, knowledge: 'x', fetchImpl: impl })
  await ai.ask({ jid: CHAT, text: 'ini apa?', image: { data: Buffer.from('xyz'), mimetype: 'image/jpeg' } })
  await ai.ask({ jid: CHAT, text: 'lanjut' })
  assert.equal(JSON.stringify(calls[1].messages).includes('base64'), false)
  assert.equal(calls[1].model, 'model-teks')
})
