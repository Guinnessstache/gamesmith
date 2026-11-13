// Kits: model packs (Quaternius, Kenney, ...) the modeling AI builds with. Gamesmith has a built-in
// catalog of free (CC0) packs: one click downloads a pack's models, and Gamesmith converts each to
// .glb with Blender, measures it and makes a thumbnail. (A pack's .zip can also be dropped in.) Kits
// live in the asset library's kits/ folder (not backed up to GitHub: they're re-downloadable, and
// models built from them carry their own copy of the geometry).
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { join, basename, extname, dirname, posix } from 'node:path'
import { unzipSync } from 'fflate'
import * as blender from './blender.js'

let rootFn = () => null
/** fn: () => the kits folder (it follows the asset library if that moves). */
export function configure(fn) {
  rootFn = fn
}
export const kitsDir = () => rootFn()

const MODEL_RANK = ['.glb', '.gltf', '.fbx', '.obj'] // best first
const KEEP = /\.(glb|gltf|bin|fbx|obj|mtl|png|jpe?g|tga|bmp|webp|txt|md)$/i
const MAX_BYTES = 600e6

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.zip$/i, '')
    .replace(/^kenney[_ -]*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'kit'

/** "kenney_castle-kit.zip" -> "Castle Kit" */
export const prettyName = (zipName) =>
  zipName
    .replace(/\.zip$/i, '')
    .replace(/^kenney[_ -]*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Kit'

const kitFile = (id) => join(kitsDir(), id, 'kit.json')

export function listKits() {
  const root = kitsDir()
  if (!root || !fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(kitFile(d)))
    .map((d) => {
      const k = JSON.parse(fs.readFileSync(kitFile(d), 'utf8'))
      return { id: k.id, name: k.name, catalogId: k.catalogId || null, source: k.source, license: k.license, parts: k.parts.length, added: k.added }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readKit(id) {
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(kitFile(id))) throw new Error(`No kit "${id}"`)
  return JSON.parse(fs.readFileSync(kitFile(id), 'utf8'))
}

export function thumbnail(id, part) {
  const f = join(kitsDir(), id, 'thumbs', `${part}.png`)
  return fs.existsSync(f) ? fs.readFileSync(f) : null
}

export function removeKit(id) {
  readKit(id)
  fs.rmSync(join(kitsDir(), id), { recursive: true, force: true })
}

/** Which model files in a pack to use: one format only (packs often ship the same models as GLB, FBX and OBJ). */
export function pickModels(names) {
  const models = names.filter((n) => MODEL_RANK.includes(extname(n).toLowerCase()) && !/(^|\/)(previews?|__macosx)\//i.test(n))
  for (const ext of MODEL_RANK) {
    const set = models.filter((n) => extname(n).toLowerCase() === ext)
    if (set.length) return { ext, files: set }
  }
  return { ext: null, files: [] }
}

export function detectSource(zipName, names, licenseText) {
  const all = `${zipName} ${names.slice(0, 50).join(' ')} ${licenseText}`
  if (/kenney/i.test(all)) return { source: 'Kenney', url: 'https://kenney.nl' }
  if (/quaternius/i.test(all)) return { source: 'Quaternius', url: 'https://quaternius.com' }
  return { source: 'Imported pack', url: '' }
}

/**
 * Import a pack (.zip). opts: { blenderPath, onProgress({ phase, done, total }) }.
 * Returns the kit (with any parts that failed).
 */
export async function importKit(zipPath, { blenderPath, onProgress = () => {}, signal } = {}) {
  const root = kitsDir()
  if (!root) throw new Error('Kits are not set up yet.')
  const zipName = basename(zipPath)
  onProgress({ phase: 'Unpacking', done: 0, total: 1 })
  const entries = unzipSync(fs.readFileSync(zipPath), { filter: (f) => !f.name.endsWith('/') && !f.name.includes('__MACOSX') && !/(^|\/)\./.test(f.name) && KEEP.test(f.name) })
  const names = Object.keys(entries)
  const { ext, files } = pickModels(names)
  if (!files.length) throw new Error(`${zipName} has no models Gamesmith can use (GLB, glTF, FBX or OBJ).`)
  const total = names.reduce((n, k) => n + entries[k].length, 0)
  if (total > MAX_BYTES) throw new Error(`${zipName} is ${Math.round(total / 1e6)} MB unpacked; the limit is ${MAX_BYTES / 1e6} MB.`)

  const licenseName = names.find((n) => /licen[cs]e/i.test(basename(n)))
  const licenseText = licenseName ? Buffer.from(entries[licenseName]).toString('utf8').slice(0, 4000) : ''
  const cc0 = /CC0|creative commons zero|public domain|publicdomain\/zero/i.test(licenseText)
  const { source, url } = detectSource(zipName, names, licenseText)
  // Kenney and Quaternius packs are CC0 even when the zip has no license file.
  const license = cc0 || (!licenseText && (source === 'Kenney' || source === 'Quaternius')) ? 'CC0' : licenseText ? 'See the license in the pack' : 'Unknown: check where you got it'

  let id = slug(zipName)
  for (let i = 2; fs.existsSync(join(root, id)); i++) id = `${slug(zipName)}-${i}`
  const dir = join(root, id)
  const srcDir = join(dir, 'source')
  // Unpack what the chosen models need (their folders: .bin files, textures).
  const keepDirs = new Set(files.map((f) => posix.dirname(f)))
  for (const n of names) {
    const rel = posix.normalize(n)
    if (rel.startsWith('..') || posix.isAbsolute(rel)) continue // zip-slip guard
    const inModelDir = [...keepDirs].some((d) => rel === d || rel.startsWith(d === '.' ? '' : d + '/'))
    const isTexture = /\.(png|jpe?g|tga|bmp|webp)$/i.test(rel) && /textures?\//i.test(rel)
    if (!inModelDir && !isTexture && rel !== licenseName) continue
    const out = join(srcDir, rel)
    fs.mkdirSync(dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(entries[n]))
  }

  return convert({ id, dir, srcDir, files, ext, name: prettyName(zipName), source, url, license, licenseText, label: zipName, blenderPath, onProgress, signal })
}

/** Convert the model files in srcDir into the kit's parts and write kit.json. */
async function convert({ id, dir, srcDir, files, ext, name, source, url, license, licenseText = '', label, catalogId, blenderPath, onProgress, signal }) {
  // Part names from file names, unique within the kit.
  const used = new Set()
  const jobs = files.map((f) => {
    let name = slug(basename(f, extname(f))) || 'part'
    for (let i = 2; used.has(name); i++) name = `${slug(basename(f, extname(f)))}-${i}`
    used.add(name)
    return { name, file: f, src: join(srcDir, f), out: join(dir, 'parts', `${name}.glb`), thumb: join(dir, 'thumbs', `${name}.png`) }
  })
  const jobsFile = join(os.tmpdir(), `gamesmith-kit-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(jobsFile, JSON.stringify({ parts: jobs.map(({ src, out, thumb }) => ({ src, out, thumb })) }))
  onProgress({ phase: 'Converting', done: 0, total: jobs.length })
  const py = join(dirname(blenderRunnerPath()), 'kit_import.py')
  const r = await blender.runPython({
    blender: blenderPath,
    py,
    args: [jobsFile],
    timeoutMs: 60000 + jobs.length * 8000,
    signal,
    onProgress: ({ done, total: t }) => onProgress({ phase: 'Converting', done, total: t })
  })
  fs.rmSync(jobsFile, { force: true })
  if (!r.ok) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`Blender couldn't import the pack: ${r.error}`)
  }
  const parts = []
  const failed = []
  r.parts.forEach((p, i) => {
    const j = jobs[i]
    if (p.ok) parts.push({ name: j.name, file: j.file, size: p.size, min: p.min, triangles: p.triangles, rigged: p.rigged, animations: p.animations })
    else failed.push({ name: j.name, file: j.file, error: p.error })
  })
  if (!parts.length) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`None of the models in ${label} could be imported (${failed[0]?.error || 'unknown error'}).`)
  }
  fs.rmSync(srcDir, { recursive: true, force: true }) // parts/ has everything now
  const kit = {
    id,
    name,
    ...(catalogId ? { catalogId } : {}),
    source,
    url,
    license,
    licenseText: licenseText.slice(0, 1500),
    format: ext,
    added: new Date().toISOString(),
    parts,
    failed
  }
  fs.writeFileSync(kitFile(id), JSON.stringify(kit, null, 1))
  return kit
}

// ---------- the built-in catalog: free packs Gamesmith downloads itself ----------
let catalogPath = null
let catalogCache = null
export function setCatalogPath(p) {
  catalogPath = p
  catalogCache = null
}
function loadCatalog() {
  if (!catalogPath || !fs.existsSync(catalogPath)) return { base: '', credit: '', packs: [] }
  const mtime = fs.statSync(catalogPath).mtimeMs
  if (catalogCache?.mtime !== mtime) catalogCache = { mtime, data: JSON.parse(fs.readFileSync(catalogPath, 'utf8')) }
  return catalogCache.data
}
const installedIds = () => new Map(listKits().filter((k) => k.catalogId).map((k) => [k.catalogId, k.id]))

/** Packs Gamesmith can add with one click, and which are installed already. */
export function catalog() {
  const c = loadCatalog()
  const have = installedIds()
  return {
    credit: c.credit,
    packs: c.packs.map((p) => ({
      id: p.id,
      name: p.name,
      about: p.about,
      source: p.source,
      url: p.url,
      license: p.license,
      models: p.files.length,
      sample: p.files.slice(0, 8).map((f) => prettyName(f.f.replace(/\.glb$/i, ''))),
      installed: have.get(p.id) || null
    }))
  }
}

/** Packs not installed yet whose name or models match a query (for the modeling AI). */
export function suggestPacks(query, limit = 4) {
  const q = words(query).map((w) => w.replace(/s$/, ''))
  if (!q.length) return []
  const have = installedIds()
  return loadCatalog()
    .packs.filter((p) => !have.has(p.id))
    .map((p) => {
      const hay = words(`${p.name} ${p.about} ${p.files.map((f) => f.f).join(' ')}`).map((w) => w.replace(/s$/, ''))
      return { p, hits: q.filter((w) => hay.some((h) => h === w || (w.length > 3 && h.includes(w)))).length }
    })
    .filter((x) => x.hits)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(({ p }) => ({ id: p.id, name: p.name, about: p.about, models: p.files.length }))
}

/** git's blob hash, which the catalog lists for every file, to check each download. */
const gitBlobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')

async function download(url, sha, fetchFn, signal) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled')
    try {
      const res = await fetchFn(url, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (sha && gitBlobSha(buf) !== sha) throw new Error('the file was damaged on the way')
      return buf
    } catch (e) {
      last = e
      if (signal?.aborted) throw new Error('Cancelled')
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  throw last
}

/**
 * Download a catalog pack and convert it into a kit. opts: { blenderPath, onProgress, signal, fetchFn }.
 * fetchFn defaults to the global fetch (main passes Electron's net.fetch, which uses the system proxy).
 */
export async function installKit(packId, { blenderPath, onProgress = () => {}, signal, fetchFn = globalThis.fetch } = {}) {
  const root = kitsDir()
  if (!root) throw new Error('Kits are not set up yet.')
  const c = loadCatalog()
  const pack = c.packs.find((p) => p.id === packId)
  if (!pack) throw new Error(`There's no kit "${packId}" in the catalog.`)
  const have = installedIds().get(packId)
  if (have) return readKit(have)
  const base = process.env.GAMESMITH_KIT_BASE || c.base
  let id = pack.id
  for (let i = 2; fs.existsSync(join(root, id)); i++) id = `${pack.id}-${i}`
  const dir = join(root, id)
  const srcDir = join(dir, 'source')
  fs.mkdirSync(srcDir, { recursive: true })
  try {
    const total = pack.files.length
    let done = 0
    onProgress({ phase: 'Downloading', done, total })
    const queue = [...pack.files]
    const worker = async () => {
      for (let f; (f = queue.shift()); ) {
        const buf = await download(base + pack.dir + '/' + encodeURIComponent(f.f), f.sha, fetchFn, signal)
        fs.writeFileSync(join(srcDir, f.f), buf)
        onProgress({ phase: 'Downloading', done: ++done, total })
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, total) }, worker))
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(e.message === 'Cancelled' ? 'Cancelled' : `Couldn't download ${pack.name}: ${e.message}. Check your internet connection and try again.`)
  }
  return convert({
    id,
    dir,
    srcDir,
    files: pack.files.map((f) => f.f),
    ext: '.glb',
    name: pack.name,
    source: pack.source,
    url: pack.url,
    license: pack.license,
    licenseText: c.credit,
    label: pack.name,
    catalogId: pack.id,
    blenderPath,
    onProgress,
    signal
  })
}

let runnerPath = null
export function setRunnerPath(p) {
  runnerPath = p
}
const blenderRunnerPath = () => {
  if (!runnerPath) throw new Error('Blender runner not configured')
  return runnerPath
}

const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** Parts matching a query, best first: "kit/part — size, triangles". */
export function findParts(query, limit = 25) {
  const q = words(query).map((w) => w.replace(/s$/, ''))
  const out = []
  for (const k of listKits()) {
    const kit = readKit(k.id)
    for (const p of kit.parts) {
      const hay = words(`${p.name} ${kit.name} ${kit.id}`).map((w) => w.replace(/s$/, ''))
      const hits = q.filter((w) => hay.some((h) => h === w || h.startsWith(w) || (w.length > 3 && h.includes(w)))).length
      if (!q.length || hits) out.push({ kit: kit.id, part: p.name, score: hits * 10 - p.name.length / 100, size: p.size, triangles: p.triangles, rigged: p.rigged, animations: p.animations })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

export const formatPart = (p) =>
  `${p.kit}/${p.part}: ${p.size.map((v) => +v.toFixed(2)).join(' x ')} m (x, y, z), ${p.triangles} triangles${p.rigged ? `, rigged${p.animations?.length ? ` with animations ${p.animations.slice(0, 8).join(', ')}` : ''}` : ''}`
