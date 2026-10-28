// Updater test (real electron-updater, inside Electron) against a local update server:
// finds a newer version, downloads it, verifies the checksum, and rejects a corrupted download.
//   npm run build && npx electron scripts/test-updater.cjs   (Linux: xvfb-run -a ... --no-sandbox)
const { app } = require('electron')
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gs-upd-')))
const good = crypto.randomBytes(300000)
const other = crypto.randomBytes(300000) // a different release, served damaged
const file = () => (corrupt ? other : good)
let corrupt = false
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('base64')
const yml = () => `version: ${corrupt ? '0.9.1' : '0.9.0'}
files:
  - url: Gamesmith-Setup.exe
    sha512: ${sha512(file())}
    size: ${file().length}
path: Gamesmith-Setup.exe
sha512: ${sha512(file())}
releaseDate: '2026-10-28T12:00:00.000Z'
releaseNotes: '<h2>New</h2><ul><li>Motion capture</li><li>Updates</li></ul>'
`
const server = http.createServer((req, res) => {
  if (/^\/latest(-[a-z]+)?\.yml/.test(req.url)) return res.end(yml()) // latest.yml on Windows, latest-linux.yml here
  if (req.url.startsWith('/Gamesmith-Setup.exe')) {
    const body = corrupt ? Buffer.from(other).fill(7, 0, 10) : good
    res.writeHead(200, { 'Content-Length': body.length })
    return res.end(body)
  }
  res.writeHead(404).end()
})

let failures = 0
const check = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) failures++
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { Updater } = await import(path.join(__dirname, '..', 'src', 'main', 'updater.js'))
  try {
    const src = new Updater({ packaged: false, version: '0.8.0', feedUrl: '' })
    check(src.status.state === 'source' && (await src.check()).state === 'source', 'running from source: no update checks')

    const url = `http://127.0.0.1:${server.address().port}`
    const u = new Updater({ packaged: false, version: '0.8.0', feedUrl: url })
    const seen = []
    u.on('status', (s) => seen.push(s.state))
    const st = await u.check()
    check(st.state === 'available' && st.latest === '0.9.0', `newer version found (${st.latest})`)
    check(/Motion capture/.test(st.notes) && !/</.test(st.notes), 'release notes shown as plain text')
    await u.download()
    await new Promise((r) => setTimeout(r, 300))
    check(u.status.state === 'ready' && seen.includes('downloading'), 'downloaded with progress and verified')

    const same = new Updater({ packaged: false, version: '0.9.0', feedUrl: url })
    check((await same.check()).state === 'current', 'up to date when versions match')

    corrupt = true
    const bad = new Updater({ packaged: false, version: '0.8.0', feedUrl: url })
    await bad.check()
    await bad.download().catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    check(bad.status.state === 'error' && /checksum|sha512/i.test(bad.status.error), `corrupted download refused ("${bad.status.error}")`)

    server.close()
    const off = new Updater({ packaged: false, version: '0.8.0', feedUrl: 'http://127.0.0.1:9' })
    await off.check()
    check(off.status.state === 'error' && off.status.error.length < 200, `offline: short message ("${off.status.error}")`)
  } catch (e) {
    console.error('UPDATER TEST ERROR', e)
    failures++
  }
  console.log(failures ? `${failures} updater check(s) failed` : 'PASS  updater: check, notes, download + verify, up to date, corrupt download refused, offline')
  app.exit(failures ? 1 : 0)
})
