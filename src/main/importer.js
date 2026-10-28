// Bring an existing game into Gamesmith: clone it from GitHub, or open a
// folder that's already on this computer.
//
// Gamesmith's own data lives in <game>/.gamesmith/ and is hidden from git with
// .git/info/exclude, so the game's own files (including .gitignore) aren't touched.
import fs from 'node:fs'
import { join, basename, dirname, posix } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import * as localGit from './git.js'

// ---------- what kind of game is this? ----------
const ENGINES = [
  ['three', 'Three.js'],
  ['phaser', 'Phaser'],
  ['pixi.js', 'PixiJS'],
  ['@babylonjs/core', 'Babylon.js'],
  ['babylonjs', 'Babylon.js'],
  ['kaboom', 'Kaboom'],
  ['kaplay', 'KAPLAY'],
  ['excalibur', 'Excalibur'],
  ['playcanvas', 'PlayCanvas']
]

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function read(p, max = 200000) {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max)
  } catch {
    return ''
  }
}

/**
 * Work out how to run a game folder.
 *  kind 'node'   — has its own server/dev server: npm install + npm start (or dev)
 *  kind 'static' — plain files; webRoot is the folder holding index.html
 */
export function detectProject(dir) {
  const pkg = readJson(join(dir, 'package.json'))
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
  const scripts = pkg?.scripts || {}
  const webRoot = ['.', 'public', 'docs', 'client', 'www', 'web', 'static'].find((d) => fs.existsSync(join(dir, d, 'index.html'))) || null

  let engine = ENGINES.find(([dep]) => deps[dep])?.[1]
  if (!engine && webRoot) {
    const html = read(join(dir, webRoot, 'index.html'))
    engine = ENGINES.find(([dep]) => new RegExp(`\\b${dep.replace(/[.@/]/g, '.')}\\b`, 'i').test(html))?.[1]
  }

  const runScript = scripts.start ? 'start' : scripts.dev ? 'dev' : null
  if (pkg && runScript) {
    return {
      kind: 'node',
      engine: engine || 'JavaScript',
      webRoot: webRoot && webRoot !== '.' ? webRoot : null,
      runScript,
      runCommand: scripts[runScript],
      usesVite: !!deps.vite || /\bvite\b/.test(scripts[runScript] || ''),
      name: pkg.name
    }
  }
  if (webRoot) return { kind: 'static', engine: engine || 'JavaScript', webRoot, name: pkg?.name }
  throw new Error("Couldn't find how to run this game: there's no index.html and no \"start\" script in package.json.")
}

// ---------- git plumbing ----------
async function hideGamesmithFolder(dir) {
  const exclude = join(dir, '.git', 'info', 'exclude')
  const cur = read(exclude)
  if (!/^\/?\.gamesmith\/?$/m.test(cur)) {
    fs.mkdirSync(dirname(exclude), { recursive: true })
    fs.writeFileSync(exclude, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '# Gamesmith app data\n.gamesmith/\n')
  }
}

const TEXT = /\.(js|mjs|cjs|ts|jsx|tsx|json|html?|css|md|txt|glsl|vert|frag|svg|ya?ml|xml|csv)$/i

/**
 * A folder checked out by Git for Windows usually has Windows line endings
 * (core.autocrlf from Git's system config). isomorphic-git only reads the
 * repo's own config, so it would see every file as changed. If that's the
 * situation, set core.autocrlf=true on this repo, matching what Git for
 * Windows already does. Returns true if it changed the setting.
 */
export async function fixLineEndings(dir) {
  const current = await git.getConfig({ fs, dir, path: 'core.autocrlf' })
  if (current !== undefined) return false
  const matrix = await git.statusMatrix({ fs, dir })
  const changed = matrix.filter(([f, head, work]) => head === 1 && work === 2 && TEXT.test(f)).slice(0, 40)
  if (!changed.length) return false
  let crlfOnly = 0
  for (const [f] of changed) {
    const work = fs.readFileSync(join(dir, f), 'utf8')
    if (!work.includes('\r\n')) continue
    const { blob } = await git.readBlob({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' }), filepath: f })
    if (Buffer.from(blob).toString('utf8') === work.replace(/\r\n/g, '\n')) crlfOnly++
  }
  if (crlfOnly === 0) return false
  await git.setConfig({ fs, dir, path: 'core.autocrlf', value: 'true' })
  return true
}

/** owner/name from a GitHub remote URL, or null. */
export function parseGitHubUrl(url) {
  const m = String(url || '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], name: m[2] } : null
}

function repoMeta(remoteUrl, branch) {
  const gh = parseGitHubUrl(remoteUrl)
  if (!gh) return null
  return {
    owner: gh.owner,
    name: gh.name,
    fullName: `${gh.owner}/${gh.name}`,
    htmlUrl: `https://github.com/${gh.owner}/${gh.name}`,
    cloneUrl: `https://github.com/${gh.owner}/${gh.name}.git`,
    defaultBranch: branch
  }
}

function writeMeta(dir, meta) {
  fs.mkdirSync(join(dir, '.gamesmith'), { recursive: true })
  fs.writeFileSync(join(dir, '.gamesmith', 'project.json'), JSON.stringify(meta, null, 2))
}

function prettyName(s) {
  return String(s || 'Imported game')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

// ---------- entry points ----------

/** Clone a GitHub repo into the projects folder and set it up. */
export async function importFromGitHub({ ref, projectsDir, token, onProgress = () => {} }) {
  const gh = parseGitHubUrl(ref.includes('github.com') ? ref : `github.com/${ref.trim()}`)
  if (!gh) throw new Error('Enter the repository as owner/name or paste its GitHub URL')
  const url = `https://github.com/${gh.owner}/${gh.name}.git`
  fs.mkdirSync(projectsDir, { recursive: true })
  let dir = join(projectsDir, gh.name)
  for (let i = 2; fs.existsSync(dir); i++) dir = join(projectsDir, `${gh.name}-${i}`)

  const auth = token ? { headers: { Authorization: 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64') } } : {}
  try {
    await git.clone({
      fs,
      http,
      dir,
      url: process.env.GAMESMITH_CLONE_URL_OVERRIDE ? process.env.GAMESMITH_CLONE_URL_OVERRIDE.replace('{name}', gh.name) : url,
      singleBranch: true,
      ...auth,
      onAuth: () => (token ? { username: 'x-access-token', password: token } : { cancel: true }),
      onProgress: (p) => onProgress({ phase: p.phase, loaded: p.loaded, total: p.total })
    })
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    if (/401|403|404|auth|not found|HttpError/i.test(`${e.code} ${e.message}`)) {
      throw new Error(`Couldn't download ${gh.owner}/${gh.name}. Check the name, and if it's a private repository, connect GitHub first (Publish panel or Settings).`)
    }
    throw new Error(`Couldn't download ${gh.owner}/${gh.name}: ${e.message}`)
  }
  return setUp(dir, { source: 'github', remote: url })
}

/** Use a folder already on this computer (its files stay where they are). */
export async function openFolder(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`)
  if (fs.existsSync(join(dir, '.gamesmith', 'project.json'))) return readMetaWithDir(dir)
  const hasGit = fs.existsSync(join(dir, '.git'))
  let lineEndingsFixed = false
  if (hasGit) lineEndingsFixed = await fixLineEndings(dir)
  const out = await setUp(dir, { source: 'folder' })
  return { ...out, lineEndingsFixed, startedTracking: !hasGit }
}

function readMetaWithDir(dir) {
  return { ...JSON.parse(fs.readFileSync(join(dir, '.gamesmith', 'project.json'), 'utf8')), dir }
}

async function setUp(dir, { source, remote }) {
  const info = detectProject(dir)
  if (!fs.existsSync(join(dir, '.git'))) {
    await localGit.init(dir)
    await hideGamesmithFolder(dir)
    await localGit.commitAll(dir, 'Started tracking history in Gamesmith')
  } else {
    await hideGamesmithFolder(dir)
  }
  const branch = await localGit.branch(dir)
  const remotes = await git.listRemotes({ fs, dir }).catch(() => [])
  const origin = remote || remotes.find((r) => r.remote === 'origin')?.url
  const github = repoMeta(origin, branch)

  const meta = {
    name: prettyName(info.name || basename(dir)),
    template: 'imported',
    engine: info.engine,
    kind: info.kind,
    webRoot: info.webRoot,
    runScript: info.runScript,
    runCommand: info.runCommand,
    usesVite: info.usesVite || undefined,
    imported: { source, from: github?.fullName || dir, at: new Date().toISOString() },
    github: github || undefined,
    lastSync: github ? Date.now() : undefined,
    created: new Date().toISOString()
  }
  writeMeta(dir, meta)
  return { ...meta, dir }
}

/** Paths under webRoot, relative to it (what a static host serves). */
export function servedPaths(files, webRoot) {
  if (!webRoot || webRoot === '.') return files
  const prefix = webRoot.replace(/\/$/, '') + '/'
  return files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
}

export { posix }
