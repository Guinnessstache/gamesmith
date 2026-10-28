// The game-building agent. Designed for local 7B–70B models:
//  - small, explicit tools (search/replace edits instead of whole-file rewrites)
//  - compact context (file list + design doc, older turns summarized)
//  - a closed loop: after edits the game is actually run, and any console
//    errors are fed back automatically until it runs clean.
import { chat, extractTextToolCalls, splitThinking } from './aiClient.js'
import * as files from './projects.js'
import * as assets from './assets.js'

const MAX_READ_CHARS = 40000
const READ_CHUNK_LINES = 400 // long files are read in slices
const TEXT_FILE = /\.(m?js|cjs|ts|mts|jsx|tsx|json|html?|css|scss|md|txt|glsl|vert|frag|wgsl|ya?ml|xml|svg|csv|toml)$/i
const MAX_ASSET_ADDS = 6 // downloads per request, to keep a confused model from filling the disk
const HISTORY_TURNS = 10

const ENGINE_NOTES = {
  'phaser-2d': `ENGINE: Phaser 3.90 (2D), loaded by index.html as a global \`Phaser\`. Never import Phaser; use the global.
- Scenes live in src/scenes/*.js and are registered in src/main.js.
- Arcade physics is enabled in src/main.js.
- Use Phaser 3 APIs only (this.physics.add.sprite, this.add.text, this.input.keyboard, this.tweens, etc.).`,
  'three-3d': `ENGINE: Three.js r186 (3D) via the import map in index.html.
- Import with: import * as THREE from 'three'
- Available addons ONLY: 'three/addons/controls/OrbitControls.js', 'three/addons/controls/PointerLockControls.js', 'three/addons/loaders/GLTFLoader.js', 'three/addons/utils/BufferGeometryUtils.js', 'three/addons/utils/SkeletonUtils.js'
- Use THREE.Timer (not THREE.Clock) for frame timing: timer.update() then timer.getDelta().`
}

/** File list for big existing projects: code files by name, asset folders summarized. */
export function compactTree(list, maxLines = 260) {
  const code = []
  const assetDirs = new Map()
  for (const f of list) {
    if (TEXT_FILE.test(f.path) && f.size < 400000) code.push(`  ${f.path} (${f.size} bytes)`)
    else {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'
      const ext = (f.path.match(/\.(\w+)$/)?.[1] || 'other').toLowerCase()
      const d = assetDirs.get(dir) || { n: 0, exts: {} }
      d.n++
      d.exts[ext] = (d.exts[ext] || 0) + 1
      assetDirs.set(dir, d)
    }
  }
  const lines = code.length > maxLines ? [...code.slice(0, maxLines), `  … ${code.length - maxLines} more code files (use list_files or search_files)`] : code
  for (const [dir, d] of [...assetDirs].sort()) {
    lines.push(`  ${dir}/  [${d.n} asset file${d.n > 1 ? 's' : ''}: ${Object.entries(d.exts).map(([e, n]) => `${n} .${e}`).join(', ')}]`)
  }
  return lines.join('\n')
}

function importedPrompt(projectDir, meta) {
  const excerpt = (path, max) => {
    try {
      const t = files.readText(projectDir, path)
      return t.length > max ? t.slice(0, max) + '\n…' : t
    } catch {
      return null
    }
  }
  let pkg = null
  try {
    pkg = JSON.parse(files.readText(projectDir, 'package.json'))
  } catch {
    /* none */
  }
  const how =
    meta.kind === 'node'
      ? `This game has its own server. Gamesmith runs "npm run ${meta.runScript}" (${meta.runCommand}) with PORT set, and the preview goes through that server.${meta.webRoot ? ` Browser code lives in ${meta.webRoot}/; everything else (server code) restarts the server when changed.` : ''}${meta.usesVite ? ' It uses Vite, which hot-reloads browser code by itself.' : ''}`
      : `Static game: the preview serves ${meta.webRoot && meta.webRoot !== '.' ? `${meta.webRoot}/` : 'the top folder'} as the website root.`
  const readme = excerpt('README.md', 2500)
  const todo = excerpt('TODO.md', 1200)
  return `You are Gamesmith, an expert game developer. You are working on the user's EXISTING game by reading and editing its files with tools. You never ask the user to edit code themselves.

PROJECT: "${meta.name}" (imported${meta.github ? ` from github.com/${meta.github.fullName}` : ''})
ENGINE / LANGUAGE: ${meta.engine}
HOW IT RUNS: ${how}
${pkg ? `package.json scripts: ${JSON.stringify(pkg.scripts || {})}\ndependencies: ${Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).join(', ') || 'none'}` : ''}

RULES FOR AN EXISTING CODEBASE
1. Learn before changing: use search_files to find where things are, then read_file the relevant parts. Large files are read in slices with start_line/end_line.
2. Follow the code's existing style, structure and naming. Make small, focused edits with edit_file; never rewrite or reformat whole files that already exist.
3. old_text in edit_file must be copied EXACTLY from the file and be unique; include a few surrounding lines.
4. Don't add npm packages unless the user asks. If you must, add them to package.json; Gamesmith reinstalls automatically.
5. Don't touch secrets, .env files, database settings or deployment config unless asked.
6. After changing code, call check_game and fix any errors it reports (server errors are included).
7. When finished, reply with 2-4 plain sentences: what changed, which files, and how to try it. Do not paste code.

FILES (code by name; asset folders summarized; generated folders from .gitignore hidden):
${compactTree(files.walk(projectDir))}
${readme ? `\nREADME.md (start):\n${readme}` : ''}${todo ? `\n\nTODO.md:\n${todo}` : ''}`
}

function systemPrompt(projectDir, meta) {
  if (meta.template === 'imported') return importedPrompt(projectDir, meta)
  const tree = files
    .walk(projectDir, { skipLib: true })
    .filter((f) => !/^assets\/(models|textures|skies|packs)\//.test(f.path))
    .map((f) => `  ${f.path} (${f.size} bytes)`)
    .join('\n')
  let design = ''
  try {
    design = files.readText(projectDir, 'GAME_DESIGN.md').slice(0, 6000)
  } catch {
    design = '(missing; create GAME_DESIGN.md)'
  }

  return `You are Gamesmith, an expert browser game developer. You build the user's game by reading and editing project files with tools. You never ask the user to edit code themselves.

PROJECT: "${meta.name}"
${ENGINE_NOTES[meta.template] || `ENGINE: ${meta.engine}`}

HOW THIS PROJECT WORKS
- It is plain static files: index.html, style.css, src/*.js (native ES modules), assets/. There is no npm, no bundler, no TypeScript, no build step.
- Never load scripts from URLs/CDNs. Never edit or read anything in lib/ (engine files).
- Make art with code (shapes, generated textures, colors) unless the user has put files in assets/.
- Relative imports must include the .js extension, e.g. import { Player } from './player.js'

RULES FOR EDITING
1. Read a file before you edit it.
2. For changes to an existing file use edit_file. old_text must be copied EXACTLY from the file (same spaces and line breaks) and be unique; include a few surrounding lines to make it unique.
3. Use write_file only for new files or when rewriting a small file completely. Always write the complete file, never "..." placeholders.
4. Keep files under ~300 lines; split big features into new modules.
5. After changing code, call check_game and fix any errors it reports.
6. Keep GAME_DESIGN.md up to date (features, controls) when you add or change gameplay.
7. When finished, reply with 2-4 plain sentences: what changed and how to try it. Do not paste code in your reply.

ASSETS
- Ready-made free assets: search_assets then add_asset. Types: models (3D props, nature, vehicles, characters), textures (tileable surfaces), hdris (3D skies + lighting). Prefer one consistent style per game: realistic (Poly Haven) or low-poly (pp- ids).${meta.template === 'phaser-2d' ? ' This is a 2D game: only textures are useful from Poly Haven (as tiled backgrounds/ground). Prefer art drawn with code, or packs the user imported.' : ''}
- Only use asset files that exist. After add_asset, use the exact paths it returns.
- Assets already in this game:
${assets.catalogForAI(projectDir, meta.template)}

FILES (excluding lib/ and asset files listed above):
${tree}

GAME_DESIGN.md:
${design}`
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all project files with sizes (engine files in lib/ are hidden).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project. Long files are returned in slices; pass start_line/end_line (1-based) to read a specific part.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root, e.g. src/main.js' },
          start_line: { type: 'integer', description: 'First line to read (optional)' },
          end_line: { type: 'integer', description: 'Last line to read (optional)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search all code/text files for a word or phrase (case-insensitive). Returns matching lines as path:line: text. Use this to find where something is defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find, e.g. "function spawnEnemy" or "maxHealth"' },
          path: { type: 'string', description: 'Only search inside this folder (optional), e.g. "server"' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact snippet of text in an existing file. old_text must match the file exactly and appear once (unless replace_all is true).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string', description: 'Exact text currently in the file' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file, or completely replace a file, with the full content given.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete file content' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the project.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_assets',
      description: 'Search free asset libraries: Poly Haven (realistic CC0 models, tileable textures, HDRI skies) and, if set up, Poly Pizza (10,000+ low-poly models incl. vehicles, characters, buildings; ids start with pp-). Returns ids to use with add_asset.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need, e.g. "wooden barrel", "grass", "sunset sky"' },
          type: { type: 'string', enum: ['models', 'textures', 'hdris'] }
        },
        required: ['query', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_asset',
      description: 'Download a Poly Haven asset into this game (assets/ folder) and get the exact file paths and how to load it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Asset id from search_assets' },
          type: { type: 'string', enum: ['models', 'textures', 'hdris'] }
        },
        required: ['id', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_game',
      description: 'Reload and run the game in the preview, then return console errors and warnings from the first moments of play.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  const s = String(raw || '').trim()
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch {
    const unfenced = s.replace(/^```(?:json)?\s*|\s*```$/g, '')
    return JSON.parse(unfenced) // let this throw with a clear message
  }
}

function countOccurrences(hay, needle) {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** Find old_text in content, tolerating CRLF and trailing-whitespace differences. */
export function applyEdit(content, oldText, newText, replaceAll = false) {
  const attempts = [
    [content, oldText, (c) => c],
    [content.replace(/\r\n/g, '\n'), oldText.replace(/\r\n/g, '\n'), (c) => (content.includes('\r\n') ? c.replace(/\n/g, '\r\n') : c)],
    [
      content.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''),
      oldText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''),
      (c) => (content.includes('\r\n') ? c.replace(/\n/g, '\r\n') : c)
    ]
  ]
  for (const [hay, needle, restore] of attempts) {
    const n = countOccurrences(hay, needle)
    if (n === 0) continue
    if (n > 1 && !replaceAll) {
      throw new Error(`old_text appears ${n} times in the file. Include more surrounding lines so it is unique, or set replace_all to true.`)
    }
    const next = replaceAll ? hay.split(needle).join(newText) : hay.replace(needle, () => newText)
    return { content: restore(next), count: n }
  }
  throw new Error('old_text was not found in the file. Call read_file to see the current content, then copy the text exactly.')
}

// Errors caused by the computer (no GPU / blocked WebGL), not by the game's code.
const ENVIRONMENT_ERROR = /WebGL context could not be created|Error creating WebGL context|WebGL2? is not supported|CONTEXT_LOST_WEBGL/i
export function isEnvironmentOnly(result) {
  return !!result?.errors?.length && result.errors.every((e) => ENVIRONMENT_ERROR.test(e.text))
}

function formatCheck(result) {
  if (result.note) return result.note
  if (isEnvironmentOnly(result)) {
    return 'The preview could not start 3D graphics (WebGL) on this computer. This is a graphics driver or GPU problem, NOT a bug in the game code. Do not change code because of it; the game will work on other computers.'
  }
  const lines = []
  lines.push(result.loaded ? 'The game loaded.' : 'The game did NOT finish loading (the page load event never fired).')
  const important = result.entries.filter((e) => e.level === 'error' || e.level === 'warn')
  if (!important.length) lines.push('No errors or warnings in the console.')
  else {
    lines.push(`${result.errors.length} error(s), ${important.length - result.errors.length} warning(s):`)
    for (const e of important.slice(0, 12)) lines.push(`[${e.level}] ${e.text.slice(0, 800)}`)
  }
  return lines.join('\n')
}

/**
 * Run one user request to completion.
 * deps: { projectDir, meta, ai, preview, history, emit, signal }
 * Returns { reply, changedFiles, check }.
 */
export async function runAgent({ projectDir, meta, ai, preview, history = [], userText, emit = () => {}, signal, resourcesDir }) {
  if (!ai.model) throw new Error('No model selected. Open Settings and pick a model.')

  const messages = [{ role: 'system', content: systemPrompt(projectDir, meta) }]
  for (const turn of history.slice(-HISTORY_TURNS)) {
    if (turn.role === 'user' || turn.role === 'assistant') messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: 'user', content: userText })

  const changed = new Set()
  let lastCheck = null
  let fixRounds = 0
  let reply = ''
  let textMode = false // model is emitting tool calls as text instead of native tool calls
  let assetAdds = 0
  const addedAssets = []

  const runTool = async (name, args) => {
    switch (name) {
      case 'list_files': {
        const list = files.walk(projectDir, { skipLib: true })
        return meta.template === 'imported' ? compactTree(list, 2000) : list.map((f) => `${f.path} (${f.size} bytes)`).join('\n')
      }
      case 'read_file': {
        const text = files.readText(projectDir, args.path)
        const lines = text.split('\n')
        const ranged = args.start_line != null || args.end_line != null
        if (!ranged && text.length <= MAX_READ_CHARS) return text
        const from = Math.max(1, Number(args.start_line) || 1)
        const to = Math.min(lines.length, Number(args.end_line) || from + READ_CHUNK_LINES - 1, from + 1500)
        const slice = lines.slice(from - 1, to).join('\n')
        const more = to < lines.length ? ` Read more with start_line=${to + 1}.` : ''
        return `[${args.path}: lines ${from}-${to} of ${lines.length}.${more}]\n${slice}`
      }
      case 'search_files': {
        const q = String(args.query || '').toLowerCase()
        if (q.length < 2) throw new Error('query must be at least 2 characters')
        const base = args.path ? String(args.path).replace(/^\.?\/+|\/+$/g, '') + '/' : ''
        const hits = []
        let scanned = 0
        for (const f of files.walk(projectDir, { skipLib: true })) {
          if (base && !f.path.startsWith(base)) continue
          if (!TEXT_FILE.test(f.path) || f.size > 1500000 || /\.min\.js$/.test(f.path)) continue
          scanned++
          const lines = files.readText(projectDir, f.path).split('\n')
          for (let i = 0; i < lines.length && hits.length < 80; i++) {
            if (lines[i].toLowerCase().includes(q)) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
          if (hits.length >= 80) break
        }
        if (!hits.length) return `No matches for "${args.query}" in ${scanned} files.`
        return hits.join('\n') + (hits.length >= 80 ? '\n(first 80 matches; narrow the search with path or a longer query)' : '')
      }
      case 'edit_file': {
        if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new Error('old_text and new_text are required strings')
        const cur = files.readText(projectDir, args.path)
        const { content, count } = applyEdit(cur, args.old_text, args.new_text, !!args.replace_all)
        files.writeText(projectDir, args.path, content)
        changed.add(args.path)
        return `Edited ${args.path} (${count} replacement${count > 1 ? 's' : ''}).`
      }
      case 'write_file': {
        if (typeof args.content !== 'string') throw new Error('content is required')
        if (/^\s*lib\//.test(args.path)) throw new Error('lib/ contains engine files and must not be changed')
        const { created } = files.writeText(projectDir, args.path, args.content)
        changed.add(args.path)
        return `${created ? 'Created' : 'Rewrote'} ${args.path} (${args.content.split('\n').length} lines).`
      }
      case 'delete_file':
        files.removePath(projectDir, args.path)
        changed.add(args.path)
        return `Deleted ${args.path}.`
      case 'search_assets': {
        emit({ type: 'status', text: `Searching assets for "${args.query}"…` })
        const type = args.type || 'models'
        const results = type === 'models' ? await assets.searchAllModels(args.query, 10) : await assets.search(args.query, type, 12)
        if (!results.length) return 'No matches. Try a simpler or different word.'
        return results
          .map((a) => `${a.id} | ${a.name} | ${a.source === 'polypizza' ? `low-poly, ${a.license}` : `${a.category}, CC0`}${a.tags.length ? ` | tags: ${a.tags.slice(0, 6).join(', ')}` : ''}`)
          .join('\n')
      }
      case 'add_asset': {
        if (++assetAdds > MAX_ASSET_ADDS) throw new Error(`Limit of ${MAX_ASSET_ADDS} asset downloads per request reached. Use the assets already added.`)
        emit({ type: 'status', text: `Downloading ${args.id}…` })
        const rec = await assets.addAsset(projectDir, { id: args.id, type: args.type, res: '1k', resourcesDir })
        addedAssets.push(rec.name)
        return `Added "${rec.name}" (${Math.round(rec.bytes / 1024)} KB).\nMain file: ${rec.entry}${rec.maps ? `\nMaps: ${JSON.stringify(rec.maps)}` : ''}\nHow to use: ${assets.usageHint(rec, meta.template)}`
      }
      case 'check_game': {
        emit({ type: 'status', text: 'Running the game…' })
        lastCheck = await preview.check()
        emit({ type: 'check', result: summarizeCheck(lastCheck) })
        return formatCheck(lastCheck)
      }
      default:
        throw new Error(`Unknown tool "${name}". Available: ${TOOLS.map((t) => t.function.name).join(', ')}`)
    }
  }

  for (let step = 0; step < (ai.maxSteps || 30); step++) {
    if (signal?.aborted) throw new Error('Stopped.')
    emit({ type: 'status', text: step === 0 ? 'Thinking…' : 'Working…' })
    emit({ type: 'turn_start' })

    const res = await chat(ai, {
      messages,
      tools: TOOLS,
      signal,
      onDelta: (d) => emit({ type: 'delta', ...d })
    })

    let toolCalls = res.toolCalls
    if (!toolCalls.length) {
      const fromText = extractTextToolCalls(res.content)
      if (fromText.length) {
        toolCalls = fromText
        textMode = true
      }
    }
    const { visible } = splitThinking(res.content)

    if (toolCalls.length) {
      if (textMode) {
        messages.push({ role: 'assistant', content: res.content })
      } else {
        messages.push({
          role: 'assistant',
          content: visible || '',
          tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }))
        })
      }
      const textResults = []
      for (const call of toolCalls) {
        if (signal?.aborted) throw new Error('Stopped.')
        let args = {}
        let result
        let ok = true
        try {
          args = parseArgs(call.arguments)
          emit({ type: 'tool_start', id: call.id, name: call.name, args: previewArgs(args) })
          result = await runTool(call.name, args)
        } catch (e) {
          ok = false
          result = `ERROR: ${e.message}`
          if (!args || !Object.keys(args).length) emit({ type: 'tool_start', id: call.id, name: call.name, args: {} })
        }
        emit({ type: 'tool_end', id: call.id, name: call.name, ok, result: String(result).slice(0, 1500) })
        if (textMode) textResults.push(`Result of ${call.name}:\n${result}`)
        else messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: String(result) })
      }
      if (textMode) messages.push({ role: 'user', content: textResults.join('\n\n') })
      continue
    }

    // No tool calls: the model thinks it is done.
    reply = visible || reply
    if ((changed.size || addedAssets.length) && fixRounds < (ai.autoFixRounds ?? 3)) {
      emit({ type: 'status', text: 'Testing the game…' })
      lastCheck = await preview.check()
      emit({ type: 'check', result: summarizeCheck(lastCheck) })
      if (lastCheck.loaded !== undefined && !lastCheck.ok && !isEnvironmentOnly(lastCheck)) {
        fixRounds++
        emit({ type: 'status', text: `Found errors, fixing (attempt ${fixRounds})…` })
        messages.push({ role: 'assistant', content: visible || 'Done.' })
        messages.push({
          role: 'user',
          content: `I ran the game and it has problems:\n${formatCheck(lastCheck)}\n\nFix these errors. Read the relevant files first.`
        })
        continue
      }
    }
    break
  }

  return { reply: reply || 'Done.', changedFiles: [...changed], addedAssets, check: lastCheck ? summarizeCheck(lastCheck) : null }
}

function summarizeCheck(c) {
  if (!c) return null
  if (isEnvironmentOnly(c)) {
    return { ok: false, loaded: c.loaded, note: "3D graphics (WebGL) couldn't start on this computer. Try updating the graphics driver; the game itself is fine.", errors: [] }
  }
  return {
    ok: !!c.ok,
    loaded: c.loaded,
    note: c.note,
    errors: (c.errors || []).map((e) => e.text.slice(0, 500)).slice(0, 10)
  }
}

function previewArgs(args) {
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v
  }
  return out
}
