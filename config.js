import { existsSync, readFileSync } from 'node:fs'

// Urutan di sini menentukan urutan nama di pesan error, dan tesnya
// mencocokkan urutan itu.
const REQUIRED = ['AI_API_KEY', 'AI_MODEL', 'BUSINESS_NAME', 'OWNER_NUMBER']

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

const bool = (env, key, fallback) => {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase())
}

/** WhatsApp memakai digit saja. "+62 812-345" bikin JID tidak sah dan
 *  pesannya diam-diam tidak pernah sampai. */
const digits = (raw) => String(raw ?? '').replace(/\D/g, '')

/**
 * Membaca konfigurasi dari objek env yang diberikan, bukan langsung dari
 * process.env, supaya bisa diuji tanpa menyentuh lingkungan nyata.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !String(env[key] ?? '').trim())
  if (missing.length) {
    throw new Error(
      `Konfigurasi kurang: ${missing.join(', ')}. ` +
        'Isi di file .env — lihat .env.example untuk daftar lengkapnya.',
    )
  }

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
    aiBaseUrl: str(env, 'AI_BASE_URL', 'https://openrouter.ai/api/v1'),
    aiApiKey: env.AI_API_KEY,
    aiModel: env.AI_MODEL,
    // Kosong berarti pakai model yang sama untuk teks dan gambar.
    aiVisionModel: str(env, 'AI_VISION_MODEL', env.AI_MODEL),
    businessName: env.BUSINESS_NAME,
    ownerNumber,
    hours: {
      open: num(env, 'OPEN_HOUR', 8),
      close: num(env, 'CLOSE_HOUR', 23),
    },
    offlineNotice: bool(env, 'OFFLINE_NOTICE', true),
    access: {
      mode,
      whitelist: String(env.WHITELIST ?? '')
        .split(',')
        .map(digits)
        .filter(Boolean),
    },
    limits: {
      debounceSec: num(env, 'DEBOUNCE_SEC', 3),
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