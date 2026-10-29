import { existsSync, readFileSync } from 'node:fs'

const REQUIRED = ['BUSINESS_NAME', 'OWNER_NUMBER']

// Semua model Google AI Studio memakai endpoint OpenAI-compatible yang sama,
// jadi satu base URL dan satu API key cukup untuk seluruh chain fallback.
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

const str = (env, key, fallback) => {
  const raw = env[key]
  return raw === undefined || raw === '' ? fallback : raw
}

const num = (env, key, fallback) => {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`${key} harus berupa angka, tapi isinya "${raw}"`)
  return n
}

/** Sama seperti num(), tapi menolak 0 dan angka negatif. */
const positive = (env, key, fallback) => {
  const n = num(env, key, fallback)
  if (!(n > 0)) {
    throw new Error(
      `${key} harus lebih besar dari 0, tapi isinya "${env[key]}". ` +
        'Nol bukan berarti "tanpa batas" — nilainya bikin bot berhenti membalas.',
    )
  }
  return n
}

/** WhatsApp memakai digit saja. "+62 812-345" bikin JID tidak sah dan
 *  pesannya diam-diam tidak pernah sampai. */
const digits = (raw) => String(raw ?? '').replace(/\D/g, '')

/**
 * Chain model dari AI_MODELS: daftar dipisah koma, URUTAN = urutan pakai.
 * Model pertama dicoba dulu; kalau kena limit harian, pindah ke model
 * berikutnya. Semua model pakai base URL dan API key yang sama.
 */
function loadModels(env) {
  const models = String(env.AI_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const apiKey = String(env.AI_API_KEY ?? '').trim()

  const missing = []
  if (!models.length) missing.push('AI_MODELS')
  if (!apiKey) missing.push('AI_API_KEY')
  for (const key of REQUIRED) {
    if (!String(env[key] ?? '').trim()) missing.push(key)
  }
  if (missing.length) {
    throw new Error(
      `Konfigurasi kurang: ${missing.join(', ')}. ` +
        'Isi di file .env — lihat .env.example untuk daftar lengkapnya.',
    )
  }

  const baseUrl = str(env, 'AI_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '')
  return models.map((model) => ({ name: 'google', baseUrl, apiKey, model }))
}

/**
 * Membaca konfigurasi dari objek env yang diberikan, bukan langsung dari
 * process.env, supaya bisa diuji tanpa menyentuh lingkungan nyata.
 */
export function loadConfig(env = process.env) {
  const ai = loadModels(env)

  const ownerNumber = digits(env.OWNER_NUMBER)
  if (!ownerNumber) {
    throw new Error(
      `OWNER_NUMBER tidak berisi satu angka pun, isinya "${env.OWNER_NUMBER}". ` +
        'Tulis nomor tanpa tanda plus, misal 62812xxxxxxx — kalau salah, ' +
        'notifikasi eskalasi tidak akan pernah sampai ke kamu.',
    )
  }

  // Nilai yang salah tulis tidak boleh diam-diam jatuh ke PUBLIC: pemilik
  // yang mengira botnya terkunci padahal terbuka untuk semua orang tidak
  // akan pernah menyadarinya.
  const mode = str(env, 'ACCESS_MODE', 'PUBLIC')
  if (!['PUBLIC', 'WHITELIST'].includes(mode)) {
    throw new Error(
      `ACCESS_MODE harus tepat "PUBLIC" atau "WHITELIST", tapi isinya "${mode}". ` +
        'Pilih salah satu — huruf besar semua.',
    )
  }

  return {
    // ai: chain model, urutannya sama dengan AI_MODELS.
    ai,
    businessName: env.BUSINESS_NAME,
    ownerNumber,
    access: {
      mode,
      whitelist: String(env.WHITELIST ?? '')
        .split(',')
        .map(digits)
        .filter(Boolean),
    },
    limits: {
      // 8 detik, bukan 3. Jendela 3 detik terbukti kepotong di pemakaian
      // sungguhan: pelanggan mengirim "kamu menjual apa?" lalu "apa aku boleh
      // tau?" dengan selisih 3,8 detik, dan bot menjawab dua kali. Mengetik
      // satu kalimat lanjutan itu perlu beberapa detik, jadi jendelanya harus
      // cukup panjang untuk menampungnya.
      debounceSec: num(env, 'DEBOUNCE_SEC', 8),
      rateInMax: positive(env, 'RATE_IN_MAX', 20),
      rateInWindowSec: positive(env, 'RATE_IN_WINDOW_SEC', 60),
      rateInCooldownMin: num(env, 'RATE_IN_COOLDOWN_MIN', 5),
      rateOutMax: positive(env, 'RATE_OUT_MAX', 15),
      rateOutWindowSec: positive(env, 'RATE_OUT_WINDOW_SEC', 60),
      chunkDelaySec: num(env, 'CHUNK_DELAY_SEC', 1),
      maxImageMb: num(env, 'MAX_IMAGE_MB', 5),
    },
  }
}

/**
 * Bot tidak pernah diizinkan jalan dengan knowledge base kosong: system
 * prompt tanpa isi membuatnya mengarang jawaban ke pelanggan.
 */
export function loadKnowledge(path = 'knowledge.md') {
  if (!existsSync(path)) {
    throw new Error(
      `knowledge.md tidak ditemukan di "${path}". Bot butuh file ini — ` +
        'tanpa itu dia akan mengarang jawaban ke pelanggan.',
    )
  }
  const text = readFileSync(path, 'utf8')
  if (!text.trim()) {
    throw new Error(
      'knowledge.md kosong. Isi dulu sebelum menjalankan bot — ' +
        'tanpa isi, bot akan mengarang jawaban ke pelanggan.',
    )
  }
  return text
}
