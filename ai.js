const ESCALATE = '[[ESCALATE]]'
const HANDOVER_MESSAGE = 'Pesan kakak sudah kami teruskan ke admin, nanti akan dibalas langsung yaa kak :D'
const FALLBACK = HANDOVER_MESSAGE
const MAX_HISTORY = 20
const IMAGE_PLACEHOLDER = '[gambar]'
const MAX_CACHE = 200
// Pertanyaan sependek "bisa?" atau "iya" jawabannya bergantung konteks chat,
// jadi tidak boleh dilayani dari cache pertanyaan lain. Yang panjang juga
// tidak: pesan detail pesanan dijawab spesifik untuk pengirimnya.
const MIN_CACHE_CHARS = 6
const MAX_CACHE_CHARS = 60
// Batas harian Google direset tengah malam waktu Pasifik (± 14:00 WIB).
// Tidak ada jam reset resmi di error, jadi model yang kena limit harian
// dicoba lagi tiap satu jam — begitu kuota direset, bot langsung jalan lagi.
const DAILY_RECHECK_MS = 60 * 60_000
// Batas per menit cukup ditunggu 60 detik.
const MINUTE_COOLDOWN_MS = 60_000
// Berapa kali bot boleh menunggu jatah per menit habis sebelum menyerah.
const MINUTE_WAIT_TRIES = 2
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** "Jam buka?" dan "jam buka" adalah pertanyaan yang sama. */
const cacheKey = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Kapan model boleh dicoba lagi setelah kena limit. Batas harian dicoba
 * ulang berkala (jam reset resminya tidak diumumkan Google), batas per menit
 * cukup 60 detik.
 */
function cooldownFor(kind, now = Date.now()) {
  return kind === 'daily' ? now + DAILY_RECHECK_MS : now + MINUTE_COOLDOWN_MS
}

function buildSystemPrompt(config, knowledge) {
  return [
    `Kamu CS WhatsApp ${config.businessName}. Balas bahasa Indonesia, singkat, ramah, dan hangat.`,
    '- Panggil pelanggan "kak" beberapa kali, jangan "kamu". Pakai "yaa", "sip", "gak".',
    '- Emoji 2 sampai 4 per balasan, tapi jangan di tengah harga, angka, atau daftar.',
    '- Jangan akhiri kalimat dengan titik. Titik di dalam angka (Rp75.000) dan penomoran (1.) tetap.',
    '- Kalau pelanggan kirim gambar, komentari gambarnya sebentar sebelum menjawab.',
    '- Jawab HANYA dari informasi bisnis di bawah. Kalau tidak ada di sana, jangan mengarang:',
    `  mulai balasan dengan ${ESCALATE}.`,
    '',
    'Informasi bisnis:',
    '---',
    knowledge,
    '---',
  ].join('\n')
}

/**
 * Buang titik di ujung kalimat. Prompt sudah melarangnya, tapi model kecil
 * dan gratis tetap menaruhnya — aturan gaya harus dijamin kode.
 *
 * Yang TIDAK boleh dibuang: titik di dalam angka ("Totalnya Rp75.000." hanya
 * kehilangan titik terakhirnya) dan titik penomoran ("1." yang kehilangan
 * titiknya berubah jadi angka menggantung).
 */
export function dropTrailingPeriods(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(/^(.*\S)\.(\s*)$/)
      if (!m) return line
      const [, body, space] = m
      if (body.endsWith('.')) return line // elipsis "..."
      if (/^\d+$/.test(body)) return line // penomoran "1." "2."
      return body + space
    })
    .join('\n')
}

/**
 * Bedakan batas harian dari batas per menit. Google menulis nama metriknya
 * di pesan error ("PerDay", "PerMinute"), jadi tidak perlu tebak.
 * 429 yang metriknya tidak terbaca dianggap per menit — lebih pendek, dan
 * kalau ternyata harian, bot tetap escalate ke admin, cuma lebih lambat.
 */
export function quotaKind(status, errorText) {
  if (status !== 429) return null
  const t = String(errorText ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (t.includes('perminute')) return 'minute'
  if (t.includes('perday') || t.includes('daily')) return 'daily'
  return 'minute'
}

export function createAI({
  config,
  knowledge,
  fetchImpl = fetch,
  sleepImpl = sleep,
  retryDelayMs = 5000,
  maxRetries = 5,
  sessionTimeoutMs = 6 * 60 * 60 * 1000,
}) {
  /** @type {Map<string, Array<{role: string, content: string}>>} */
  const histories = new Map()
  const lastActive = new Map()
  // Pertanyaan berulang (jam buka, ongkir, cara bayar) dijawab tanpa LLM.
  // Isinya jawaban jadi — bukan riwayat chat — supaya pertanyaan sejenis dari
  // pelanggan lain tetap dapat jawaban yang sama persis.
  const answers = new Map()
  const systemPrompt = buildSystemPrompt(config, knowledge)
  // Model yang kena limit, dan sampai kapan tidak boleh dicoba lagi.
  // Berlaku lintas pesan: limit harian tidak hilang hanya karena chat baru.
  const quotaUntil = new Map()
  // Jam virtual: maju saat bot menunggu. Dipakai supaya cooldown yang
  // sudah lewat benar-benar hangus, tanpa bergantung pada jam sistem.
  let clock = Date.now()
  const wait = async (ms) => {
    clock += ms
    await sleepImpl(ms)
  }
  const chain = config.ai

  const historyFor = (jid) => {
    const now = Date.now()
    const last = lastActive.get(jid)
    if (last && now - last > sessionTimeoutMs) {
      histories.delete(jid)
    }
    lastActive.set(jid, now)
    if (!histories.has(jid)) histories.set(jid, [])
    return histories.get(jid)
  }

  // Riwayat menyimpan teks saja. Base64 gambar sengaja tidak pernah masuk
  // ke sini — kalau ikut tersimpan, history.json membengkak sampai puluhan MB
  // dalam sehari. Gambar hanya menempel pada permintaan yang sedang berjalan.
  const trim = (list) => {
    while (list.length > MAX_HISTORY) list.shift()
  }

  const isCooling = (model) => (quotaUntil.get(model)?.until ?? 0) > clock
  // Semua model kena limit harian (bukan per menit): tidak ada gunanya
  // menunggu, langsung eskalasi ke admin.
  const allDailyLimited = () =>
    chain.length > 0 && chain.every((p) => quotaUntil.get(p.model)?.kind === 'daily')

  async function callProvider(provider, messages) {
    const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ model: provider.model, messages }),
    })
    if (!res.ok) {
      const err = new Error(`model ${provider.model} membalas ${res.status}`)
      err.status = res.status
      err.quotaText = await errorText(res)
      throw err
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('bentuk balasan provider tidak dikenali')
    return content
  }

  /** Isi error mentah; nama metrik quota-nya ("PerDay", "PerMinute") ada di sini. */
  async function errorText(res) {
    try {
      return String(await res.text())
    } catch {
      return ''
    }
  }

  return {
    async ask({
      jid,
      text,
      image,
      onWait,
      retryDelayMs: callRetryDelayMs,
      maxRetries: callMaxRetries,
      shouldStop = () => false,
    }) {
      const actualRetryDelay = callRetryDelayMs ?? retryDelayMs
      const actualMaxRetries = callMaxRetries ?? maxRetries

      const history = historyFor(jid)

      const label = image ? (text ? `${text} ${IMAGE_PLACEHOLDER}` : IMAGE_PLACEHOLDER) : text
      const key = !image ? cacheKey(text) : ''
      const cacheable = key.length >= MIN_CACHE_CHARS && key.length <= MAX_CACHE_CHARS
      const cached = cacheable ? answers.get(key) : undefined
      if (cached) {
        history.push({ role: 'user', content: label }, { role: 'assistant', content: cached })
        trim(history)
        return { reply: cached, escalated: false, failed: false, waited: false, answeredBy: 'cache', model: 'cache', attempts: 0, reason: null }
      }

      history.push({ role: 'user', content: label })
      trim(history)

      const messages = [{ role: 'system', content: systemPrompt }, ...history]
      if (image) {
        messages[messages.length - 1] = {
          role: 'user',
          content: [
            { type: 'text', text: text || 'Gambar dari pelanggan.' },
            {
              type: 'image_url',
              image_url: {
                url: `data:${image.mimetype};base64,${image.data.toString('base64')}`,
              },
            },
          ],
        }
      }

      // Semua model Google bisa melihat gambar, jadi chain teks dan chain
      // gambar sama saja.

      let raw
      let failed = false
      let notifiedWait = false
      let attempt = 0
      let waits = 0
      let cursor = 0
      let answeredBy = null
      let answeredModel = null
      let reason = null

      // Pelanggan diberi tahu satu kali kalau bot memang harus menunggu.
      const notifyWait = async () => {
        if (notifiedWait) return
        notifiedWait = true
        if (!onWait) return
        try {
          await onWait()
        } catch (waitErr) {
          console.error('gagal memanggil onWait:', waitErr?.message || waitErr)
        }
      }

      while (true) {
        const live = chain.filter((p) => !isCooling(p.model))
        if (!live.length) {
          // Semua model sedang kena limit.
          if (allDailyLimited()) {
            // Semua model kena limit harian: menunggu tidak ada gunanya,
            // eskalasi ke admin sekarang.
            failed = true
            reason = 'quota-harian'
            break
          }
          // Batas per menit: tunggu model yang paling cepat bebas, lalu coba lagi.
          // Maksimal dua kali tunggu (± 2 menit) — lebih dari itu lebih baik
          // eskalasi ke admin daripada menahan pelanggan.
          if (waits >= MINUTE_WAIT_TRIES || shouldStop()) {
            failed = true
            reason = 'error'
            break
          }
          waits++
          await notifyWait()
          const soonest = Math.min(
            ...chain.map((p) => quotaUntil.get(p.model)?.until ?? clock),
          )
          await wait(Math.max(0, Math.min(soonest - clock, MINUTE_COOLDOWN_MS)))
          continue
        }

        const provider = live[cursor % live.length]
        cursor++
        attempt++
        try {
          raw = await callProvider(provider, messages)
          failed = false
          answeredBy = provider.name
          answeredModel = provider.model
          break
        } catch (err) {
          // Tanpa ini, kegagalan provider hilang begitu saja dari console:
          // pemilik tidak bisa tahu model mana yang mati dan kenapa.
          console.error(`percobaan ${attempt} (${provider.model}) gagal: ${err?.message || err}`)

          const kind = quotaKind(err?.status, err?.quotaText)
          if (kind) {
            // Model kena limit: catat sampai kapan, lalu pindah ke model
            // berikutnya tanpa menunggu — bukan retry ke model yang sama.
            quotaUntil.set(provider.model, { until: cooldownFor(kind, clock), kind })
            console.error(`model ${provider.model} kena limit ${kind}`)
            continue
          }

          // Pesan tunggu baru dikirim setelah SATU PUTARAN penuh chain gagal,
          // bukan saat model pertama saja. Punya model cadangan berarti
          // satu kegagalan itu tidak perlu dirasakan pelanggan.
          if (attempt >= chain.length) await notifyWait()

          // attempt 1 adalah percobaan awal, lalu maksimal actualMaxRetries kali retry
          if (attempt > actualMaxRetries || shouldStop()) {
            failed = true
            reason = 'error'
            break
          }

          await wait(actualRetryDelay)
        }
      }

      if (failed) {
        return { reply: FALLBACK, escalated: true, failed: true, waited: notifiedWait, answeredBy: null, model: null, attempts: attempt, reason }
      }

      // Penanda bisa datang di mana saja: model kecil dan gratis rutin
      // menambah kalimat pembuka atau menebalkan penandanya. Yang dicari
      // keberadaannya, bukan posisinya — kalau hanya awal balasan yang dicek,
      // penanda itu ikut terkirim ke pelanggan dan pemilik tidak pernah
      // diberi tahu ada pertanyaan yang nyangkut.
      const escalated = raw.includes(ESCALATE)
      const bersih = escalated ? raw.replace(/\*{0,2}\[\[ESCALATE\]\]\*{0,2}/g, '').trim() : raw
      const reply = dropTrailingPeriods(bersih)

      history.push({ role: 'assistant', content: reply })
      trim(history)

      // Eskalasi tidak di-cache: jawabannya belum pasti, dan menyimpannya
      // berarti pertanyaan berikutnya ikut ditolak tanpa dicek.
      if (cacheable && !escalated && reply) {
        answers.set(key, reply)
        if (answers.size > MAX_CACHE) answers.delete(answers.keys().next().value)
      }

      return { reply, escalated, failed: false, waited: notifiedWait, answeredBy, model: answeredModel, attempts: attempt, reason: null }
    },

    /**
     * Riwayat untuk ditulis ke disk. Berisi teks saja — gambar sudah
     * dikurangi jadi penanda sebelum masuk sini, jadi base64 tidak pernah
     * ikut tersimpan.
     */
    snapshot() {
      return Object.fromEntries(histories)
    },

    /** Pulihkan setelah restart. Isi yang rusak diabaikan, bukan dilempar. */
    restore(data) {
      for (const [jid, list] of Object.entries(data ?? {})) {
        if (!Array.isArray(list)) continue
        histories.set(jid, list.slice(-MAX_HISTORY))
      }
    },
  }
}
