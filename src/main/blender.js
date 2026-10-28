// Finding, downloading and running Blender in the background.
//
// Blender is free and open source (GPL). Gamesmith never opens its window:
// it runs `blender -b` with resources/blender/runner.py, which executes one
// asset script and writes a .glb, a preview image and measurements.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const PORTABLE = {
  version: '5.2.3',
  series: '5.2',
  win: {
    file: 'blender-5.2.3-windows-x64.zip',
    approxMB: 406,
    // From https://download.blender.org/release/Blender5.2/blender-5.2.3.sha256
    sha256: '723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb'
  }
}
// The official server first, then official mirrors. The file is checked against
// the pinned checksum above, so a mirror can't hand over anything else.
const SOURCES = () =>
  process.env.GAMESMITH_BLENDER_MIRROR
    ? process.env.GAMESMITH_BLENDER_MIRROR.split(',')
    : [
        // download.blender.org sits behind a "checking your browser" page that blocks
        // apps, so official mirrors come first.
        `https://mirror.clarkson.edu/blender/release/Blender${PORTABLE.series}`,
        `https://ftp.nluug.nl/pub/graphics/blender/release/Blender${PORTABLE.series}`,
        `https://download.blender.org/release/Blender${PORTABLE.series}`
      ]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gamesmith (+https://github.com/Guinnessstache/gamesmith)'
const MIN_VERSION = [4, 2]
const isWin = process.platform === 'win32'

export function versionOf(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    const m = (r.stdout || '').match(/Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/)
    return m ? { text: `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}`, major: +m[1], minor: +m[2] } : null
  } catch {
    return null
  }
}

const newEnough = (v) => v && (v.major > MIN_VERSION[0] || (v.major === MIN_VERSION[0] && v.minor >= MIN_VERSION[1]))

function candidates(userDataDir, configured) {
  const out = []
  if (configured) out.push(configured)
  if (process.env.GAMESMITH_BLENDER) out.push(process.env.GAMESMITH_BLENDER)
  const own = join(userDataDir, 'blender')
  if (fs.existsSync(own)) {
    for (const d of fs.readdirSync(own)) out.push(join(own, d, isWin ? 'blender.exe' : 'blender'))
  }
  if (isWin) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const root = join(base, 'Blender Foundation')
      if (!fs.existsSync(root)) continue
      const dirs = fs.readdirSync(root).filter((d) => /^Blender/i.test(d)).sort().reverse() // newest first
      for (const d of dirs) out.push(join(root, d, 'blender.exe'))
    }
    // Steam install
    const steam = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe')
    out.push(steam)
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Blender.app/Contents/MacOS/Blender')
  } else {
    const which = spawnSync('which', ['blender'], { encoding: 'utf8' })
    if (which.status === 0) out.push(which.stdout.trim())
  }
  return [...new Set(out)]
}

/** The best Blender on this computer, or a reason none is usable. */
export function find(userDataDir, configured) {
  let tooOld = null
  for (const exe of candidates(userDataDir, configured)) {
    if (!fs.existsSync(exe)) continue
    const v = versionOf(exe)
    if (!v) continue
    if (newEnough(v)) return { found: true, path: exe, version: v.text }
    tooOld ||= { path: exe, version: v.text }
  }
  return {
    found: false,
    tooOld,
    canDownload: isWin,
    download: isWin ? { version: PORTABLE.version, approxMB: PORTABLE.win.approxMB } : null
  }
}

/**
 * Download the official portable Blender for Windows, verify it, and unpack it.
 * fetchImpl: Electron's net.fetch in the app (uses Windows' proxy and certificate
 * settings, like a browser); Node's fetch in tests.
 */
export async function download(userDataDir, { onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  if (!isWin && !process.env.GAMESMITH_BLENDER_MIRROR) throw new Error('Automatic download is only set up for Windows. Install Blender from blender.org, then click Check again.')
  const { file } = PORTABLE.win
  const expected = process.env.GAMESMITH_BLENDER_SHA256 || PORTABLE.win.sha256
  const dir = join(userDataDir, 'blender')
  fs.mkdirSync(dir, { recursive: true })
  const zipPath = join(dir, file)
  const tmp = zipPath + '.part'

  const problems = []
  let got = false
  for (const base of SOURCES()) {
    const host = new URL(base).host
    try {
      const res = await fetchImpl(`${base}/${file}`, { signal, headers: { 'User-Agent': UA } })
      if (!res.ok) {
        problems.push(`${host}: HTTP ${res.status}`)
        continue
      }
      const total = Number(res.headers.get('content-length')) || PORTABLE.win.approxMB * 1e6
      const hash = createHash('sha256')
      let done = 0
      let lastReport = 0
      const body = Readable.fromWeb(res.body)
      body.on('data', (chunk) => {
        hash.update(chunk)
        done += chunk.length
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now()
          onProgress({ phase: 'Downloading', done, total, host })
        }
      })
      await pipeline(body, fs.createWriteStream(tmp))
      if (hash.digest('hex') !== expected) {
        fs.rmSync(tmp, { force: true })
        problems.push(`${host}: file didn't match Blender's checksum`)
        continue
      }
      got = true
      break
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      if (signal?.aborted) throw new Error('Download cancelled.')
      problems.push(`${host}: ${e.cause?.code || e.cause?.message || e.message}`)
    }
  }
  if (!got) {
    throw new Error(
      `Couldn't download Blender (${problems.join('; ')}). You can download "${file}" or the installer from blender.org yourself, then click "I have Blender: find it…".`
    )
  }
  fs.renameSync(tmp, zipPath)

  onProgress({ phase: 'Unpacking', done: 1, total: 1 })
  // Windows 10+ ships bsdtar (tar.exe), which unpacks .zip files without loading them into memory.
  const r = isWin ? spawnSync('tar.exe', ['-xf', zipPath, '-C', dir], { windowsHide: true, encoding: 'utf8' }) : spawnSync('unzip', ['-q', '-o', zipPath, '-d', dir], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`Couldn't unpack Blender: ${r.stderr || r.error?.message}`)
  fs.rmSync(zipPath, { force: true })
  if (!isWin) for (const d of fs.readdirSync(dir)) fs.existsSync(join(dir, d, 'blender')) && fs.chmodSync(join(dir, d, 'blender'), 0o755)
  const found = find(userDataDir)
  if (!found.found) throw new Error('Blender was unpacked but could not be started.')
  onProgress({ phase: 'Ready', done: 1, total: 1 })
  return found
}

/**
 * Run an asset script. Returns { ok, stats } or { ok:false, error, where, log }.
 * runner.py prints one line starting with GAMESMITH_RESULT.
 */
export function run({ blender, runner, script, outGlb, outPng = '-', size = 384, timeoutMs = 180000, signal, motionsDir }) {
  return new Promise((resolve) => {
    fs.mkdirSync(dirname(outGlb), { recursive: true })
    const args = ['-b', '--factory-startup', '--python-exit-code', '3', '--python', runner, '--', script, outGlb, outPng, String(size)]
    const env = { ...process.env, ...(motionsDir ? { GAMESMITH_MOTIONS: motionsDir } : {}) }
    const child = spawn(blender, args, { windowsHide: true, env })
    let out = ''
    const take = (d) => {
      out += d.toString()
      if (out.length > 400000) out = out.slice(-200000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const kill = () => {
      try {
        if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish({ ok: false, error: `Blender took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. The script may loop forever or build far too much geometry.` })
    }, timeoutMs)
    const onAbort = () => {
      kill()
      finish({ ok: false, error: 'Stopped.' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let settled = false
    function finish(r) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, log: out.split('\n').filter((l) => l.trim() && !l.startsWith('GAMESMITH_RESULT')).slice(-30).join('\n') })
    }
    child.on('error', (e) => finish({ ok: false, error: `Couldn't start Blender: ${e.message}` }))
    child.on('close', () => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('GAMESMITH_RESULT '))
      if (!line) return finish({ ok: false, error: 'Blender exited without a result. It may have crashed; see the log.' })
      try {
        finish(JSON.parse(line.slice('GAMESMITH_RESULT '.length)))
      } catch {
        finish({ ok: false, error: 'Blender returned an unreadable result.' })
      }
    })
  })
}
