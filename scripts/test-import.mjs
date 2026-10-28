// Import + game-server tests.
//   node scripts/test-import.mjs [path-to-a-real-game-repo]
// With a repo path (e.g. a clone of shattered-crown) it imports that game
// through a local git server, installs its packages, starts its own server
// and talks to it through Gamesmith's preview proxy (HTTP + WebSocket).
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import git from 'isomorphic-git'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const importer = await import(join(root, 'src/main/importer.js'))
const { GameServer } = await import(join(root, 'src/main/gameServer.js'))
const { PreviewServer } = await import(join(root, 'src/main/previewServer.js'))
const { WebSocket } = await import('ws')
const realRepo = process.argv[2]
const tmp = mkdtempSync(join(tmpdir(), 'gs-import-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 1. detection ----------
const mk = (name, files) => {
  const d = join(tmp, 'detect', name)
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true })
    writeFileSync(join(d, f), c)
  }
  return d
}
let info = importer.detectProject(mk('static-root', { 'index.html': '<script src="https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js"></script>' }))
assert.deepEqual([info.kind, info.webRoot, info.engine], ['static', '.', 'Phaser'])
info = importer.detectProject(mk('static-docs', { 'docs/index.html': '<html></html>', 'README.md': '#' }))
assert.deepEqual([info.kind, info.webRoot], ['static', 'docs'])
info = importer.detectProject(mk('vite', { 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6', three: '^0.180' } }), 'index.html': '' }))
assert.deepEqual([info.kind, info.runScript, info.usesVite, info.engine, info.webRoot], ['node', 'dev', true, 'Three.js', null])
assert.throws(() => importer.detectProject(mk('nothing', { 'notes.txt': 'hi' })), /Couldn't find how to run/)
assert.deepEqual(importer.servedPaths(['public/index.html', 'public/js/a.js', 'server/x.js'], 'public'), ['index.html', 'js/a.js'])
assert.deepEqual(importer.parseGitHubUrl('https://github.com/Guinnessstache/shattered-crown.git'), { owner: 'Guinnessstache', name: 'shattered-crown' })
console.log('PASS  detection: static root/docs, Vite dev server, engine guess, unrunnable folder')

// ---------- 2. Windows line endings in an existing clone ----------
{
  const d = join(tmp, 'crlf')
  mkdirSync(d)
  await git.init({ fs, dir: d, defaultBranch: 'main' })
  writeFileSync(join(d, 'index.html'), '<html>\n<body>\n</body>\n</html>\n')
  writeFileSync(join(d, 'game.js'), 'let a = 1\nlet b = 2\n')
  await git.add({ fs, dir: d, filepath: '.' })
  await git.commit({ fs, dir: d, message: 'init', author: { name: 't', email: 't@t' } })
  // what Git for Windows (core.autocrlf in its system config) leaves on disk:
  writeFileSync(join(d, 'index.html'), '<html>\r\n<body>\r\n</body>\r\n</html>\r\n')
  writeFileSync(join(d, 'game.js'), 'let a = 1\r\nlet b = 2\r\n')
  const before = (await git.statusMatrix({ fs, dir: d })).filter(([, h, w]) => h !== w).length
  assert.equal(before, 2, 'CRLF files look modified to isomorphic-git')
  const r = await importer.openFolder(d)
  assert.equal(r.lineEndingsFixed, true)
  const after = (await git.statusMatrix({ fs, dir: d })).filter(([f, h, w, s]) => f !== '.gamesmith/project.json' && !(h === 1 && w === 1 && s === 1))
  assert.deepEqual(after, [], 'after the fix nothing looks changed')
  assert.match(readFileSync(join(d, '.git/info/exclude'), 'utf8'), /^\.gamesmith\/$/m, '.gamesmith hidden via info/exclude')
  assert.ok(!existsSync(join(d, '.gitignore')), "the game's own .gitignore is untouched")
  // a real edit (same size, same second) is still saved by Gamesmith's commit
  const localGit = await import(join(root, 'src/main/git.js'))
  writeFileSync(join(d, 'game.js'), 'let a = 1\r\nlet b = 3\r\n')
  const oid = await localGit.commitAll(d, 'edit')
  assert.ok(oid, 'real edit committed')
  const { blob } = await git.readBlob({ fs, dir: d, oid, filepath: 'game.js' })
  assert.equal(Buffer.from(blob).toString(), 'let a = 1\nlet b = 3\n', 'stored with Unix line endings, like Git for Windows does')
  const files = await git.listFiles({ fs, dir: d, ref: oid })
  assert.ok(!files.some((f) => f.startsWith('.gamesmith')), 'Gamesmith data never committed')
  console.log('PASS  open folder: Windows line endings fixed (no false changes), real edits still seen, .gitignore untouched')
}

// ---------- 3. a real game repo with its own server ----------
if (realRepo) {
  // Serve a bare copy over git smart HTTP so import goes through the same clone path as GitHub.
  const remotes = join(tmp, 'remotes')
  mkdirSync(remotes)
  execFileSync('git', ['clone', '-q', '--bare', realRepo, join(remotes, 'shattered-crown.git')])
  const backend = execFileSync('git', ['--exec-path']).toString().trim() + '/git-http-backend'
  const gitServer = http.createServer((req, res) => {
    const [pathInfo, query = ''] = req.url.split('?')
    const child = spawn(backend, [], { env: { GIT_PROJECT_ROOT: remotes, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo, QUERY_STRING: query, REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '' } })
    req.pipe(child.stdin)
    const chunks = []
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('close', () => {
      const buf = Buffer.concat(chunks)
      const sep = buf.indexOf('\r\n\r\n')
      const headers = {}
      let status = 200
      for (const line of buf.slice(0, sep).toString().split('\r\n')) {
        const i = line.indexOf(':')
        if (i < 0) continue
        const k = line.slice(0, i).trim()
        const v = line.slice(i + 1).trim()
        if (k.toLowerCase() === 'status') status = parseInt(v, 10)
        else headers[k] = v
      }
      res.writeHead(status, headers)
      res.end(buf.slice(sep + 4))
    })
  })
  await new Promise((r) => gitServer.listen(0, '127.0.0.1', r))
  process.env.GAMESMITH_CLONE_URL_OVERRIDE = `http://127.0.0.1:${gitServer.address().port}/{name}.git`

  const gs = new GameServer()
  const preview = new PreviewServer()
  try {
    const t0 = Date.now()
    const meta = await importer.importFromGitHub({ ref: 'https://github.com/Guinnessstache/shattered-crown', projectsDir: join(tmp, 'projects') })
    const dir = meta.dir
    assert.equal(meta.name, 'Shattered Crown')
    assert.equal(meta.kind, 'node')
    assert.equal(meta.webRoot, 'public')
    assert.equal(meta.engine, 'Three.js')
    assert.equal(meta.runScript, 'start')
    assert.equal(meta.github.fullName, 'Guinnessstache/shattered-crown')
    assert.ok(existsSync(join(dir, 'server/index.js')) && existsSync(join(dir, 'public/index.html')))
    const status = (await git.statusMatrix({ fs, dir })).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))
    assert.deepEqual(status, [], 'fresh import has no false changes (.gamesmith is excluded)')
    console.log(`PASS  import from GitHub: cloned ${(await git.log({ fs, dir })).length} commits in ${((Date.now() - t0) / 1000).toFixed(1)}s, detected Node server game (Three.js, client in public/)`)

    // Preview in proxy mode + the game's own server
    const logs = []
    gs.on('log', (e) => {
      logs.push(e.text)
      preview.addEntry(e)
    })
    const states = []
    gs.on('status', (st) => {
      states.push(st.state)
      if (st.state === 'running') preview.setUpstream(st.port)
      else if (st.state === 'crashed') preview.setUpstream(0, st.detail, { crashed: true })
    })
    const purl = await preview.start(dir, { proxy: true, onChange: () => {} })
    const waiting = await fetch(purl)
    assert.equal(waiting.status, 503, 'preview shows a "starting" page before the server is up')
    assert.match(await waiting.text(), /__gamesmith\/client\.js/)

    const t1 = Date.now()
    await gs.start(dir, meta)
    assert.equal(gs.state, 'running', `server running (states: ${states.join(' → ')}; last logs: ${logs.slice(-5).join(' | ')})`)
    assert.ok(states.includes('installing'), 'packages installed on first run')
    console.log(`PASS  game server: npm install + npm start in ${((Date.now() - t1) / 1000).toFixed(1)}s, listening on PORT=${gs.port}`)
    assert.ok(logs.some((l) => /Saves: .*db\.json/.test(l)), "server output reaches the console (it's using local JSON saves, no database needed)")

    const page = await fetch(purl)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /__gamesmith\/client\.js/, 'console capture injected into the game page')
    assert.match(html, /<script type="importmap">/, "it's the game's real page")
    const js = await fetch(purl + 'js/main.js')
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
    const three = await fetch(purl + 'vendor/three/build/three.module.js')
    assert.equal(three.status, 200, 'routes the game server adds itself (vendor/three from node_modules) work through the proxy')

    // Socket.io: polling handshake, then a real WebSocket upgrade through the proxy
    const hs = await (await fetch(purl + 'socket.io/?EIO=4&transport=polling')).text()
    const sid = JSON.parse(hs.slice(hs.indexOf('{'))).sid
    assert.ok(sid, 'Socket.io handshake through the proxy')
    const wsUrl = purl.replace('http', 'ws') + 'socket.io/?EIO=4&transport=websocket'
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => resolve(false), 5000)
      ws.on('message', (m) => {
        if (String(m).startsWith('0{')) {
          clearTimeout(timer)
          ws.close()
          resolve(true)
        }
      })
      ws.on('error', () => resolve(false))
    })
    assert.ok(opened, 'WebSocket (Socket.io) upgrade passes through the proxy')
    console.log('PASS  proxy: game page with console capture, JS + server routes, Socket.io polling + WebSocket')

    // Restart, as after the AI edits server code
    const oldPort = gs.port
    await gs.restart()
    assert.equal(gs.state, 'running')
    assert.notEqual(gs.port, oldPort)
    assert.equal((await fetch(purl)).status, 200)

    // Crash: a syntax error in server code
    const serverFile = join(dir, 'server/index.js')
    const good = readFileSync(serverFile, 'utf8')
    writeFileSync(serverFile, good + '\nthis is not javascript(\n')
    await gs.restart()
    await sleep(500)
    assert.equal(gs.state, 'crashed')
    const check = await preview.check()
    assert.equal(check.ok, false)
    assert.ok(check.errors.some((e) => /SyntaxError|Unexpected/.test(e.text)), 'the AI sees the server crash error')
    writeFileSync(serverFile, good)
    await gs.restart()
    assert.equal(gs.state, 'running', 'recovers after the fix')
    console.log('PASS  restart on server-code change; crash surfaces the SyntaxError to the AI; recovers after fix')

    // The AI on an existing codebase: prompt, search, sliced reads
    const { runAgent } = await import(join(root, 'src/main/agent.js'))
    const script = [
      { name: 'search_files', args: { query: 'startServer', path: 'server' } },
      { name: 'read_file', args: { path: 'server/index.js', start_line: 20, end_line: 40 } },
      { name: 'read_file', args: { path: 'public/js/main.js' } }
    ]
    const seen = []
    const mockModel = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        seen.push(JSON.parse(b))
        const step = script.shift()
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = step ? { tool_calls: [{ index: 0, id: `c${seen.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'Found it.' }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise((r) => mockModel.listen(0, '127.0.0.1', r))
    const sc = JSON.parse(readFileSync(join(dir, '.gamesmith/project.json'), 'utf8'))
    await runAgent({ projectDir: dir, meta: sc, ai: { baseUrl: `http://127.0.0.1:${mockModel.address().port}/v1`, model: 'm', maxSteps: 8 }, preview, userText: 'Where does the server start?' })
    mockModel.close()
    const sys = seen[0].messages[0].content
    assert.match(sys, /EXISTING game/)
    assert.match(sys, /npm run start/)
    assert.match(sys, /Browser code lives in public\//)
    assert.match(sys, /README\.md \(start\)/, 'README excerpt included')
    assert.match(sys, /public\/tex\/  \[\d+ asset files/, 'asset folders summarized, not listed file by file')
    assert.doesNotMatch(sys, /node_modules|^ {2}data\//m, 'node_modules and gitignored data/ hidden')
    assert.ok(sys.length < 30000, `system prompt stays compact (${sys.length} chars)`)
    const toolOut = (i) => seen[i].messages.filter((m) => m.role === 'tool').at(-1).content
    assert.match(toolOut(1), /^server\/index\.js:\d+: .*startServer/m, 'search_files finds the definition')
    assert.match(toolOut(2), /^\[server\/index\.js: lines 20-40 of \d+\.[^\]]*\]\n/, 'ranged read returns the requested slice')
    const mainRead = toolOut(3)
    assert.ok(mainRead.length < 60000, 'large file read in a slice, not all at once')
    console.log(`PASS  AI on existing code: compact prompt (${(sys.length / 1000).toFixed(1)}k chars), search_files, sliced reads (${mainRead.split('\n')[0]})`)

    const port = gs.port
    await gs.stop()
    await sleep(500)
    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)
    assert.equal(stillUp, false, 'stopping kills the whole server process tree')
    console.log('PASS  stop: server process tree terminated')
  } finally {
    await gs.stop()
    await preview.stop()
    gitServer.close()
  }
}

rmSync(tmp, { recursive: true, force: true })
