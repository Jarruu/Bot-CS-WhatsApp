import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qrPageUrl } from '../server.js'

test('link QR memakai PUBLIC_URL di host selain Railway', () => {
  // Railway mengisi RAILWAY_PUBLIC_DOMAIN, host lain tidak. Tanpa PUBLIC_URL,
  // link yang tercetak di log menunjuk ke localhost dan tidak bisa dibuka
  // dari HP — login pertama gagal tanpa pesan error.
  const asli = { ...process.env }
  try {
    delete process.env.RAILWAY_PUBLIC_DOMAIN
    process.env.PUBLIC_URL = 'https://bot.contoh.com/'
    assert.match(qrPageUrl(3000), /^https:\/\/bot\.contoh\.com\/qr\?key=/)

    delete process.env.PUBLIC_URL
    process.env.RAILWAY_PUBLIC_DOMAIN = 'railway.contoh.com'
    assert.match(qrPageUrl(3000), /^https:\/\/railway\.contoh\.com\/qr\?key=/)
  } finally {
    process.env = asli
  }
})
