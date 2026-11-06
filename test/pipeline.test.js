import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractText, extractImage, isPassiveMessage, formatForWhatsApp, senderNumber, unreadableMedia, chunkText,
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

test('nomor HP diambil dari remoteJidAlt saat chat memakai LID', () => {
  // WhatsApp kini mengirim chat sebagai `192105...@lid`. Angka itu tidak bisa
  // dicari di WhatsApp dan tidak cocok dengan WHITELIST, jadi nomor aslinya
  // harus diambil dari remoteJidAlt.
  assert.equal(
    senderNumber({ key: { remoteJid: '192105716707360@lid', remoteJidAlt: '6285188502894@s.whatsapp.net' } }),
    '6285188502894',
  )
  assert.equal(senderNumber({ key: { remoteJid: '628@s.whatsapp.net' } }), '628')
  assert.equal(senderNumber({ key: {} }), null)
})

test('dokumen dan video dikenali sebagai media yang tidak terbaca', () => {
  assert.equal(unreadableMedia({ message: { documentMessage: { caption: 'ini' } } }), 'dokumen')
  assert.equal(unreadableMedia({ message: { videoMessage: { caption: 'ini' } } }), 'video')
  assert.equal(unreadableMedia({ message: { conversation: 'halo' } }), null)
  assert.equal(unreadableMedia({ message: IMG }), null)
})

test('chunkText membagi teks panjang tanpa kehilangan karakter', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `baris ${i}`).join('\n')
  const parts = chunkText(text, 4000)
  assert.ok(parts.length > 1)
  assert.equal(parts.join('\n'), text)
  assert.ok(parts.every(p => p.length > 0 && p.length <= 4000))
})

test('gambar sekali-lihat dan chat menghilang tetap terbaca', () => {
  // Baileys TIDAK membuka bungkus ini sebelum menyerahkan pesan ke kita.
  // Tanpa dibuka, foto sekali-lihat jadi "pesan tak didukung": pelanggan
  // tidak dapat balasan apa pun dan pemilik tidak dapat notifikasi apa pun.
  const img = { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }
  for (const bungkus of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage']) {
    assert.equal(
      extractImage({ message: { [bungkus]: { message: img } } })?.mimetype,
      'image/jpeg',
      bungkus,
    )
  }
  assert.equal(
    extractText({ message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'ini apa' } } } } }),
    'ini apa',
  )
  assert.equal(
    extractImage({ key: { remoteJid: CHAT }, message: { viewOnceMessageV2: { message: img } } })?.mimetype,
    'image/jpeg',
  )
  // yang memang tak didukung tetap tak didukung
  assert.equal(
    extractImage({ message: { viewOnceMessageV2: { message: { stickerMessage: {} } } } }),
    null,
  )
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

test('jendela debounce mundur selama pelanggan masih mengetik', async () => {
  // Bedanya dengan tes di atas: di sini jarak antar pesan mendekati batas
  // jendela, bukan sepersekian milidetik. Kalau timer tidak diulang tiap
  // pesan, jendela habis di tengah dan pelanggan dapat dua balasan.
  const flushes = []
  const d = createDebouncer({ waitMs: 40, onFlush: (jid, items) => flushes.push(items) })
  d.add(CHAT, { text: 'a' })
  await new Promise(r => setTimeout(r, 25))
  d.add(CHAT, { text: 'b' })
  await new Promise(r => setTimeout(r, 25))
  d.add(CHAT, { text: 'c' })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0].map(i => i.text), ['a', 'b', 'c'])
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

test('resume membatalkan pause takeover lebih cepat', () => {
  const t = createTakeover()
  t.pause(CHAT)
  assert.equal(t.isPaused(CHAT), true)
  t.resume(CHAT)
  assert.equal(t.isPaused(CHAT), false)
})

test('teks caption dari dokumen dan video juga terbaca', () => {
  assert.equal(extractText({ message: { documentMessage: { caption: 'ini file saya' } } }), 'ini file saya')
  assert.equal(extractText({ message: { videoMessage: { caption: 'ini video instruksi' } } }), 'ini video instruksi')
})

test('isPassiveMessage mengenali reaksi emoji dan protocolMessage', () => {
  assert.equal(isPassiveMessage({ message: { reactionMessage: { text: '👍' } } }), true)
  assert.equal(isPassiveMessage({ message: { protocolMessage: { type: 0 } } }), true)
  assert.equal(isPassiveMessage({ message: { conversation: 'halo' } }), false)
  assert.equal(isPassiveMessage({ message: IMG }), false)
})

test('formatForWhatsApp mengubah **tebal** menjadi *tebal*', () => {
  assert.equal(formatForWhatsApp('Ini **penting** banget'), 'Ini *penting* banget')
  assert.equal(formatForWhatsApp('*sudah benar*'), '*sudah benar*')
})