// Perekat ke Baileys. File ini sengaja tipis: tidak ada logika yang bisa
// diuji di sini, semuanya didelegasikan ke config.js, pipeline.js, dan ai.js.
import 'dotenv/config'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, DEFAULT_CONNECTION_CONFIG } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'

import { loadConfig, loadKnowledge } from './config.js'
import { createAI } from './ai.js'
import {
  extractText, extractImage, shouldIgnore, chunkText,
  createDebouncer, createRateLimiter, createSendGate, createQueue, createTakeover,
} from './pipeline.js'
import { createQrServer, qrPageUrl } from './server.js'

// Baileys butuh logger di dua tempat, dan objeknya harus sama. Socket tidak
// menyimpan logger-nya, jadi ambil dari default resminya.
const LOGGER = DEFAULT_CONNECTION_CONFIG.logger

// ---- Konfigurasi dulu, sebelum menyentuh Baileys -------------------------
// Kalau .env kurang atau knowledge.md kosong, bot harus mati di sini dengan
// pesan jelas — bukan setengah hidup dengan jawaban karangan.
let config
let knowledge
try {
  config = loadConfig()
  knowledge = loadKnowledge()
} catch (err) {
  console.error(`\n${err.message}\n`)
  process.exit(1)
}

const DATA_DIR = 'data'
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const LOG_FILE = join(DATA_DIR, 'log.jsonl')
mkdirSync(DATA_DIR, { recursive: true })

const ai = createAI({ config, knowledge })
const { limits } = config

// pipeline.js memakai milidetik; .env memakai satuan yang enak ditulis manusia.
const debouncer = createDebouncer({ waitMs: limits.debounceSec * 1000, onFlush })
const rateLimiter = createRateLimiter({
  max: limits.rateInMax,
  windowMs: limits.rateInWindowSec * 1000,
  cooldownMs: limits.rateInCooldownMin * 60 * 1000,
})
const sendGate = createSendGate({ max: limits.rateOutMax, windowMs: limits.rateOutWindowSec * 1000 })
const chatQueues = new Map()
function queueFor(jid) {
  if (!chatQueues.has(jid)) chatQueues.set(jid, createQueue())
  return chatQueues.get(jid)
}
const takeover = createTakeover({ pauseMs: 10 * 60 * 1000 })

const OWNER_JID = `${config.ownerNumber}@s.whatsapp.net`
const WAIT_MESSAGE = 'Baik kak, mohon ditunggu sebentar yaa kak.'
const HANDOVER_MESSAGE = 'Pesan kakak sudah kami teruskan ke admin, nanti akan dibalas langsung yaa kak :D'
const UNSUPPORTED_MEDIA_MESSAGE = 'Maaf ya kak, saat ini bot TemanKita baru bisa membaca teks dan foto 📷 Boleh tolong diketik atau kirim foto saja yaa kak :D'
const RATE_LIMIT_MESSAGE = 'Baik kak, mohon tunggu sebentar yaa agar admin bisa memproses pesan sebelumnya :D'
const EMPTY_REPLY = 'Maaf ya kak, aku belum bisa jawab itu 🙏 Aku tanyakan dulu ke admin, nanti dibalas ya kak :D'
const IMAGE_TOO_BIG = 'Gambarnya kegedean jadi belum bisa aku buka 📷 Coba kirim ulang dengan ukuran lebih kecil ya kak :D'
const IMAGE_FAILED = 'Gambarnya gagal aku buka 📷 Coba kirim ulang ya kak :D'
const FAILURE_NOTICE_INTERVAL_MS = 15 * 60 * 1000

const rateLimitNotified = new Map()
const unsupportedNotified = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()

// ---- Log -----------------------------------------------------------------
// Hanya teks dan penanda. Isi gambar maupun base64 tidak pernah masuk sini.
function log(fields) {
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify({ t: now(), ...fields })}\n`)
  } catch (err) {
    console.error('gagal menulis log:', err.message)
  }
}

// ---- Riwayat -------------------------------------------------------------
// Ditulis dengan jeda supaya disk tidak tersentuh tiap pesan.
let historyTimer = null
function saveHistory() {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = setTimeout(flushHistory, 2000)
}
function flushHistory() {
  if (historyTimer) {
    clearTimeout(historyTimer)
    historyTimer = null
  }
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(ai.snapshot()))
  } catch (err) {
    console.error('gagal menyimpan riwayat:', err.message)
  }
}
try {
  ai.restore(JSON.parse(readFileSync(HISTORY_FILE, 'utf8')))
} catch {
  // Belum ada file riwayat, atau isinya rusak. Mulai dari kosong.
}

// ---- Balasan -------------------------------------------------------------
async function send(jid, text) {
  await sendGate.waitTurn()
  let sent
  try {
    sent = await sock.sendMessage(jid, { text })
  } catch (err) {
    // Koneksi bisa putus tepat di detik pengiriman. Sekali coba lagi: balasan
    // yang hilang berarti pelanggan menunggu selamanya tanpa ada yang tahu.
    console.error(`gagal mengirim, mencoba sekali lagi: ${err.message}`)
    await sendGate.waitTurn()
    try {
      sent = await sock.sendMessage(jid, { text })
    } catch (err2) {
      log({ jid, dir: 'out', text, adaGambar: false, eskalasi: false, sebab: 'kirim-gagal' })
      throw err2
    }
  }
  takeover.noteSent(sent?.key?.id)
  log({ jid, dir: 'out', text, adaGambar: false, eskalasi: false, sebab: null })
  return sent
}

let lastFailureNotice = 0

async function notifyOwner(jid, question, reason) {
  const sistem = reason === 'sistem'
  // Kegagalan sistem berulang tidak boleh membanjiri WhatsApp pemilik —
  // notifikasi bertubi-tubi itu sendiri sinyal bot. Eskalasi pengetahuan
  // dan handover ke admin tidak dibatasi: tiap kejadian perlu diketahui manusia.
  if (sistem) {
    if (Date.now() - lastFailureNotice < FAILURE_NOTICE_INTERVAL_MS) return
    lastFailureNotice = Date.now()
  }

  let title
  if (reason === 'handover') {
    title = '⚠️ Bot gagal menghubungi AI (setelah 5x coba). Chat dialihkan ke admin.'
  } else if (reason === 'gambar-gagal') {
    title = '📷 Pelanggan mengirim foto tapi gagal diunduh sistem.'
  } else if (sistem) {
    title = '⚠️ Bot gagal menghubungi AI.'
  } else {
    title = '📩 Ada pertanyaan yang bot belum bisa jawab.'
  }

  const body = [
    title,
    '',
    `Nomor: ${jid.split('@')[0]}`,
    `Pesan: ${question}`,
  ]
  if (sistem || reason === 'handover' || reason === 'gambar-gagal') {
    body.push('', 'Silakan balas atau cek langsung chat pelanggan dari HP.')
  }
  await send(OWNER_JID, body.join('\n'))
}

async function processMessage(jid, items) {
  const text = items.map((i) => i.text).filter(Boolean).join('\n')
  const withImage = [...items].reverse().find((i) => i.image)
  let image = null

  if (withImage) {
    const bytes = Number(withImage.image.fileLength?.toNumber?.() ?? withImage.image.fileLength ?? 0)
    if (bytes > limits.maxImageMb * 1_048_576) {
      await send(jid, IMAGE_TOO_BIG)
      log({ jid, dir: 'out', text: IMAGE_TOO_BIG, adaGambar: false, eskalasi: false, sebab: 'gambar-besar' })
      return
    }
    try {
      const buffer = await downloadMediaMessage(
        withImage.msg,
        'buffer',
        {},
        // `logger` wajib ada di sini. Kalau media-nya sudah kedaluwarsa
        // (404/410), Baileys mencatat lewat ctx.logger SEBELUM memanggil
        // reuploadRequest — tanpa logger, penyelamatan media kedaluwarsa itu
        // mati dan yang muncul malah TypeError yang menyesatkan.
        { reuploadRequest: sock.updateMediaMessage, logger: LOGGER },
      )
      image = { data: buffer, mimetype: withImage.image.mimetype ?? 'image/jpeg' }
    } catch (err) {
      // Kegagalan unduh tidak boleh naik ke atas: satu gambar rusak tidak
      // boleh menghentikan antrian untuk pelanggan lain.
      console.error('gagal mengunduh gambar:', err.message)
      await send(jid, IMAGE_FAILED)
      await notifyOwner(jid, text || '[foto dari pelanggan]', 'gambar-gagal')
      log({ jid, dir: 'out', text: IMAGE_FAILED, adaGambar: false, eskalasi: false, sebab: 'unduh-gagal' })
      return
    }
  }

  await sock.sendPresenceUpdate('composing', jid).catch(() => { })
  await sleep(1000 + Math.random() * 2000)

  const { reply, escalated, failed, waited, answeredBy, model, attempts } = await ai.ask({
    jid,
    text,
    image,
    onWait: async () => {
      await send(jid, WAIT_MESSAGE)
      await notifyOwner(jid, text || '[gambar]', 'sistem')
    },
    shouldStop: () => takeover.isPaused(jid),
  })
  // Model yang menjawab ikut tampil di console: kalau balasannya aneh, ini
  // pertanyaan pertama yang perlu dijawab — provider mana yang sedang dipakai.
  console.log(
    failed
      ? `[ai] ${jid.split('@')[0]}: gagal semua provider (${attempts} percobaan)`
      : `[ai] ${jid.split('@')[0]}: ${answeredBy}/${model} (percobaan ${attempts})`,
  )
  // Nama provider yang menjawab + jumlah percobaan. Ini yang membuat
  // pertanyaan "mana provider yang dipakai" bisa dijawab dari log, bukan
  // dari tebakan.
  log({ jid, dir: 'ai', text: null, adaGambar: Boolean(image), eskalasi: escalated, sebab: failed ? 'ai-gagal-total' : 'ai-berhasil', provider: answeredBy, model, percobaan: attempts })
  saveHistory()

  // Jika chat diambil alih oleh pemilik saat bot sedang retry, jangan kirim balasan bot lagi
  if (takeover.isPaused(jid)) {
    return
  }

  // Jika setelah 5x coba AI tetap gagal, alihkan chat ke admin:
  if (failed) {
    takeover.pause(jid)
    await send(jid, HANDOVER_MESSAGE)
    await notifyOwner(jid, text || '[gambar]', 'handover')
    return
  }

  let body = (reply ?? '').trim() || EMPTY_REPLY

  const chunks = chunkText(body)
  for (let i = 0; i < chunks.length; i++) {
    await send(jid, chunks[i])
    if (i < chunks.length - 1) await sleep(limits.chunkDelaySec * 1000)
  }

  if (escalated) await notifyOwner(jid, text || '[gambar]', 'pengetahuan')
}

// ---- Penanganan pesan ----------------------------------------------------
function onFlush(jid, items) {
  queueFor(jid).push(async () => {
    try {
      await processMessage(jid, items)
    } catch (err) {
      console.error('gagal memproses pesan:', err)
      log({ jid, dir: 'in', text: null, adaGambar: false, eskalasi: false, sebab: `error: ${err.message}` })
    }
  })
}

function handleMessages(event) {
  if (event.type !== 'notify') return

  for (const msg of event.messages) {
    const jid = msg?.key?.remoteJid
    if (!jid) continue

    // Takeover lebih dulu, dan urutannya penting: balasan bot sendiri juga
    // punya fromMe, jadi "ada fromMe" saja tidak cukup untuk menyimpulkan
    // pemilik sedang turun tangan.
    if (msg.key.fromMe) {
      if (!takeover.isOwn(msg.key.id)) {
        const text = extractText(msg)?.trim()?.toLowerCase()
        if (text === '!resume' || text === '!bot') {
          takeover.resume(jid)
        } else {
          takeover.pause(jid)
        }
      }
      continue
    }

    // Abaikan grup WhatsApp, status broadcast, dan saluran/newsletter
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) {
      continue
    }

    if (takeover.isPaused(jid)) continue

    const number = jid.split('@')[0]
    if (config.access.mode === 'WHITELIST' && !config.access.whitelist.includes(number)) continue

    // Jika pesan bukan teks dan bukan gambar (misal voice note/audio, stiker, dokumen, video)
    if (!extractText(msg) && !extractImage(msg)) {
      log({ jid, dir: 'in', text: null, adaGambar: false, eskalasi: false, sebab: 'tak-didukung' })
      const lastWarn = unsupportedNotified.get(jid) || 0
      if (Date.now() - lastWarn > 30_000) {
        unsupportedNotified.set(jid, Date.now())
        send(jid, UNSUPPORTED_MEDIA_MESSAGE).catch(() => {})
      }
      continue
    }

    if (!rateLimiter.check(jid)) {
      log({ jid, dir: 'in', text: null, adaGambar: false, eskalasi: false, sebab: 'rate-limit' })
      const lastWarn = rateLimitNotified.get(jid) || 0
      const cooldownMs = limits.rateInCooldownMin * 60 * 1000
      if (Date.now() - lastWarn > cooldownMs) {
        rateLimitNotified.set(jid, Date.now())
        send(jid, RATE_LIMIT_MESSAGE).catch(() => {})
      }
      continue
    }

    const text = extractText(msg)
    log({ jid, dir: 'in', text, adaGambar: Boolean(extractImage(msg)), eskalasi: false, sebab: null })
    debouncer.add(jid, { text, image: extractImage(msg), msg })
  }
}

// ---- Koneksi -------------------------------------------------------------
let sock
let reconnecting = false

// State untuk halaman QR: starting | waiting | connected | disconnected | logged_out
const qrState = { status: 'starting', qr: null, qrAt: null }

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  sock = makeWASocket({
    auth: state,
    logger: LOGGER,
    // Wajib false. Kalau bot menandai dirinya online, WhatsApp berhenti
    // mengirim push notification dan HP pemilik diam saat ada chat masuk —
    // padahal justru itu yang dibutuhkan untuk takeover manual.
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.upsert', handleMessages)

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      qrState.status = 'waiting'
      qrState.qr = qr
      qrState.qrAt = Date.now()
      console.log('\nQR WhatsApp tersedia. Buka URL berikut dari HP:\n')
      console.log(`  ${qrPageUrl(PORT)}\n`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      reconnecting = false
      qrState.status = 'connected'
      qrState.qr = null
      qrState.qrAt = null
      console.log(`\nTersambung. Bot ${config.businessName} siap menerima pesan.\n`)
    }

    if (connection !== 'close') return

    const code = lastDisconnect?.error?.output?.statusCode
    if (code === DisconnectReason.loggedOut) {
      qrState.status = 'logged_out'
      qrState.qr = null
      qrState.qrAt = null
      console.log('\nSesi WhatsApp sudah tidak berlaku. Jalankan ulang lalu scan QR lagi.')
      flushHistory()
      process.exit(0)
    }

    if (reconnecting) return
    reconnecting = true
    qrState.status = 'disconnected'
    console.log(`\nKoneksi putus (kode ${code ?? 'tidak diketahui'}). Menyambung ulang...\n`)
    setTimeout(() => {
      start().catch((err) => {
        reconnecting = false
        console.error('gagal menyambung ulang:', err.message)
      })
    }, 3000)
  })
}

// Proses tidak boleh mati karena satu error tak terduga.
process.on('unhandledRejection', (err) => console.error('promise ditolak tanpa penangan:', err))
process.on('uncaughtException', (err) => console.error('error tak tertangkap:', err))
process.on('SIGINT', () => {
  console.log('\nBerhenti. Menyimpan riwayat...')
  flushHistory()
  process.exit(0)
})

// ---- Server HTTP untuk QR ------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
const server = createQrServer({
  getState: () => qrState,
  businessName: config.businessName,
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nServer HTTP berjalan di port ${PORT}`)
  console.log(`QR page: ${qrPageUrl(PORT)}\n`)
})

start().catch((err) => {
  console.error(`\nGagal menyambung ke WhatsApp: ${err.message}\n`)
  process.exit(1)
})
