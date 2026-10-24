// Halaman QR untuk login WhatsApp dari browser. QR ASCII di log Railway
// tidak bisa dipindai dengan andal, jadi halaman ini mengirim QR sebagai
// PNG asli — satu-satunya hal di proyek ini yang butuh HTTP server.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import QRCode from 'qrcode'

// Siapa pun yang bisa membuka halaman ini bisa menautkan perangkatnya ke
// akun WhatsApp bot, jadi URL-nya selalu bertoken. Kalau QR_TOKEN tidak
// diisi, token dibuat acak tiap boot dan hanya muncul di log.
export const qrToken = process.env.QR_TOKEN?.trim() || randomBytes(9).toString('hex')

/** URL yang perlu dibuka di HP, lengkap dengan tokennya. */
export function qrPageUrl(port) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
  return `${domain ? `https://${domain}` : `http://localhost:${port}`}/qr?key=${qrToken}`
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function page({ businessName, key }) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR WhatsApp — ${esc(businessName)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 40px;
    background: #fff; color: #111;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 420px; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .status { font-weight: 600; margin: 0 0 20px; }
  body[data-status="connected"] .status { color: #128c4a; }
  body[data-status="logged_out"] .status, body[data-status="disconnected"] .status { color: #b3261e; }
  #qrbox { background: #fff; padding: 12px; border: 1px solid #e5e5e5; border-radius: 12px; }
  #qr { width: 100%; height: auto; display: block; image-rendering: pixelated; }
  #hint { text-align: left; margin: 20px 0 0; }
  #hint p { margin: 0 0 10px; }
  .muted { color: #666; font-size: 0.9rem; }
  button {
    margin-top: 20px; padding: 12px 18px; font: inherit; font-weight: 600;
    color: #111; background: #f2f2f2; border: 1px solid #ddd; border-radius: 10px;
  }
</style>
</head>
<body data-status="starting">
<main>
  <h1>${esc(businessName)}</h1>
  <p class="status" id="status">Memuat…</p>

  <div id="qrbox" hidden><img id="qr" alt="QR WhatsApp" width="640" height="640"></div>

  <div id="hint" hidden>
    <p>Buka <b>WhatsApp → Pengaturan → Perangkat tertaut → Tautkan perangkat</b>,
       lalu arahkan kamera HP ke QR di atas.</p>
    <p class="muted">QR berganti sendiri tiap beberapa detik dan halaman ini ikut
       memperbarui. Tidak perlu restart deployment.</p>
  </div>

  <button onclick="location.reload()">Muat ulang</button>
</main>
<script>
  const KEY = ${JSON.stringify(key)}
  const TEXT = {
    starting: 'Menyiapkan bot…',
    waiting: 'Scan QR di bawah',
    connected: 'Connected — bot aktif',
    disconnected: 'Disconnected — menunggu QR baru…',
    logged_out: 'Sesi tidak berlaku lagi',
  }
  const el = (id) => document.getElementById(id)
  let shownAt = null

  async function tick() {
    let s
    try {
      s = await (await fetch('/qr/status?key=' + encodeURIComponent(KEY))).json()
    } catch {
      return // jaringan sedang putus; tick berikutnya mencoba lagi
    }
    document.body.dataset.status = s.status
    el('status').textContent = TEXT[s.status] ?? s.status

    const show = s.status === 'waiting' && s.hasQr
    el('qrbox').hidden = !show
    el('hint').hidden = !show
    if (show && shownAt !== s.qrAt) {
      shownAt = s.qrAt
      el('qr').src = '/qr.png?key=' + encodeURIComponent(KEY) + '&t=' + s.qrAt
    }
  }

  tick()
  setInterval(tick, 5000)
</script>
</body>
</html>`
}

/**
 * `getState()` mengembalikan { status, qr, qrAt } — lihat index.js.
 * Status: starting | waiting | connected | disconnected | logged_out.
 */
export function createQrServer({ getState, businessName = '', token = qrToken }) {
  // Polling tiap 2 detik tidak perlu menggencode ulang QR yang sama.
  let cachedFor = null
  let cachedPng = null

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }

    // Tanpa token: dipakai Railway untuk healthcheck, tidak membocorkan apa pun.
    if (url.pathname === '/health') return send(200, 'text/plain; charset=utf-8', 'ok')

    if (url.searchParams.get('key') !== token) {
      return send(401, 'text/plain; charset=utf-8',
        'Akses ditolak. Buka URL lengkap dari log server — yang ada ?key=... di belakangnya.\n')
    }

    const { status, qr, qrAt } = getState()

    if (url.pathname === '/') return res.writeHead(302, { location: `/qr?key=${token}` }).end()

    if (url.pathname === '/qr') {
      return send(200, 'text/html; charset=utf-8', page({ businessName, key: token }))
    }

    if (url.pathname === '/qr/status') {
      return send(200, 'application/json; charset=utf-8',
        JSON.stringify({ status, hasQr: Boolean(qr), qrAt, businessName }))
    }

    if (url.pathname === '/qr.png') {
      if (!qr) return send(404, 'text/plain; charset=utf-8', 'Belum ada QR.\n')
      if (qr !== cachedFor) {
        cachedPng = await QRCode.toBuffer(qr, { type: 'png', width: 640, margin: 2 })
        cachedFor = qr
      }
      return send(200, 'image/png', cachedPng)
    }

    send(404, 'text/plain; charset=utf-8', 'Tidak ada.\n')
  })
}
