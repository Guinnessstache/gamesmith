// Asset library: Poly Haven (CC0 models, textures, skies) through its public
// API, plus importing any asset pack zip (Kenney, itch.io, …).
//
// Everything added to a game is recorded in assets/ASSETS.json (what it is,
// where it came from, its license and files) and assets/CREDITS.md. The AI
// reads the manifest to know what it can use.
//
// Poly Haven API terms: free for any use; apps must send their own User-Agent
// and show a visible "Powered by Poly Haven" credit (done in the UI).
import fs from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { unzipSync } from 'fflate'
import * as files from './projects.js'
import * as pp from './polypizza.js'
import * as library from './library.js'

const API = () => process.env.GAMESMITH_POLYHAVEN_API || 'https://api.polyhaven.com'
export const USER_AGENT = 'Gamesmith/0.3 (+https://github.com/Guinnessstache)'
export const TYPES = ['models', 'textures', 'hdris']
const TYPE_DIR = { models: 'models', textures: 'textures', hdris: 'skies' }
const LIST_TTL = 24 * 3600 * 1000
const MANIFEST = 'assets/ASSETS.json'

let cacheDir = null
export function configure({ cache }) {
  cacheDir = cache
  fs.mkdirSync(cacheDir, { recursive: true })
}

async function api(path) {
  let res
  try {
    res = await fetch(API() + path, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  } catch (e) {
    throw new Error(`Couldn't reach Poly Haven (${e.cause?.code || e.message}). Check your internet connection.`)
  }
  if (res.status === 429) throw new Error('Poly Haven is rate-limiting requests. Wait a minute and try again.')
  if (!res.ok) {
    const err = new Error(`Poly Haven: ${res.status} ${res.statusText}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

function normalize(id, a, type) {
  return {
    id,
    name: a.name || id,
    type,
    description: a.description || '',
    category: a.category || (a.categories || []).join(', '),
    tags: a.tags || [],
    authors: Object.keys(a.authors || {}),
    downloads: a.download_count || 0,
    thumb: a.thumbnail_url || `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
    maxRes: a.max_resolution || null,
    source: 'polyhaven',
    license: 'CC0'
  }
}

/** All assets of a type, most downloaded first. Cached on disk for a day. */
export async function listAssets(type = 'models') {
  if (!TYPES.includes(type)) throw new Error(`Unknown asset type "${type}". Use one of: ${TYPES.join(', ')}`)
  const cacheFile = cacheDir && join(cacheDir, `polyhaven-${type}.json`)
  if (cacheFile && fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < LIST_TTL) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    } catch {
      /* re-fetch */
    }
  }
  const data = await api(`/assets?type=${type}`)
  const list = Object.entries(data)
    .map(([id, a]) => normalize(id, a, type))
    .sort((a, b) => b.downloads - a.downloads)
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(list))
  return list
}

function keywordFilter(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return list
    .map((a) => {
      const hay = `${a.name} ${a.id} ${a.tags.join(' ')} ${a.category}`.toLowerCase()
      const hits = words.filter((w) => hay.includes(w)).length
      return { a, hits }
    })
    .filter((x) => x.hits > 0)
    .sort((x, y) => y.hits - x.hits || y.a.downloads - x.a.downloads)
    .map((x) => x.a)
}

/** Search one type. Uses Poly Haven's semantic search, falling back to keywords. */
export async function search(query, type = 'models', limit = 48, source = 'polyhaven') {
  if (source === 'polypizza') {
    if (type !== 'models') return []
    return pp.search(query, limit)
  }
  const list = await listAssets(type)
  const q = String(query || '').trim().toLowerCase().slice(0, 100)
  if (!q) return list.slice(0, limit)
  const byId = new Map(list.map((a) => [a.id, a]))
  try {
    const r = await api(`/search?q=${encodeURIComponent(q)}&t=${type}&limit=${limit}`)
    const hits = (r.results || []).map((x) => byId.get(x.slug)).filter(Boolean)
    if (hits.length) return hits
  } catch {
    /* semantic search unavailable: fall through */
  }
  return keywordFilter(list, q).slice(0, limit)
}

/** Models from every source the user has set up: Poly Haven first, then Poly Pizza. */
export async function searchAllModels(query, limit = 12) {
  const out = []
  const errors = []
  try {
    out.push(
      ...library.search(query).slice(0, limit).map((a) => ({
        id: `lib-${a.id}`,
        name: a.name,
        source: 'mine',
        category: 'Your library',
        license: a.license || 'Own work',
        tags: a.tags || [],
        size_m: a.stats?.size_m
      }))
    )
  } catch {
    /* no library yet */
  }
  try {
    out.push(...(await search(query, 'models', limit, 'polyhaven')))
  } catch (e) {
    errors.push(e.message)
  }
  if (pp.hasKey()) {
    try {
      out.push(...(await pp.search(query, limit)))
    } catch (e) {
      errors.push(e.message)
    }
  }
  if (!out.length && errors.length) throw new Error(errors.join(' '))
  return out
}

export const polyPizza = pp

// ---------- downloading ----------
const pickRes = (byRes, wanted) => {
  if (!byRes) return null
  if (byRes[wanted]) return wanted
  const order = Object.keys(byRes).sort((a, b) => parseInt(a) - parseInt(b))
  return order.find((r) => parseInt(r) >= parseInt(wanted)) || order.at(-1)
}

// Map names in Poly Haven's file tree aren't documented in the API spec, so
// match a few known spellings case-insensitively.
const TEXTURE_MAPS = [
  [['diffuse', 'diff', 'albedo', 'color', 'col', 'basecolor'], 'color'],
  [['nor_gl', 'normal_gl', 'normal', 'nor'], 'normal'],
  [['rough', 'roughness'], 'roughness'],
  [['ao', 'ambientocclusion'], 'ao']
]
function findMap(tree, names) {
  const keys = Object.keys(tree)
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n)
    if (k && tree[k] && typeof tree[k] === 'object') return tree[k]
  }
  return null
}

/** Work out which files to download for an asset, without downloading anything. */
export async function plan(id, type, res = '1k') {
  if (id.startsWith('pp-')) {
    const m = await pp.get(id)
    const name = fileSlug(m.name)
    const entry = `assets/models/${name}-${m.sourceId}/${name}.glb`
    const bytes = await pp.size(m)
    return { id, type: 'models', resolution: null, entry, maps: null, files: [{ url: m.download, path: entry, size: bytes || 0 }], totalBytes: bytes, sizeUnknown: !bytes }
  }
  const tree = await api(`/files/${encodeURIComponent(id)}`)
  const base = `assets/${TYPE_DIR[type]}/${id}`
  const out = []
  let entry
  let maps = null
  let chosen

  if (type === 'models') {
    chosen = pickRes(tree.gltf, res)
    const g = chosen && tree.gltf[chosen]?.gltf
    if (!g) throw new Error(`${id} has no glTF download`)
    entry = `${base}/${id}.gltf`
    out.push({ url: g.url, path: entry, size: g.size || 0 })
    for (const [rel, f] of Object.entries(g.include || {})) {
      out.push({ url: f.url, path: posix.normalize(`${base}/${rel}`), size: f.size || 0 })
    }
  } else if (type === 'textures') {
    maps = {}
    for (const [names, role] of TEXTURE_MAPS) {
      const byRes = findMap(tree, names)
      const r = pickRes(byRes, res)
      const f = r && (byRes[r]?.jpg || byRes[r]?.png)
      if (!f) continue
      chosen ||= r
      const ext = byRes[r]?.jpg ? 'jpg' : 'png'
      const p = `${base}/${id}_${role}.${ext}`
      out.push({ url: f.url, path: p, size: f.size || 0 })
      maps[role] = p
    }
    if (!maps.color) throw new Error(`${id} has no color map to download`)
    entry = maps.color
  } else if (type === 'hdris') {
    chosen = pickRes(tree.hdri, res)
    const f = chosen && tree.hdri[chosen]?.hdr
    if (!f) throw new Error(`${id} has no .hdr download`)
    entry = `assets/${TYPE_DIR[type]}/${id}_${chosen}.hdr`
    out.push({ url: f.url, path: entry, size: f.size || 0 })
  } else {
    throw new Error(`Unknown asset type "${type}"`)
  }

  for (const f of out) {
    if (f.path.includes('..')) throw new Error(`Unsafe file path in ${id}: ${f.path}`)
  }
  return { id, type, resolution: chosen, entry, maps, files: out, totalBytes: out.reduce((n, f) => n + f.size, 0) }
}

async function download(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120000) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (i >= attempts) throw new Error(`Download failed for ${url.split('/').pop()}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
}

// ---------- manifest ----------
export function readManifest(projectDir) {
  try {
    return JSON.parse(fs.readFileSync(join(projectDir, MANIFEST), 'utf8'))
  } catch {
    return { assets: [] }
  }
}

function writeManifest(projectDir, manifest) {
  files.writeText(projectDir, MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  const lines = ['# Credits', '', 'Third-party assets used in this game.', '']
  for (const a of manifest.assets) {
    const who = a.authors?.join(', ')
    const by = who ? ` by ${a.creatorUrl ? `[${who}](${a.creatorUrl})` : who}` : ''
    const src = a.url ? `[${a.source}](${a.url})` : a.source
    lines.push(`- **${a.name}**${by}, from ${src}. License: ${a.license}.`)
  }
  if (manifest.assets.some((a) => a.source === 'Poly Haven')) lines.push('', 'Poly Haven assets are CC0: https://polyhaven.com/license')
  if (manifest.assets.some((a) => /BY/i.test(a.license))) lines.push('', 'CC-BY assets require this credit to be shown with the game (for example on a credits screen or the game page).')
  files.writeText(projectDir, 'assets/CREDITS.md', lines.join('\n') + '\n')
}

function upsert(projectDir, record) {
  const m = readManifest(projectDir)
  m.assets = m.assets.filter((a) => a.id !== record.id)
  m.assets.push(record)
  writeManifest(projectDir, m)
}

/** Some engine add-ons aren't in older projects; copy them in when an asset needs them. */
function ensureAddon(projectDir, resourcesDir, rel) {
  const dest = join(projectDir, 'lib', 'three', 'addons', rel)
  const src = join(resourcesDir, 'vendor', 'three', 'addons', rel)
  if (!fs.existsSync(dest) && fs.existsSync(src) && fs.existsSync(join(projectDir, 'lib', 'three'))) {
    fs.mkdirSync(dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'

/** Add any asset (Poly Haven, Poly Pizza, or your own library) to the game. */
export async function addAsset(projectDir, opts) {
  if (opts.id.startsWith('lib-')) return addFromLibrary(projectDir, opts.id.slice(4))
  return opts.id.startsWith('pp-') ? addPolyPizza(projectDir, opts) : addPolyHaven(projectDir, opts)
}

/** Copy a model from your own asset library into the game. */
export function addFromLibrary(projectDir, libId) {
  const meta = library.readMeta(libId)
  const { 'model.glb': glb } = library.files(libId)
  if (!glb) throw new Error(`"${meta.name}" hasn't been built yet. Open it in the Blender tab and build it first.`)
  const entry = `assets/models/${libId}/${libId}.glb`
  files.writeBinary(projectDir, entry, glb)
  const record = {
    id: `lib-${libId}`,
    name: meta.name,
    type: 'models',
    source: 'My library',
    license: meta.license || 'Own work',
    authors: [],
    ownModel: true,
    size_m: meta.stats?.size_m,
    entry,
    files: [entry],
    bytes: glb.length,
    added: new Date().toISOString()
  }
  upsert(projectDir, record)
  return record
}

async function addPolyPizza(projectDir, { id, onProgress = () => {} }) {
  const m = await pp.get(id)
  const p = await plan(id, 'models')
  const buf = await download(m.download)
  files.writeBinary(projectDir, p.entry, buf)
  onProgress({ id, done: 1, total: 1 })
  const record = {
    id,
    name: m.name,
    type: 'models',
    source: 'Poly Pizza',
    url: `https://poly.pizza/m/${m.sourceId}`,
    license: m.license,
    authors: m.authors,
    creatorUrl: m.creatorUrl || undefined,
    lowPoly: true,
    tris: m.tris || undefined,
    animated: m.animated || undefined,
    entry: p.entry,
    files: [p.entry],
    bytes: buf.length,
    added: new Date().toISOString()
  }
  upsert(projectDir, record)
  return record
}

/** Download a Poly Haven asset into the game and record it. */
export async function addPolyHaven(projectDir, { id, type, res = '1k', resourcesDir, onProgress = () => {} }) {
  const p = await plan(id, type, res)
  const info = (await listAssets(type)).find((a) => a.id === id) || normalize(id, await api(`/info/${encodeURIComponent(id)}`), type)
  let done = 0
  const queue = [...p.files]
  const worker = async () => {
    for (let f; (f = queue.shift()); ) {
      const buf = await download(f.url)
      files.writeBinary(projectDir, f.path, buf)
      done++
      onProgress({ id, done, total: p.files.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, p.files.length) }, worker))
  if (type === 'hdris' && resourcesDir) ensureAddon(projectDir, resourcesDir, 'loaders/HDRLoader.js')

  const record = {
    id,
    name: info.name,
    type,
    source: 'Poly Haven',
    url: `https://polyhaven.com/a/${id}`,
    license: 'CC0',
    authors: info.authors,
    resolution: p.resolution,
    entry: p.entry,
    maps: p.maps || undefined,
    files: p.files.map((f) => f.path),
    bytes: p.totalBytes,
    added: new Date().toISOString()
  }
  upsert(projectDir, record)
  return record
}

// ---------- zip packs ----------
const PACK_EXT = /\.(png|jpe?g|webp|gif|svg|ogg|mp3|wav|m4a|glb|gltf|bin|json|txt|md|fnt|xml|tmx|tsx|ttf|otf|woff2?)$/i
const MAX_PACK_BYTES = 300 * 1024 * 1024

function slug(s) {
  return s.toLowerCase().replace(/\.zip$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'pack'
}

/** Extract an asset pack zip into assets/packs/<name>/ and record it. */
export function importZip(projectDir, zipPath) {
  const name = zipPath.split(/[\\/]/).pop()
  const id = `pack-${slug(name)}`
  const entries = unzipSync(fs.readFileSync(zipPath), {
    filter: (f) => !f.name.endsWith('/') && !f.name.includes('__MACOSX') && !/(^|\/)\./.test(f.name) && PACK_EXT.test(f.name)
  })
  const names = Object.keys(entries)
  if (!names.length) throw new Error(`${name} has no image, audio, model or font files Gamesmith can use`)
  const total = names.reduce((n, k) => n + entries[k].length, 0)
  if (total > MAX_PACK_BYTES) throw new Error(`${name} is ${Math.round(total / 1e6)} MB unpacked; the limit is 300 MB`)

  // Drop a single shared top folder ("Kenney Pack/…") to keep paths short.
  const tops = new Set(names.map((n) => n.split('/')[0]))
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0].length + 1 : 0
  const base = `assets/packs/${slug(name)}`
  const written = []
  for (const n of names) {
    const rel = posix.normalize(n.slice(strip))
    if (rel.startsWith('..') || posix.isAbsolute(rel)) continue // zip-slip guard
    const p = `${base}/${rel}`
    files.writeBinary(projectDir, p, Buffer.from(entries[n]))
    written.push(p)
  }

  const licenseFile = names.find((n) => /licen[cs]e/i.test(n))
  const licenseText = licenseFile ? Buffer.from(entries[licenseFile]).toString('utf8') : ''
  const license = /CC0|creative commons zero|public domain/i.test(licenseText) ? 'CC0' : licenseText ? 'See license file in pack' : 'Unknown (check where you got it)'
  const record = {
    id,
    name: name.replace(/\.zip$/i, ''),
    type: 'pack',
    source: /kenney/i.test(name + licenseText) ? 'Kenney (kenney.nl)' : 'Imported pack',
    license,
    entry: base,
    files: written,
    bytes: total,
    added: new Date().toISOString()
  }
  upsert(projectDir, record)
  return record
}

export function removeAsset(projectDir, id) {
  const m = readManifest(projectDir)
  const a = m.assets.find((x) => x.id === id)
  if (!a) throw new Error(`No asset "${id}" in this game`)
  const dir = a.type === 'pack' ? a.entry : a.type === 'hdris' ? null : posix.dirname(a.entry)
  if (dir) files.removePath(projectDir, dir)
  else for (const f of a.files) {
    try {
      files.removePath(projectDir, f)
    } catch {
      /* already gone */
    }
  }
  m.assets = m.assets.filter((x) => x.id !== id)
  writeManifest(projectDir, m)
}

// ---------- what the AI sees ----------
const KIND = (p) =>
  /\.(png|jpe?g|webp|gif|svg)$/i.test(p) ? 'image' : /\.(ogg|mp3|wav|m4a)$/i.test(p) ? 'sound' : /\.(glb|gltf)$/i.test(p) ? 'model' : /\.(ttf|otf|woff2?|fnt)$/i.test(p) ? 'font' : 'other'

export function usageHint(record, template) {
  const three = template === 'three-3d'
  switch (record.type) {
    case 'models':
      if (record.ownModel) {
        const sz = record.size_m ? ` Size: ${record.size_m.width} x ${record.size_m.depth} m, ${record.size_m.height} m tall.` : ''
        return three
          ? `GLTFLoader from 'three/addons/loaders/GLTFLoader.js': new GLTFLoader().load('${record.entry}', (g) => scene.add(g.scene)). Made in the user's asset library: real-world meters, origin at the bottom center (sits on y = 0).${sz} Metal parts need reflections to look right: set scene.environment (e.g. RoomEnvironment from 'three/addons/environments/RoomEnvironment.js' through a PMREMGenerator) if the game doesn't have one.`
          : `3D model (.glb); not usable in a 2D Phaser game.`
      }
      if (record.lowPoly) {
        return three
          ? `GLTFLoader from 'three/addons/loaders/GLTFLoader.js': new GLTFLoader().load('${record.entry}', (g) => scene.add(g.scene)). Low-poly model with arbitrary scale: measure it with new THREE.Box3().setFromObject(g.scene) and scale it to the size you want.${record.animated ? ' Has animations: play g.animations with THREE.AnimationMixer.' : ''}`
          : `3D model (.glb); not usable in a 2D Phaser game.`
      }
      return three
        ? `GLTFLoader from 'three/addons/loaders/GLTFLoader.js': new GLTFLoader().load('${record.entry}', (g) => scene.add(g.scene)). Real-world scale in meters.`
        : `3D model (glTF); not usable in a 2D Phaser game.`
    case 'textures':
      return three
        ? `TextureLoader: color '${record.maps.color}'${record.maps.normal ? `, normal '${record.maps.normal}'` : ''}${record.maps.roughness ? `, roughness '${record.maps.roughness}'` : ''}. Set colorSpace = THREE.SRGBColorSpace on the color map, wrapS/wrapT = RepeatWrapping to tile.`
        : `Tileable image: this.load.image('${record.id}', '${record.maps.color}') then this.add.tileSprite(...).`
    case 'hdris':
      return three
        ? `Sky + lighting: import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'; new HDRLoader().load('${record.entry}', (t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.background = t; scene.environment = t })`
        : `HDR sky image; only useful in 3D games.`
    case 'pack':
      return three ? 'Images can be textures; .glb/.gltf files load with GLTFLoader; sounds play with THREE.Audio or new Audio(path).' : "Load images with this.load.image(key, path), sounds with this.load.audio(key, path)."
    default:
      return ''
  }
}

/** Compact text listing of the game's assets for the AI's system prompt. */
export function catalogForAI(projectDir, template, maxLines = 70) {
  const m = readManifest(projectDir)
  if (!m.assets.length) return '(none yet; use search_assets and add_asset to get some)'
  const lines = []
  for (const a of m.assets) {
    if (a.type !== 'pack') {
      lines.push(`- ${a.name} [${a.type}] ${a.entry}\n    ${usageHint(a, template)}`)
      continue
    }
    lines.push(`- Pack "${a.name}" in ${a.entry}/ (${a.files.length} files, license ${a.license}). ${usageHint(a, template)}`)
    const byFolder = {}
    for (const f of a.files) (byFolder[posix.dirname(f)] ||= []).push(f)
    for (const [folder, list] of Object.entries(byFolder)) {
      const kinds = {}
      for (const f of list) kinds[KIND(f)] = (kinds[KIND(f)] || 0) + 1
      const sample = list.slice(0, 6).map((f) => posix.basename(f)).join(', ')
      lines.push(`    ${folder}/  ${Object.entries(kinds).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ')}: ${sample}${list.length > 6 ? ', …' : ''}`)
    }
  }
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + `\n(… use list_files for the rest)` : lines.join('\n')
}
