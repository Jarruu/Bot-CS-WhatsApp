const ESCALATE = '[[ESCALATE]]'
const FALLBACK = 'Maaf ya, sistem kami lagi sibuk 🙏 Coba kirim lagi sebentar lagi ya.'
const MAX_HISTORY = 20
const IMAGE_PLACEHOLDER = '[gambar]'

function buildSystemPrompt(config, knowledge) {
  return [
    `Kamu adalah asisten customer service untuk ${config.businessName}.`,
    'Jawab dalam bahasa Indonesia, singkat, dan ramah seperti admin muda yang',
    'senang membantu dan hangat — bukan seperti balasan mesin atau surat resmi.',
    '',
    'Gaya balasan:',
    '- Sapa seperlunya, jangan bertele-tele. Langsung ke jawabannya.',
    '- Jangan cuek. Tanggapi dulu apa yang pelanggan bilang dengan hangat,',
    '  baru masuk ke isi jawabannya. Kalau dia mengirim gambar, komentari',
    '  gambarnya sebentar sebelum menjawab.',
    '- Pakai emoji 2 sampai 4 per balasan, dan usahakan minimal satu. Emoji',
    '  yang bikin balasan terasa hidup, bukan yang sekadar menempel di akhir.',
    '- Jangan taruh emoji di tengah daftar harga, angka, atau langkah teknis —',
    '  di situ emoji bikin susah dibaca.',
    '- Pakai kata yang ditarik, bukan dipotong. "yaa", bukan "ya". "sip" atau',
    '  "oke", bukan "ok". "gak", bukan "tidak". Tapi jangan berlebihan sampai',
    '  hurufnya jadi banyak sekali.',
    '- JANGAN menutup kalimat atau baris dengan titik. Tanpa titik terasa',
    '  akrab, dengan titik terasa seperti surat resmi. Tanda tanya dan tanda',
    '  seru tetap boleh dipakai. Titik tetap dipakai di dalam angka',
    '  (Rp75.000) dan di penomoran daftar (1. 2. 3.) — yang itu jangan dihapus.',
    '- Panggil pelanggan dengan "kak", bukan "kamu" atau "Anda". Pakai',
    '  beberapa kali dalam satu balasan: di sapaan awal, dan sekali lagi saat',
    '  menawarkan atau mengonfirmasi sesuatu. Tapi jangan di tiap kalimat —',
    '  itu malah terdengar seperti orang yang bicara sendiri.',
    '- Kabar baik (stok ada, bisa dikirim) disampaikan dengan senang. Kabar',
    '  buruk (kosong, tidak bisa) disampaikan lembut, lalu tawarkan alternatif.',
    '- Jangan pakai tanda seru bertumpuk atau huruf besar semua.',
    '',
    'Kalau di informasi bisnis di bawah ada aturan gaya bicara sendiri, ikuti',
    'aturan itu — itu keinginan langsung pemilik usaha.',
    '',
    'Jawab HANYA berdasarkan informasi bisnis di bawah ini.',
    'Kalau jawabannya tidak ada di sana, JANGAN mengarang.',
    `Mulai balasanmu dengan penanda ${ESCALATE} kalau jawabannya tidak ada di sana.`,
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

export function createAI({ config, knowledge, fetchImpl = fetch }) {
  /** @type {Map<string, Array<{role: string, content: string}>>} */
  const histories = new Map()
  const systemPrompt = buildSystemPrompt(config, knowledge)

  const historyFor = (jid) => {
    if (!histories.has(jid)) histories.set(jid, [])
    return histories.get(jid)
  }

  // Riwayat menyimpan teks saja. Base64 gambar sengaja tidak pernah masuk
  // ke sini — kalau ikut tersimpan, history.json membengkak sampai puluhan MB
  // dalam sehari. Gambar hanya menempel pada permintaan yang sedang berjalan.
  const trim = (list) => {
    while (list.length > MAX_HISTORY) list.shift()
  }

  async function callProvider(model, messages) {
    const res = await fetchImpl(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    })
    if (!res.ok) throw new Error(`provider membalas ${res.status}`)
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('bentuk balasan provider tidak dikenali')
    return content
  }

  return {
    async ask({ jid, text, image }) {
      const history = historyFor(jid)

      const label = image ? (text ? `${text} ${IMAGE_PLACEHOLDER}` : IMAGE_PLACEHOLDER) : text
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

      const model = image ? config.aiVisionModel : config.aiModel

      let raw
      let failed = false
      try {
        raw = await callProvider(model, messages)
      } catch {
        try {
          raw = await callProvider(model, messages)
        } catch {
          failed = true
        }
      }

      if (failed) {
        return { reply: FALLBACK, escalated: true, failed: true }
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

      return { reply, escalated, failed: false }
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