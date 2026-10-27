// Project folders and file access. Every path coming from the UI or the AI is
// resolved through safePath() so nothing can escape the project folder.
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
  cpSync, rmSync, renameSync
} from 'node:fs'
import { join, resolve, relative, sep, dirname, extname } from 'node:path'
import * as git from './git.js'

const HIDDEN = new Set(['.git', '.gamesmith', 'node_modules', '.DS_Store', 'Thumbs.db'])
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.glsl', '.vert', '.frag', '.svg', '.csv', '.gitignore', ''])

export function isTextFile(p) {
  return TEXT_EXT.has(extname(p).toLowerCase())
}

export function safePath(projectDir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('A file path is required')
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '')
  const abs = resolve(projectDir, cleaned)
  const r = relative(projectDir, abs)
  if (r.startsWith('..') || r.includes(`..${sep}`) || resolve(r) === r) {
    throw new Error(`Path "${rel}" is outside the project`)
  }
  const top = r.split(sep)[0]
  if (top === '.git' || top === '.gamesmith') throw new Error(`"${rel}" is managed by Gamesmith and cannot be changed`)
  return abs
}

export function listTemplates(resourcesDir) {
  const dir = join(resourcesDir, 'templates')
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'template.json')))
    .map((d) => JSON.parse(readFileSync(join(dir, d, 'template.json'), 'utf8')))
}

export function listProjects(projectsDir) {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(projectsDir, d.name)
      try {
        const meta = JSON.parse(readFileSync(join(dir, '.gamesmith', 'project.json'), 'utf8'))
        return { ...meta, dir, modified: statSync(dir).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'my-game'
  )
}

export async function createProject({ projectsDir, resourcesDir, name, templateId }) {
  const tplDir = join(resourcesDir, 'templates', templateId)
  const tpl = JSON.parse(readFileSync(join(tplDir, 'template.json'), 'utf8'))
  mkdirSync(projectsDir, { recursive: true })

  let slug = slugify(name)
  let dir = join(projectsDir, slug)
  for (let i = 2; existsSync(dir); i++) dir = join(projectsDir, `${slug}-${i}`)

  cpSync(tplDir, dir, { recursive: true, filter: (src) => !src.endsWith('template.json') })
  for (const lib of tpl.vendor || []) {
    cpSync(join(resourcesDir, 'vendor', lib), join(dir, 'lib', lib), { recursive: true })
  }
  // Fill in the game name
  for (const f of walk(dir)) {
    if (!/\.(html|md)$/.test(f.path)) continue
    const abs = join(dir, f.path)
    writeFileSync(abs, readFileSync(abs, 'utf8').replaceAll('{{GAME_NAME}}', name))
  }

  const meta = { name, template: tpl.id, engine: tpl.engine, created: new Date().toISOString() }
  mkdirSync(join(dir, '.gamesmith'), { recursive: true })
  writeFileSync(join(dir, '.gamesmith', 'project.json'), JSON.stringify(meta, null, 2))

  await git.init(dir)
  await git.commitAll(dir, `Created "${name}" from the ${tpl.name} template`)
  return { ...meta, dir }
}

export function readMeta(dir) {
  return JSON.parse(readFileSync(join(dir, '.gamesmith', 'project.json'), 'utf8'))
}

/** Recursively list project files as [{ path, size }] using forward slashes. */
export function walk(projectDir, { skipLib = false } = {}) {
  const out = []
  const visit = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (HIDDEN.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (skipLib && childRel === 'lib') continue
      const childAbs = join(abs, e.name)
      if (e.isDirectory()) visit(childAbs, childRel)
      else out.push({ path: childRel, size: statSync(childAbs).size })
    }
  }
  visit(projectDir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function readText(projectDir, rel) {
  const abs = safePath(projectDir, rel)
  if (!existsSync(abs)) throw new Error(`File not found: ${rel}`)
  if (statSync(abs).isDirectory()) throw new Error(`${rel} is a folder, not a file`)
  return readFileSync(abs, 'utf8')
}

export function writeText(projectDir, rel, content) {
  const abs = safePath(projectDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  const existed = existsSync(abs)
  writeFileSync(abs, content)
  return { created: !existed }
}

export function writeBinary(projectDir, rel, buffer) {
  const abs = safePath(projectDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buffer)
}

export function removePath(projectDir, rel) {
  const abs = safePath(projectDir, rel)
  if (!existsSync(abs)) throw new Error(`File not found: ${rel}`)
  // Deleted files stay recoverable through the History panel (git).
  rmSync(abs, { recursive: true, force: true })
}

export function movePath(projectDir, from, to) {
  const a = safePath(projectDir, from)
  const b = safePath(projectDir, to)
  if (existsSync(b)) throw new Error(`${to} already exists`)
  mkdirSync(dirname(b), { recursive: true })
  renameSync(a, b)
}
