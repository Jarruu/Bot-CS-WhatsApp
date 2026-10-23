import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, loadKnowledge } from '../config.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FULL = {
  AI_API_KEY: 'k', AI_MODEL: 'm',
  BUSINESS_NAME: 'Toko', OWNER_NUMBER: '628123',
}

test('env kosong menyebut semua variabel yang kurang sekaligus', () => {
  assert.throws(() => loadConfig({}), /AI_API_KEY[\s\S]*AI_MODEL[\s\S]*BUSINESS_NAME[\s\S]*OWNER_NUMBER/)
})

test('default terisi benar', () => {
  const c = loadConfig(FULL)
  assert.equal(c.aiBaseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(c.aiVisionModel, 'm', 'kosong berarti ikut AI_MODEL')
  assert.deepEqual(c.hours, { open: 8, close: 23 })
  assert.equal(c.offlineNotice, true)
  assert.equal(c.access.mode, 'PUBLIC')
  assert.deepEqual(c.access.whitelist, [])
})

test('batas dan debounce punya default yang benar', () => {
  const { limits } = loadConfig(FULL)
  assert.deepEqual(limits, {
    debounceSec: 3, rateInMax: 20, rateInWindowSec: 60, rateInCooldownMin: 5,
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