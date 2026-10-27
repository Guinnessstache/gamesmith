// The game-building agent. Designed for local 7B–70B models:
//  - small, explicit tools (search/replace edits instead of whole-file rewrites)
//  - compact context (file list + design doc, older turns summarized)
//  - a closed loop: after edits the game is actually run, and any console
//    errors are fed back automatically until it runs clean.
import { chat, extractTextToolCalls, splitThinking } from './aiClient.js'
import * as files from './projects.js'

const MAX_READ_CHARS = 40000
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

function systemPrompt(projectDir, meta) {
  const tree = files
    .walk(projectDir, { skipLib: true })
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

FILES (excluding lib/):
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
      description: 'Read a text file from the project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the project root, e.g. src/main.js' } },
        required: ['path']
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

function formatCheck(result) {
  if (result.note) return result.note
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
export async function runAgent({ projectDir, meta, ai, preview, history = [], userText, emit = () => {}, signal }) {
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

  const runTool = async (name, args) => {
    switch (name) {
      case 'list_files':
        return files
          .walk(projectDir, { skipLib: true })
          .map((f) => `${f.path} (${f.size} bytes)`)
          .join('\n')
      case 'read_file': {
        const text = files.readText(projectDir, args.path)
        return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + `\n\n[truncated: file is ${text.length} chars]` : text
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
    if (changed.size && fixRounds < (ai.autoFixRounds ?? 3)) {
      emit({ type: 'status', text: 'Testing the game…' })
      lastCheck = await preview.check()
      emit({ type: 'check', result: summarizeCheck(lastCheck) })
      if (lastCheck.loaded !== undefined && !lastCheck.ok) {
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

  return { reply: reply || 'Done.', changedFiles: [...changed], check: lastCheck ? summarizeCheck(lastCheck) : null }
}

function summarizeCheck(c) {
  if (!c) return null
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
