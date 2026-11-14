// Realistic people: human() in a model script builds on MPFB (the MakeHuman add-on for Blender, GPL)
// and the MakeHuman system assets (skins, hair, eyes, clothes; CC0). Neither ships with Gamesmith.
// The first build that calls human() downloads both into Gamesmith's own folder, laid out as a private
// Blender extensions folder, and every Blender run is pointed at it (blender.setExtensionsDir).
// Nothing is installed into the user's own Blender.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { join, dirname, posix } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'

const MPFB_COMMIT = '9de0707fdc88438d7c53a1a2ac7937d9221e2431' // MPFB 2.0.18
export const SOURCES = {
  mpfb: {
    label: 'the MakeHuman add-on',
    version: MPFB_COMMIT,
    urls: [`https://github.com/makehumancommunity/mpfb2/archive/${MPFB_COMMIT}.zip`],
    // The archive holds the whole repository; only the add-on itself is kept.
    keep: /^[^/]+\/src\/mpfb\/(.+)$/,
    into: ['user_default', 'mpfb'],
    approxMB: 60
  },
  assets: {
    label: 'skins, hair and clothes',
    version: 'b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107',
    sha256: 'b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107',
    urls: [
      'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip',
      'https://files2.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip'
    ],
    keep: /^(.+)$/,
    into: ['.user', 'user_default', 'mpfb', 'data'],
    approxMB: 268
  }
}
export const NAME = 'Realistic people'

let root = null
/** dir: where the pack lives (a folder under the app's data folder). */
export function configure(dir) {
  root = dir
}
/** The private Blender extensions folder (it exists once anything is installed). */
export const extensionsDir = () => (root ? join(root, 'extensions') : null)
const marker = () => join(root, 'installed.json')

/** Does this model script make a realistic person? */
export const usedBy = (script) => /(^|[^\w.])human\s*\(/.test(String(script || '').replace(/#.*$/gm, ''))

export function status(sources = SOURCES) {
  if (!root) return { installed: false }
  try {
    const m = JSON.parse(fs.readFileSync(marker(), 'utf8'))
    const current = Object.entries(sources).every(([k, s]) => m[k] === s.version)
    return { installed: current && fs.existsSync(join(extensionsDir(), 'user_default', 'mpfb', '__init__.py')), dir: root }
  } catch {
    return { installed: false, dir: root }
  }
}

async function download(src, dest, { fetchFn, signal, onBytes }) {
  const problems = []
  for (const url of src.urls) {
    try {
      const res = await fetchFn(url, { signal, headers: { 'User-Agent': 'Gamesmith' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || src.approxMB * 1e6
      const hash = crypto.createHash('sha256')
      const fd = fs.openSync(dest, 'w')
      let done = 0
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done: end, value } = await reader.read()
          if (end) break
          fs.writeSync(fd, value)
          hash.update(value)
          done += value.length
          onBytes(done, Math.max(total, done))
        }
      } finally {
        fs.closeSync(fd)
      }
      if (src.sha256 && hash.digest('hex') !== src.sha256) throw new Error('the file arrived damaged (checksum mismatch)')
      return
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped.')
      problems.push(`${new URL(url).host}: ${e.message}`)
    }
  }
  throw new Error(`Couldn't download ${src.label} (${problems.join('; ')}). Check the internet connection and build again.`)
}

/** Unpack a zip from disk a piece at a time (the asset pack is far too big to hold in memory twice). */
async function unpack(zipPath, outDir, keep, { signal, onFile }) {
  let failure = null
  let files = 0
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file) => {
    const m = file.name.endsWith('/') ? null : keep.exec(file.name)
    const rel = m && posix.normalize(m[1])
    if (!rel || rel.startsWith('..') || posix.isAbsolute(rel) || rel.includes('__MACOSX')) return // (also the zip-slip guard)
    const dest = join(outDir, ...rel.split('/'))
    fs.mkdirSync(dirname(dest), { recursive: true })
    const fd = fs.openSync(dest, 'w')
    file.ondata = (err, chunk, final) => {
      if (err) failure ||= err
      else if (chunk?.length) fs.writeSync(fd, chunk)
      if (err || final) {
        fs.closeSync(fd)
        files++
        onFile(files)
      }
    }
    file.start()
  }
  for await (const chunk of fs.createReadStream(zipPath, { highWaterMark: 1 << 20 })) {
    if (signal?.aborted) throw new Error('Stopped.')
    unzip.push(chunk, false)
    if (failure) throw failure
  }
  unzip.push(new Uint8Array(0), true)
  if (failure) throw failure
  if (!files) throw new Error('the download had none of the expected files')
  return files
}

let running = null
/**
 * Make sure the pack is installed; downloads it if not. Calls made while one is running share it.
 * opts: { fetchFn, signal, onProgress({ phase, name, done, total, unit }), sources (tests) }
 */
export function ensure(opts = {}) {
  if (!root) return Promise.reject(new Error('The realistic people pack has no folder to install into.'))
  if (status(opts.sources || SOURCES).installed) return Promise.resolve(status(opts.sources || SOURCES))
  running ||= install(opts).finally(() => (running = null))
  return running
}

async function install({ fetchFn = fetch, signal, onProgress = () => {}, sources = SOURCES } = {}) {
  const tmp = join(root, 'download')
  const staging = join(root, 'extensions.new')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const list = Object.entries(sources)
    const totalMB = list.reduce((n, [, s]) => n + s.approxMB, 0)
    let before = 0
    for (const [key, src] of list) {
      const zip = join(tmp, `${key}.zip`)
      let last = 0
      await download(src, zip, {
        fetchFn,
        signal,
        onBytes: (done, total) => {
          const mb = Math.round(before + (done / total) * src.approxMB)
          if (mb !== last) onProgress({ phase: 'Downloading', name: NAME, done: (last = mb), total: totalMB, unit: 'MB' })
        }
      })
      before += src.approxMB
      onProgress({ phase: 'Unpacking', name: NAME, done: 0, total: 0, unit: 'files' })
      await unpack(zip, join(staging, ...src.into), src.keep, {
        signal,
        onFile: (n) => n % 200 === 0 && onProgress({ phase: 'Unpacking', name: NAME, done: n, total: 0, unit: 'files' })
      })
      fs.rmSync(zip, { force: true })
    }
    if (!fs.existsSync(join(staging, 'user_default', 'mpfb', '__init__.py'))) throw new Error('The MakeHuman add-on download was incomplete.')
    // Swap the finished folder in, so a stopped or failed download never leaves half a pack behind.
    fs.rmSync(extensionsDir(), { recursive: true, force: true })
    fs.renameSync(staging, extensionsDir())
    fs.writeFileSync(marker(), JSON.stringify(Object.fromEntries(list.map(([k, s]) => [k, s.version])), null, 2))
    return status(sources)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** One line for the chat while the pack downloads. */
export const progressText = (ev) =>
  ev.phase === 'Downloading' ? `Downloading ${NAME.toLowerCase()} (first time only): ${ev.done} of ${ev.total} MB` : `Unpacking ${NAME.toLowerCase()}…`
