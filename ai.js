const ESCALATE = '[[ESCALATE]]'
const FALLBACK = 'Maaf, sistem kami sedang sibuk. Mohon coba lagi sebentar lagi ya.'
const MAX_HISTORY = 20
const IMAGE_PLACEHOLDER = '[gambar]'

function buildSystemPrompt(config, knowledge) {
  return [
    `Kamu adalah asisten customer service untuk ${config.businessName}.`,
    'Jawab dengan singkat, sopan, dan dalam bahasa Indonesia.',
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

      const trimmed = raw.trimStart()
      const escalated = trimmed.startsWith(ESCALATE)
      const reply = escalated ? trimmed.slice(ESCALATE.length).trimStart() : raw

      history.push({ role: 'assistant', content: reply })
      trim(history)

      return { reply, escalated, failed: false }
    },
  }
}