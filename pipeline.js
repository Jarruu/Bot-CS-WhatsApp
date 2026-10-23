// Seluruh isi file ini murni: tidak menyentuh jaringan maupun WhatsApp,
// supaya filter, batas, dan antrian bisa diuji tanpa koneksi sungguhan.

// Baileys TIDAK membuka bungkus ini sebelum menyerahkan pesan ke kita, jadi
// foto sekali-lihat dan chat yang menghilang sampai ke sini masih terbungkus.
// Daftarnya disamakan dengan normalizeMessageContent milik Baileys; kalau
// Baileys menambah bungkus baru, tambahkan di sini juga.
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
]

/** Buka bungkus sampai ketemu isi aslinya. */
function unwrap(message) {
  let content = message
  // Batas 5 putaran sama dengan Baileys: cukup untuk bungkus bertingkat, dan
  // tidak bisa berputar selamanya kalau datanya aneh.
  for (let i = 0; i < 5 && content; i++) {
    const inner = WRAPPERS.map((key) => content[key]).find(Boolean)
    if (!inner) break
    content = inner.message
  }
  return content
}

/** Teks dari pesan, atau null kalau memang tidak ada teks. */
export function extractText(msg) {
  const m = unwrap(msg?.message)
  if (!m) return null
  return m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? null
}

/** Node gambar dari pesan, atau null. Node-nya dipakai index.js untuk unduh. */
export function extractImage(msg) {
  return unwrap(msg?.message)?.imageMessage ?? null
}

/**
 * Buang apa pun yang bukan percakapan satu-lawan-satu berisi teks atau
 * gambar: grup, status broadcast, dan pesan tak didukung seperti stiker,
 * audio, video, dan dokumen.
 */
export function shouldIgnore(msg) {
  const jid = msg?.key?.remoteJid
  if (!jid) return true
  if (jid.endsWith('@g.us')) return true
  if (jid === 'status@broadcast') return true
  if (!extractText(msg) && !extractImage(msg)) return true
  return false
}

/**
 * Potong di batas baris. Potongan yang disambung dengan "\n" harus
 * menghasilkan teks aslinya persis.
 *
 * ponytail: satu baris tunggal yang lebih panjang dari `size` dipotong
 * paksa, dan potongan itu kehilangan batas barisnya saat disambung. Tidak
 * relevan untuk balasan chat; ganti ke pemotongan berbasis kalimat kalau
 * nanti botnya mengirim dokumen panjang.
 */
export function chunkText(text, size = 4000) {
  const parts = []
  let current = ''

  for (const line of String(text).split('\n')) {
    if (line.length > size) {
      if (current) {
        parts.push(current)
        current = ''
      }
      for (let i = 0; i < line.length; i += size) parts.push(line.slice(i, i + size))
      continue
    }
    if (current && current.length + 1 + line.length > size) {
      parts.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }

  if (current) parts.push(current)
  return parts.filter((p) => p.length > 0)
}

/**
 * Kumpulkan pesan beruntun dari nomor yang sama jadi satu giliran.
 * Tanpa ini, pelanggan yang mengetik empat pesan cepat dapat empat balasan.
 */
export function createDebouncer({ waitMs, onFlush }) {
  const pending = new Map()
  return {
    add(jid, item) {
      const entry = pending.get(jid) ?? { items: [], timer: null }
      entry.items.push(item)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        pending.delete(jid)
        onFlush(jid, entry.items)
      }, waitMs)
      pending.set(jid, entry)
    },
  }
}

/**
 * Batas pesan masuk per nomor. Murni anti-spam: pelanggan normal mengirim
 * beberapa pesan beruntun, spammer mengirim puluhan.
 */
export function createRateLimiter({ max, windowMs, cooldownMs }) {
  const hits = new Map()
  const blockedUntil = new Map()

  return {
    /** true = boleh diproses. */
    check(jid) {
      const now = Date.now()

      const until = blockedUntil.get(jid)
      if (until !== undefined) {
        if (now < until) return false
        blockedUntil.delete(jid)
      }

      const recent = (hits.get(jid) ?? []).filter((t) => now - t < windowMs)
      if (recent.length >= max) {
        blockedUntil.set(jid, now + cooldownMs)
        hits.set(jid, recent)
        return false
      }

      recent.push(now)
      hits.set(jid, recent)
      return true
    },
  }
}

/**
 * Batas pesan keluar lintas semua chat. Ini yang relevan terhadap risiko
 * nomor diblokir: yang terlihat seperti bot adalah pesan yang DIKIRIM.
 *
 * Menunda, tidak pernah membuang. Membuang balasan berarti pelanggan hilang
 * tanpa suara dan pemilik tidak pernah tahu.
 */
export function createSendGate({ max, windowMs }) {
  const stamps = []
  return {
    async waitTurn() {
      for (;;) {
        const now = Date.now()
        while (stamps.length && now - stamps[0] >= windowMs) stamps.shift()

        if (stamps.length < max) {
          stamps.push(now)
          return
        }

        const wait = windowMs - (now - stamps[0])
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 1)))
      }
    },
  }
}

/**
 * Antrian berurutan lintas semua chat. Tugas yang gagal tidak menghentikan
 * antrian, dan tidak melempar ke pemanggil — tugasnya sendiri yang mencatat
 * kesalahannya.
 */
export function createQueue() {
  let tail = Promise.resolve()
  return {
    push(fn) {
      const run = tail.then(() => fn())
      tail = run.then(
        () => {},
        () => {},
      )
      return tail
    },
  }
}

/**
 * Pemilik yang membalas manual menandakan dia sedang menangani chat itu;
 * bot mundur sebentar.
 *
 * `noteSent` ada karena balasan bot sendiri juga punya fromMe: true. Tanpa
 * membedakan keduanya, bot akan menganggap dirinya manusia lalu mem-pause
 * chat-nya sendiri dan berhenti menjawab pelanggan tanpa suara.
 */
export function createTakeover({ pauseMs = 1_800_000 } = {}) {
  // ponytail: Set ini tumbuh seumur proses. Beberapa ribu string per bulan
  // tidak masalah; pindah ke ring buffer kalau botnya sampai puluhan ribu
  // pesan sehari.
  const sentByBot = new Set()
  const pausedUntil = new Map()

  return {
    noteSent(id) {
      if (id) sentByBot.add(id)
    },
    isOwn(id) {
      return sentByBot.has(id)
    },
    pause(jid) {
      pausedUntil.set(jid, Date.now() + pauseMs)
    },
    isPaused(jid) {
      const until = pausedUntil.get(jid)
      if (until === undefined) return false
      if (Date.now() >= until) {
        pausedUntil.delete(jid)
        return false
      }
      return true
    },
  }
}