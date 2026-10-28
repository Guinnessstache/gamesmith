// End-to-end test of the agent loop without a real model:
// a mock OpenAI-compatible server streams scripted tool calls, and a fake
// preview reports an error once so the auto-fix loop is exercised.
//   npm run test:agent
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows needs file:// URLs for dynamic import of absolute paths.
const fileHref = (...parts) => pathToFileURL(join(...parts)).href
const { createProject } = await import(fileHref(root, 'src/main/projects.js'))
const { runAgent, applyEdit } = await import(fileHref(root, 'src/main/agent.js'))
const git = await import(fileHref(root, 'src/main/git.js'))

// ---- unit checks for the edit matcher ----
assert.equal(applyEdit('a\r\nb\r\nc', 'a\nb', 'X').content, 'X\r\nc')
assert.equal(applyEdit('foo  \nbar', 'foo\nbar', 'Y').content, 'Y')
assert.throws(() => applyEdit('x x', 'x', 'y'), /2 times/)
assert.equal(applyEdit('x x', 'x', 'y', true).content, 'y y')
assert.throws(() => applyEdit('abc', 'zzz', 'y'), /not found/)

// ---- scripted mock model ----
const script = [
  { tool: { name: 'read_file', args: { path: 'src/scenes/GameScene.js' } } },
  {
    tool: {
      name: 'edit_file',
      args: {
        path: 'src/scenes/GameScene.js',
        old_text: "    if (left) this.player.setVelocityX(-260)\n    else if (right) this.player.setVelocityX(260)",
        new_text: "    if (left) this.player.setVelocityX(-400)\n    else if (right) this.player.setVelocityX(400)"
      }
    }
  },
  { text: '<think>done?</think>I made the player faster (400 instead of 260).' },
  // after the fake error report, the model replies using Qwen-style text tool calls
  {
    text:
      'Fixing.\n<tool_call>\n' +
      JSON.stringify({ name: 'write_file', arguments: { path: 'src/fix.js', content: 'export const fixed = true\n' } }) +
      '\n</tool_call>'
  },
  { text: 'Fixed the error. Use the arrow keys to run faster.' }
]
let turn = 0
const seenRequests = []

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'mock-qwen' }] }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seenRequests.push(JSON.parse(body))
    const step = script[turn++] || { text: 'Done.' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const sendChunk = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (step.tool) {
      const args = JSON.stringify(step.tool.args)
      sendChunk({ tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool.name, arguments: '' } }] })
      // stream the arguments in small fragments, like real servers do
      for (let i = 0; i < args.length; i += 17) sendChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 17) } }] })
      sendChunk({}, 'tool_calls')
    } else {
      for (let i = 0; i < step.text.length; i += 9) sendChunk({ content: step.text.slice(i, i + 9) })
      sendChunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// ---- fake preview: first check fails, then passes ----
let checks = 0
const preview = {
  async check() {
    checks++
    if (checks === 1) {
      return { ok: false, loaded: true, entries: [{ level: 'error', text: 'TypeError: x is undefined' }], errors: [{ level: 'error', text: 'TypeError: x is undefined' }] }
    }
    return { ok: true, loaded: true, entries: [], errors: [] }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'gs-test-'))
try {
  const proj = await createProject({ projectsDir: tmp, resourcesDir: join(root, 'resources'), name: 'Test Game', templateId: 'phaser-2d' })
  const events = []
  const result = await runAgent({
    projectDir: proj.dir,
    meta: proj,
    ai: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-qwen', maxSteps: 12, autoFixRounds: 3 },
    preview,
    userText: 'Make the player faster',
    emit: (e) => events.push(e)
  })

  const scene = readFileSync(join(proj.dir, 'src/scenes/GameScene.js'), 'utf8')
  assert.match(scene, /setVelocityX\(400\)/, 'edit applied')
  assert.equal(readFileSync(join(proj.dir, 'src/fix.js'), 'utf8'), 'export const fixed = true\n', 'text-mode tool call applied')
  assert.deepEqual(result.changedFiles.sort(), ['src/fix.js', 'src/scenes/GameScene.js'])
  assert.equal(checks, 2, 'auto-check ran twice (fail, then pass)')
  assert.equal(result.reply, 'Fixed the error. Use the arrow keys to run faster.')
  assert.ok(seenRequests[0].messages[0].content.includes('GAME_DESIGN.md'), 'system prompt has design doc')
  assert.ok(seenRequests[0].tools.length === 9, 'tools sent')
  const fixMsg = seenRequests[3].messages.at(-1).content
  assert.match(fixMsg, /TypeError: x is undefined/, 'errors fed back to model')
  assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'edit_file' && e.ok))

  const oid = await git.commitAll(proj.dir, 'AI: faster')
  assert.ok(oid, 'commit created')
  const log = await git.log(proj.dir)
  await git.restore(proj.dir, log[1].oid)
  assert.match(readFileSync(join(proj.dir, 'src/scenes/GameScene.js'), 'utf8'), /setVelocityX\(260\)/, 'restore works')
  assert.throws(() => readFileSync(join(proj.dir, 'src/fix.js')), 'restore removes files added later')

  console.log(`PASS  agent loop: ${turn} model turns, ${checks} game checks, ${events.length} UI events, ${(await git.log(proj.dir)).length} commits`)
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
