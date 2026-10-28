import { existsSync, readFileSync } from 'node:fs'

// Urutan di sini menentukan urutan nama di pesan error, dan tesnya
// mencocokkan urutan itu.
const REQUIRED = ['BUSINESS_NAME', 'OWNER_NUMBER']

const PROVIDER_FIELDS = ['BASE_URL', 'API_KEY', 'MODEL']

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
 * Untuk nama di AI_PROVIDERS (misal "google") → prefix env "AI_GOOGLE_...".
 * Nama yang berisi selain huruf/angka/garis bawah jadi env key yang
 * mustahil ditulis, jadi ditolak sebelum bot start, bukan diam-diam
 * dicari lalu tidak ketemu.
 */
const providerPrefix = (name) => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `Nama provider "${name}" di AI_PROVIDERS hanya boleh huruf, angka, dan ` +
        'garis bawah — env-nya diawali AI_' + name.toUpperCase() + '_.',
    )
  }
  return `AI_${name.toUpperCase()}_`
}

/**
 * Baca daftar provider dari AI_PROVIDERS, urutannya jadi urutan fallback.
 * Setiap provider wajib punya AI_<NAMA>_BASE_URL, AI_<NAMA>_API_KEY, dan
 * AI_<NAMA>_MODEL; yang juga punya AI_<NAMA>_VISION_MODEL ikut jadi
 * pilihan model bervisi.
 */
function loadProviders(env) {
  const names = String(env.AI_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Kosong sudah ditolak di loadConfig supaya pesannya gabungan dengan
  // variabel wajib yang lain; di sini fokus ke kelengkapan tiap provider.

  const kurang = []
  const chat = []
  const vision = []
  for (const name of names) {
    const prefix = providerPrefix(name)
    // API key kosong = provider tidak dipakai. Tanpa aturan ini, punya empat
    // provider cadangan berarti wajib mengisi keempat API key sekaligus —
    // satu yang kosong bikin bot menolak start.
    if (!String(env[prefix + 'API_KEY'] ?? '').trim()) continue
    const missing = PROVIDER_FIELDS.filter((f) => !String(env[prefix + f] ?? '').trim())
    if (missing.length) {
      kurang.push(`provider "${name}" kurang: ${missing.map((f) => prefix + f).join(', ')}`)
      continue
    }
    const provider = {
      name,
      baseUrl: env[prefix + 'BASE_URL'].replace(/\/+$/, ''),
      apiKey: env[prefix + 'API_KEY'],
      model: env[prefix + 'MODEL'],
    }
    chat.push(provider)
    const visionModel = str(env, prefix + 'VISION_MODEL', '')
    if (visionModel) vision.push({ ...provider, model: visionModel })
  }

  if (kurang.length) {
    throw new Error(
      kurang.join('; ') +
        '. Isi di file .env — lihat .env.example untuk daftar lengkapnya.',
    )
  }
  // Chain kosong bikin bot diam tanpa error: tidak ada provider yang bisa
  // dipanggil. Lebih baik mati saat start dengan pesan jelas.
  if (!chat.length) {
    throw new Error(
      'Tidak ada satu pun provider AI yang terisi. Isi AI_<NAMA>_BASE_URL, ' +
        'AI_<NAMA>_API_KEY, dan AI_<NAMA>_MODEL untuk minimal satu nama di AI_PROVIDERS.',
    )
  }

  return { chat, vision }
}

/**
 * Membaca konfigurasi dari objek env yang diberikan, bukan langsung dari
 * process.env, supaya bisa diuji tanpa menyentuh lingkungan nyata.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !String(env[key] ?? '').trim())
  const namesRaw = String(env.AI_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (missing.length || !namesRaw.length) {
    throw new Error(
      `Konfigurasi kurang: ${[...(!namesRaw.length ? ['AI_PROVIDERS'] : []), ...missing].join(', ')}. ` +
        'Isi di file .env — lihat .env.example untuk daftar lengkapnya.',
    )
  }
  const ai = loadProviders(env)

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
    // chat: urutan fallback untuk pesan teks, sesuai urutan AI_PROVIDERS.
    // vision: hanya provider yang punya VISION_MODEL, urutan sama. Kalau
    // kosong, pesan bergambar memakai chain chat (model chat dianggap bisa).
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