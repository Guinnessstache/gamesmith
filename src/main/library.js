// Your own asset library: models you make with Blender + AI, reusable in every game.
//
//   Documents/Gamesmith Library/
//     treasure-chest/
//       asset.json   name, description, measurements, dates
//       model.py     the Blender script (the source; edit it to change the model)
//       model.glb    the exported model games load
//       preview.png  rendered preview
//
// The library is its own git repository, so every change can be undone, and it
// can be pushed to GitHub (gamesmith-assets) like a game.
import fs from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import * as localGit from './git.js'
import * as blender from './blender.js'
import * as github from './github.js'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'

let root = null
export function configure(dir) {
  root = dir
}
export const dir = () => root

const SAMPLE = (name, description) => `# ${name}
# ${description || 'Describe the asset to the AI and it will write this script.'}
#
# Blender Python. Build the model in meters with Z up, sitting on the ground (z = 0)
# and centered on the origin. Helpers: mat(name, (r, g, b), roughness, metallic),
# assign(obj, material), shade_smooth(obj). Gamesmith exports every mesh to model.glb.

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
assign(bpy.context.object, mat("Placeholder", (0.6, 0.6, 0.65)))
`

export async function ensure() {
  fs.mkdirSync(root, { recursive: true })
  if (!fs.existsSync(join(root, '.git'))) {
    fs.writeFileSync(
      join(root, 'README.md'),
      '# Gamesmith asset library\n\nModels made with Gamesmith. Each folder has `model.py` (the Blender script that builds it), `model.glb` (the model games load) and `preview.png`.\n'
    )
    fs.writeFileSync(join(root, '.gitignore'), '.gamesmith/\n*.tmp.glb\n*.tmp.png\n')
    await localGit.init(root)
    await localGit.commitAll(root, 'Started the asset library')
  }
}

function safe(id, file = '') {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Bad asset id "${id}"`)
  const p = resolve(root, id, file)
  const r = relative(root, p)
  if (r.startsWith('..') || r.split(sep).includes('..')) throw new Error('Path outside the library')
  return p
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'asset'
  )
}

export function readMeta(id) {
  return JSON.parse(fs.readFileSync(safe(id, 'asset.json'), 'utf8'))
}
function writeMeta(id, meta) {
  fs.writeFileSync(safe(id, 'asset.json'), JSON.stringify(meta, null, 2) + '\n')
}

export function list() {
  if (!root || !fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(join(root, d.name, 'asset.json')))
    .map((d) => {
      try {
        const m = readMeta(d.name)
        return { ...m, hasModel: fs.existsSync(join(root, d.name, 'model.glb')) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
}

export async function create(name, description = '') {
  await ensure()
  const base = slugify(name)
  let id = base
  for (let i = 2; fs.existsSync(join(root, id)); i++) id = `${base}-${i}`
  fs.mkdirSync(join(root, id))
  const now = new Date().toISOString()
  writeMeta(id, { id, name: name.trim() || 'Untitled asset', description, license: 'Own work', created: now, updated: now, stats: null, tags: [] })
  fs.writeFileSync(safe(id, 'model.py'), SAMPLE(name, description))
  await localGit.commitAll(root, `New asset: ${name}`)
  return readMeta(id)
}

export const readScript = (id) => fs.readFileSync(safe(id, 'model.py'), 'utf8')
export function writeScript(id, code) {
  fs.writeFileSync(safe(id, 'model.py'), code)
}

export function files(id) {
  const out = {}
  for (const f of ['model.glb', 'preview.png']) {
    const p = safe(id, f)
    out[f] = fs.existsSync(p) ? fs.readFileSync(p) : null
  }
  return out
}

/**
 * Run the asset's script in Blender. Output goes to temporary files first, so a
 * failed build never replaces the last good model.
 */
export async function build(id, { blenderPath, runner, signal, commitMessage } = {}) {
  const tmpGlb = safe(id, 'model.tmp.glb')
  const tmpPng = safe(id, 'preview.tmp.png')
  const r = await blender.run({ blender: blenderPath, runner, script: safe(id, 'model.py'), outGlb: tmpGlb, outPng: tmpPng, signal })
  if (!r.ok) {
    for (const f of [tmpGlb, tmpPng]) fs.rmSync(f, { force: true })
    return r
  }
  fs.renameSync(tmpGlb, safe(id, 'model.glb'))
  if (fs.existsSync(tmpPng)) fs.renameSync(tmpPng, safe(id, 'preview.png'))
  const meta = readMeta(id)
  writeMeta(id, { ...meta, stats: r.stats, blender: r.blender, updated: new Date().toISOString() })
  if (commitMessage !== false) await localGit.commitAll(root, commitMessage || `Built ${meta.name}`)
  return r
}

export async function rename(id, name) {
  const meta = readMeta(id)
  writeMeta(id, { ...meta, name, updated: new Date().toISOString() })
  await localGit.commitAll(root, `Renamed ${meta.name} to ${name}`)
}

export async function remove(id) {
  const meta = readMeta(id)
  fs.rmSync(safe(id), { recursive: true, force: true })
  await localGit.commitAll(root, `Removed ${meta.name}`)
}

/** Keyword search for the game AI. */
export function search(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return list()
    .filter((a) => a.hasModel)
    .map((a) => ({ a, hits: words.filter((w) => `${a.name} ${a.description} ${a.id} ${(a.tags || []).join(' ')}`.toLowerCase().includes(w)).length }))
    .filter((x) => !words.length || x.hits > 0)
    .sort((x, y) => y.hits - x.hits)
    .map((x) => x.a)
}

// GitHub settings for the library live in .gamesmith/ (ignored by git)
const settingsFile = () => join(root, '.gamesmith', 'library.json')
export function settings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}
export function saveSettings(patch) {
  fs.mkdirSync(join(root, '.gamesmith'), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ...patch }, null, 2))
}

// ---------- modeling chat, one per asset (kept out of git) ----------
const chatFile = (id) => join(root, '.gamesmith', 'chats', `${safeId(id)}.json`)
function safeId(id) {
  safe(id)
  return id
}
export function loadChat(id) {
  try {
    return JSON.parse(fs.readFileSync(chatFile(id), 'utf8'))
  } catch {
    return []
  }
}
export function saveChat(id, turns) {
  fs.mkdirSync(join(root, '.gamesmith', 'chats'), { recursive: true })
  fs.writeFileSync(chatFile(id), JSON.stringify(turns.slice(-200), null, 2))
}

// ---------- GitHub ----------
export const REPO_NAME = 'gamesmith-assets'

/**
 * Connect the library to GitHub. Creates a private gamesmith-assets repo, or, if
 * one already exists (made on another computer), uses it: an empty local library
 * is replaced by a download of it; otherwise the two are merged on the next save.
 */
export async function connectGitHub({ isPrivate = true } = {}) {
  await ensure()
  const account = github.getAccount()
  if (!account) throw new Error('Connect GitHub first (Settings or the Publish panel).')
  let existing = null
  try {
    existing = await github.api(`/repos/${account.login}/${REPO_NAME}`)
  } catch {
    /* doesn't exist yet */
  }
  if (!existing) {
    const repo = await github.createRepo(root, { name: REPO_NAME, isPrivate, description: 'My 3D assets, made with Gamesmith and Blender' })
    saveSettings({ github: repo })
    await github.sync(root, { message: 'Asset library from Gamesmith' })
    saveSettings({ lastSync: Date.now() })
    return { repo, downloaded: 0 }
  }
  if (list().length === 0) {
    const n = await downloadFrom(existing.clone_url)
    const repo = await github.linkRepo(root, existing.full_name)
    saveSettings({ github: repo, lastSync: Date.now() })
    return { repo, downloaded: n }
  }
  const repo = await github.linkRepo(root, existing.full_name)
  saveSettings({ github: repo })
  const r = await sync()
  return { repo, downloaded: 0, ...r }
}

async function downloadFrom(url) {
  const token = github.getToken()
  const tmp = root + '.download'
  fs.rmSync(tmp, { recursive: true, force: true })
  await git.clone({
    fs,
    http,
    dir: tmp,
    url: process.env.GAMESMITH_CLONE_URL_OVERRIDE ? process.env.GAMESMITH_CLONE_URL_OVERRIDE.replace('{name}', REPO_NAME) : url,
    singleBranch: true,
    headers: { Authorization: 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64') },
    onAuth: () => ({ username: 'x-access-token', password: token })
  })
  // Keep this computer's .gamesmith (chats, settings); take everything else from GitHub.
  for (const name of fs.readdirSync(root)) if (name !== '.gamesmith') fs.rmSync(join(root, name), { recursive: true, force: true })
  for (const name of fs.readdirSync(tmp)) fs.renameSync(join(tmp, name), join(root, name))
  fs.rmSync(tmp, { recursive: true, force: true })
  return list().length
}

export async function sync(message = 'Saved asset library from Gamesmith') {
  if (!settings().github) throw new Error('The library is not connected to GitHub yet.')
  const r = await github.sync(root, { message })
  saveSettings({ lastSync: r.time })
  return r
}

export async function status() {
  const s = settings()
  return { dir: root, count: list().length, github: s.github || null, lastSync: s.lastSync || null, unpushed: s.github ? await github.unpushedCount(root) : null }
}
