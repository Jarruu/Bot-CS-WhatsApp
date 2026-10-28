import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, loadKnowledge } from '../config.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FULL = {
  AI_PROVIDERS: 'zai,cloudflare',
  AI_ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
  AI_ZAI_API_KEY: 'kz',
  AI_ZAI_MODEL: 'glm-4.7-flash',
  AI_ZAI_VISION_MODEL: 'glm-4.6v-flash',
  AI_CLOUDFLARE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1',
  AI_CLOUDFLARE_API_KEY: 'kc',
  AI_CLOUDFLARE_MODEL: '@cf/meta/llama-3.1-8b-instruct',
  BUSINESS_NAME: 'Toko', OWNER_NUMBER: '628123',
}

test('env kosong menyebut semua variabel yang kurang sekaligus', () => {
  assert.throws(() => loadConfig({}), /AI_PROVIDERS[\s\S]*BUSINESS_NAME[\s\S]*OWNER_NUMBER/)
})

test('provider diparse sesuai urutan AI_PROVIDERS', () => {
  const c = loadConfig(FULL)
  assert.deepEqual(
    c.ai.chat.map(p => [p.name, p.model]),
    [['zai', 'glm-4.7-flash'], ['cloudflare', '@cf/meta/llama-3.1-8b-instruct']],
  )
})

test('provider yang punya VISION_MODEL membentuk chain vision sendiri', () => {
  const c = loadConfig(FULL)
  assert.deepEqual(
    c.ai.vision.map(p => [p.name, p.model]),
    [['zai', 'glm-4.6v-flash']],
    'cloudflare tidak set VISION_MODEL, jadi tidak ikut chain vision',
  )
  // Chain vision tetap membawa baseUrl dan apiKey dari provider-nya sendiri.
  assert.equal(c.ai.vision[0].baseUrl, 'https://api.z.ai/api/paas/v4')
  assert.equal(c.ai.vision[0].apiKey, 'kz')
})

test('slashing ganda di BASE_URL dibersihkan', () => {
  const c = loadConfig({ ...FULL, AI_ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4///' })
  assert.equal(c.ai.chat[0].baseUrl, 'https://api.z.ai/api/paas/v4')
})

test('AI_PROVIDERS kosong ditolak dengan penjelasan urutan fallback', () => {
  assert.throws(() => loadConfig({ ...FULL, AI_PROVIDERS: '' }), /AI_PROVIDERS/)
  assert.throws(() => loadConfig({ ...FULL, AI_PROVIDERS: ' , ' }), /AI_PROVIDERS/)
})

test('nama provider dengan karakter aneh ditolak sebelum dicari env-nya', () => {
  assert.throws(() => loadConfig({ ...FULL, AI_PROVIDERS: 'zai, te offline' }), /te offline/)
})

test('provider tanpa salah satu variabel wajib ditolak, semua kekurangan disebut sekaligus', () => {
  assert.throws(
    () => loadConfig({ ...FULL, AI_ZAI_BASE_URL: '', AI_ZAI_MODEL: '' }),
    /provider "zai" kurang: AI_ZAI_BASE_URL, AI_ZAI_MODEL/,
  )
})

test('provider tanpa API key dilewati, tidak menolak start', () => {
  // Empat provider di AI_PROVIDERS dengan tiga API key kosong adalah setup
  // normal: cadangan hanya dipakai kalau kuncinya memang ada.
  const c = loadConfig({ ...FULL, AI_PROVIDERS: 'zai,cloudflare,groq,openrouter' })
  assert.deepEqual(c.ai.chat.map(p => p.name), ['zai', 'cloudflare'])
})

test('semua provider tanpa API key ditolak, bukan bot diam tanpa AI', () => {
  const kosong = { BUSINESS_NAME: 'Toko', OWNER_NUMBER: '628123', AI_PROVIDERS: 'google,groq' }
  assert.throws(() => loadConfig(kosong), /Tidak ada satu pun provider/)
})

test('provider yang API key-nya terisi tapi modelnya kosong tetap ditolak', () => {
  assert.throws(
    () => loadConfig({ ...FULL, AI_PROVIDERS: 'zai,groq', AI_GROQ_API_KEY: 'kg' }),
    /provider "groq" kurang: AI_GROQ_BASE_URL, AI_GROQ_MODEL/,
  )
})

test('default terisi benar', () => {
  const c = loadConfig(FULL)
  assert.equal(c.access.mode, 'PUBLIC')
  assert.deepEqual(c.access.whitelist, [])
})

test('batas dan debounce punya default yang benar', () => {
  const { limits } = loadConfig(FULL)
  assert.deepEqual(limits, {
    debounceSec: 8, rateInMax: 20, rateInWindowSec: 60, rateInCooldownMin: 5,
    rateOutMax: 15, rateOutWindowSec: 60, chunkDelaySec: 1, maxImageMb: 5,
  })
})

test('batas bisa ditimpa lewat env', () => {
  const { limits } = loadConfig({ ...FULL, RATE_IN_MAX: '50', DEBOUNCE_SEC: '5' })
  assert.equal(limits.rateInMax, 50)
  assert.equal(limits.debounceSec, 5)
})

test('whitelist dipecah dan dibersihkan', () => {
  const c = loadConfig({ ...FULL, ACCESS_MODE: 'WHITELIST', WHITELIST: ' 6281 , 6282 ,' })
  assert.deepEqual(c.access.whitelist, ['6281', '6282'])
})

test('knowledge.md kosong atau hilang ditolak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'))
  const p = join(dir, 'knowledge.md')
  writeFileSync(p, '   \n\n  ')
  assert.throws(() => loadKnowledge(p), /kosong/)
  assert.throws(() => loadKnowledge(join(tmpdir(), 'tidak-ada-xyz.md')), /tidak ditemukan/)
})

test('ACCESS_MODE salah tulis ditolak, bukan diam-diam jadi PUBLIC', () => {
  // Bot yang dikira terkunci tapi sebenarnya terbuka untuk semua orang itu
  // kegagalan yang tidak akan pernah disadari pemiliknya.
  for (const salah of ['whitelist', 'Whitelist', 'WHITE_LIST', 'publik', 'PUBLIK']) {
    assert.throws(() => loadConfig({ ...FULL, ACCESS_MODE: salah }), /ACCESS_MODE/, salah)
  }
  assert.equal(loadConfig(FULL).access.mode, 'PUBLIC')
  assert.equal(loadConfig({ ...FULL, ACCESS_MODE: 'WHITELIST' }).access.mode, 'WHITELIST')
})

test('nomor dibersihkan dari spasi, plus, dan tanda hubung', () => {
  // Nomor bertanda plus bikin JID tidak sah, dan eskalasi yang gagal tidak
  // akan pernah sampai ke pemilik — satu-satunya orang yang bisa menyadarinya.
  const c = loadConfig({
    ...FULL,
    OWNER_NUMBER: '+62 812-3456-7890',
    WHITELIST: ' +62 811 , 62812 ',
  })
  assert.equal(c.ownerNumber, '6281234567890')
  assert.deepEqual(c.access.whitelist, ['62811', '62812'])
})

test('nomor yang tidak menyisakan satu digit pun ditolak', () => {
  assert.throws(() => loadConfig({ ...FULL, OWNER_NUMBER: '+-- ' }), /OWNER_NUMBER/)
})

test('batas nol atau negatif ditolak, bukan bikin bot berputar tanpa henti', () => {
  // Nilai 0 bikin send gate menunggu selamanya sambil membakar CPU: tidak ada
  // timestamp yang pernah masuk, jadi tidak ada yang bisa kedaluwarsa. Bot
  // kelihatan hidup tapi tidak pernah membalas siapa pun.
  for (const key of ['RATE_OUT_MAX', 'RATE_IN_MAX', 'RATE_OUT_WINDOW_SEC', 'RATE_IN_WINDOW_SEC']) {
    assert.throws(() => loadConfig({ ...FULL, [key]: '0' }), new RegExp(key), key)
    assert.throws(() => loadConfig({ ...FULL, [key]: '-1' }), new RegExp(key), key)
  }
  assert.equal(loadConfig({ ...FULL, RATE_OUT_MAX: '1' }).limits.rateOutMax, 1)
})