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

// ---------- start from a single HTML file ----------

const SKIP_SCRIPT_TYPES = /^(importmap|application\/(ld\+)?json|text\/(template|x-[\w-]+|plain)|x-shader\/[\w-]+)$/i
const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((v) => v !== undefined)

/**
 * Split a one-file HTML game into index.html + style.css + game.js, so the AI can
 * read and edit pieces of it. Files go next to index.html, so relative imports,
 * fetch() calls and import.meta.url resolve exactly as before. Small inline bits
 * (under 5 lines) and special blocks (import maps, shaders, JSON) stay inline.
 */
export function splitHtml(html) {
  const files = {}
  const used = new Set()
  const pick = (base, ext) => {
    let name = `${base}.${ext}`
    for (let i = 2; used.has(name); i++) name = `${base}-${i}.${ext}`
    used.add(name)
    return name
  }
  const lines = (t) => t.split('\n').length
  let out = html.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi, (whole, attrs = '', css) => {
    if (lines(css) < 5 || /\bmedia\s*=/.test(attrs)) return whole
    const name = pick('style', 'css')
    files[name] = dedent(css)
    return `<link rel="stylesheet" href="${name}" />`
  })
  out = out.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (whole, attrs = '', code) => {
    const type = attr(attrs, 'type') || ''
    if (attr(attrs, 'src') !== undefined || SKIP_SCRIPT_TYPES.test(type) || lines(code) < 5) return whole
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) return whole
    const name = pick('game', 'js')
    files[name] = dedent(code)
    return `<script${attrs} src="${name}"></script>`
  })
  return { html: out, files }
}

function dedent(text) {
  const body = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  const indents = body.split('\n').filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return body.split('\n').map((l) => l.slice(cut)).join('\n') + '\n'
}

/** Local files the page refers to (src/href/url()), and libraries it loads from the internet. */
export function htmlReferences(html, cssAndJs = '') {
  const local = new Set()
  const external = new Set()
  const add = (u) => {
    if (!u || /^(#|data:|blob:|mailto:|javascript:|about:)/i.test(u) || u.includes('${')) return
    if (/^(https?:)?\/\//i.test(u)) {
      try {
        external.add(new URL(u.startsWith('//') ? 'https:' + u : u).host)
      } catch {
        /* not a URL */
      }
      return
    }
    local.add(u.split(/[?#]/)[0].replace(/^\.\//, ''))
  }
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  for (const m of (html + cssAndJs).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1])
  // import maps and module imports that point at CDNs
  for (const m of (html + cssAndJs).matchAll(/["'](https:\/\/[^"']+)["']/g)) add(m[1])
  return { local: [...local].filter(Boolean), external: [...external] }
}

/** The library versions a page pins in its import map or script URLs, e.g. "three@0.160.0". */
function pinnedLibraries(html) {
  const out = new Set()
  for (const m of html.matchAll(/\/npm\/((?:@[\w.-]+\/)?[\w.-]+@[\w.-]+)/g)) out.add(m[1])
  for (const m of html.matchAll(/unpkg\.com\/((?:@[\w.-]+\/)?[\w.-]+@[\w.-]+)/g)) out.add(m[1])
  return [...out]
}

/** Make a new game folder from one HTML file, keeping the original as the first version. */
export async function importHtmlFile({ file, projectsDir, name }) {
  const html = fs.readFileSync(file, 'utf8')
  if (!/<(html|body|canvas|script)\b/i.test(html)) throw new Error("That file doesn't look like an HTML page.")
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  const fromTitle = title?.split(/\s+[·|–—-]\s+/)[0]?.trim()
  const pretty = (name || fromTitle || basename(file).replace(/\.html?$/i, '')).trim() || 'Imported game'
  const slug = pretty.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'game'
  fs.mkdirSync(projectsDir, { recursive: true })
  let dir = join(projectsDir, slug)
  for (let i = 2; fs.existsSync(dir); i++) dir = join(projectsDir, `${slug}-${i}`)
  fs.mkdirSync(dir)

  // Version 1: the file exactly as it was.
  fs.writeFileSync(join(dir, 'index.html'), html)
  const meta = await setUp(dir, { source: 'html' })

  // Version 2: split into files the AI can work with.
  const { html: shell, files } = splitHtml(html)
  const parts = Object.keys(files)
  if (parts.length) {
    fs.writeFileSync(join(dir, 'index.html'), shell)
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(join(dir, f), text)
  }
  fs.writeFileSync(
    join(dir, 'README.md'),
    `# ${pretty}\n\nStarted in Gamesmith from \`${basename(file)}\`${title ? ` ("${title}")` : ''}. The first version in History is the original file; the next one splits it into ${['index.html', ...parts].join(', ')} so it's easier to change.\n`
  )
  await localGit.commitAll(dir, parts.length ? `Split ${basename(file)} into ${parts.join(', ')}` : 'Added README')

  const refs = htmlReferences(html, Object.values(files).join('\n'))
  const missing = refs.local.filter((p) => !fs.existsSync(join(dir, p)))
  const libraries = pinnedLibraries(html)
  const full = {
    ...meta,
    name: pretty,
    imported: { ...meta.imported, from: basename(file), title, cdn: refs.external, libraries },
    splitInto: parts
  }
  writeMeta(dir, full)
  return { ...full, dir, missing, needsInternet: refs.external }
}

/** Paths under webRoot, relative to it (what a static host serves). */
export function servedPaths(files, webRoot) {
  if (!webRoot || webRoot === '.') return files
  const prefix = webRoot.replace(/\/$/, '') + '/'
  return files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
}

export { posix }
