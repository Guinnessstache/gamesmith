// Tests GitHub sync and publishing against a local git smart-HTTP server
// (git http-backend) plus mock GitHub and Render APIs. Requires git on PATH.
//   npm run test:github
import http from 'node:http'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows needs file:// URLs for dynamic import of absolute paths.
const fileHref = (...parts) => pathToFileURL(join(...parts)).href
const tmp = mkdtempSync(join(tmpdir(), 'gs-gh-'))
const remoteRoot = join(tmp, 'remote')
mkdirSync(remoteRoot)
const backend = execFileSync('git', ['--exec-path']).toString().trim() + '/git-http-backend'

let port
const seen = { authHeaders: new Set(), pagesEnabled: false, renderBody: null }

function gitCgi(req, res, path) {
  const [pathInfo, query = ''] = path.split('?')
  seen.authHeaders.add(req.headers.authorization || 'none')
  const expected = 'Basic ' + Buffer.from('x-access-token:good-token').toString('base64')
  const isCli = /^git\//.test(req.headers['user-agent'] || '')
  if (!isCli && req.headers.authorization !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' })
    return res.end('auth required')
  }
  const child = spawn(backend, [], {
    env: {
      GIT_PROJECT_ROOT: remoteRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: 'tester',
      REMOTE_ADDR: '127.0.0.1'
    }
  })
  req.pipe(child.stdin)
  const chunks = []
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (d) => process.env.DEBUG && console.error('CGI-ERR', String(d)))
  req.on('end', () => process.env.DEBUG && console.error('REQ-END', pathInfo))
  child.on('close', (code) => {
    if (process.env.DEBUG) console.error('CGI-CLOSE', pathInfo, code)
    const buf = Buffer.concat(chunks)
    const sep = buf.indexOf('\r\n\r\n') >= 0 ? buf.indexOf('\r\n\r\n') : buf.indexOf('\n\n')
    const headLen = buf[sep] === 13 ? 4 : 2
    const head = buf.slice(0, sep).toString()
    let status = 200
    const headers = {}
    for (const line of head.split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim()
      if (k.toLowerCase() === 'status') status = parseInt(v, 10)
      else headers[k] = v
    }
    res.writeHead(status, headers)
    res.end(buf.slice(sep + headLen))
  })
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = req.url
  if (process.env.DEBUG) console.error('REQ', req.method, url, req.headers['user-agent'], !!req.headers.authorization)
  if (url.startsWith('/git/')) return gitCgi(req, res, url.slice(4))
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const data = body ? JSON.parse(body) : null
    // ---- GitHub API mock ----
    if (url === '/api/user') {
      if (req.headers.authorization !== 'Bearer good-token') return json(res, 401, { message: 'Bad credentials' })
      return json(res, 200, { login: 'Guinnessstache', id: 42, name: 'Jason', avatar_url: '' })
    }
    if (url === '/api/user/repos' && req.method === 'POST') {
      const dir = join(remoteRoot, `${data.name}.git`)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
      execFileSync('git', ['--git-dir', dir, 'config', 'http.receivepack', 'true'])
      return json(res, 201, {
        name: data.name,
        full_name: `Guinnessstache/${data.name}`,
        owner: { login: 'Guinnessstache' },
        private: data.private,
        html_url: `https://github.com/Guinnessstache/${data.name}`,
        clone_url: `http://127.0.0.1:${port}/git/${data.name}.git`,
        default_branch: 'main'
      })
    }
    if (url.endsWith('/pages') && req.method === 'POST') {
      seen.pagesEnabled = data.source
      return json(res, 201, { html_url: 'https://guinnessstache.github.io/space-goats/', status: null })
    }
    if (url.endsWith('/pages') && req.method === 'GET') return json(res, 200, { html_url: 'https://guinnessstache.github.io/space-goats/', status: 'built' })
    if (url.endsWith('/pages/builds/latest')) return json(res, 200, { status: 'built', error: { message: null } })
    // ---- Render API mock ----
    if (url.startsWith('/render/owners')) return json(res, 200, [{ owner: { id: 'tea-123', name: 'Jason', type: 'user' }, cursor: 'x' }])
    if (url === '/render/services' && req.method === 'POST') {
      seen.renderBody = data
      return json(res, 201, { service: { id: 'srv-abc', slug: data.name, serviceDetails: { url: `https://${data.name}.onrender.com` } }, deployId: 'dep-1' })
    }
    if (url.startsWith('/render/services/srv-abc/deploys')) return json(res, 200, [{ deploy: { id: 'dep-1', status: 'live', finishedAt: '2026-10-27T21:00:00Z' }, cursor: 'x' }])
    json(res, 404, { message: `no mock for ${req.method} ${url}` })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port
process.env.GAMESMITH_GITHUB_API = `http://127.0.0.1:${port}/api`
process.env.GAMESMITH_RENDER_API = `http://127.0.0.1:${port}/render`

const github = await import(fileHref(root, 'src/main/github.js'))
const { createSecretStore } = await import(fileHref(root, 'src/main/secretStore.js'))
const fakeCrypto = { available: async () => true, encrypt: async (t) => Buffer.from('x' + t), decrypt: async (b) => ({ result: b.toString().slice(1) }) }
const deploy = await import(fileHref(root, 'src/main/deploy.js'))
const { createProject } = await import(fileHref(root, 'src/main/projects.js'))

try {
  const ghStore = createSecretStore({ file: join(tmp, 'github.json'), fields: ['token'], ...fakeCrypto })
  await ghStore.load()
  github.configureStore(ghStore)
  const rStore = createSecretStore({ file: join(tmp, 'render.json'), fields: ['key'], ...fakeCrypto })
  await rStore.load()
  deploy.configureRenderStore(rStore)

  await assert.rejects(() => github.signInWithToken('wrong'), /Bad credentials/)
  const account = await github.signInWithToken('good-token')
  assert.equal(account.login, 'Guinnessstache')
  const stored = JSON.parse(readFileSync(join(tmp, 'github.json'), 'utf8'))
  assert.equal(stored.token, 'enc:' + Buffer.from('xgood-token').toString('base64'), 'token encrypted at rest')
  assert.equal(stored.account.login, 'Guinnessstache', 'non-secret fields stay readable')

  const proj = await createProject({ projectsDir: join(tmp, 'projects'), resourcesDir: join(root, 'resources'), name: 'Space Goats', templateId: 'phaser-2d' })
  const repo = await github.createRepo(proj.dir, { name: 'Space Goats', isPrivate: false })
  assert.equal(repo.name, 'Space-Goats')
  assert.equal(await github.unpushedCount(proj.dir), null, 'nothing pushed yet')

  const r1 = await github.sync(proj.dir, { message: 'First upload' })
  const bare = join(remoteRoot, 'Space-Goats.git')
  const remoteHead = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main']).toString().trim()
  assert.equal(remoteHead, r1.commit, 'remote main matches local HEAD after first push')
  const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).toString()
  assert.match(files, /lib\/phaser\/phaser\.min\.js/)
  assert.match(files, /src\/scenes\/GameScene\.js/)
  assert.doesNotMatch(files, /\.gamesmith/, 'app metadata is not uploaded')
  assert.ok([...seen.authHeaders].some((h) => h.startsWith('Basic ')), 'push sent credentials')
  assert.equal(await github.unpushedCount(proj.dir), 0)

  // Someone edits README on "github.com" (simulated with a CLI clone)
  const clone = join(tmp, 'clone')
  await run('git', ['clone', '-q', `http://127.0.0.1:${port}/git/Space-Goats.git`, clone])
  writeFileSync(join(clone, 'README.md'), '# Space Goats\nEdited on GitHub\n')
  execFileSync('git', ['-C', clone, 'add', '.'])
  execFileSync('git', ['-C', clone, '-c', 'user.name=Web', '-c', 'user.email=w@x', 'commit', '-qm', 'Add README on GitHub'])
  await run('git', ['-C', clone, 'push', '-q', 'origin', 'main'])

  // Meanwhile the AI changes a different file locally
  const scenePath = join(proj.dir, 'src/scenes/GameScene.js')
  writeFileSync(scenePath, readFileSync(scenePath, 'utf8').replace('setVelocityX(260)', 'setVelocityX(333)'))
  const r2 = await github.sync(proj.dir, { message: 'Faster player' })
  assert.equal(r2.pulled, 1, 'remote changes were merged in')
  assert.ok(existsSync(join(proj.dir, 'README.md')), 'README from GitHub now exists locally')
  const remoteScene = execFileSync('git', ['--git-dir', bare, 'show', 'main:src/scenes/GameScene.js']).toString()
  assert.match(remoteScene, /setVelocityX\(333\)/, 'local change reached GitHub')
  const remoteReadme = execFileSync('git', ['--git-dir', bare, 'show', 'main:README.md']).toString()
  assert.match(remoteReadme, /Edited on GitHub/, 'GitHub change preserved')

  // Publishing
  const site = await deploy.enablePages('Guinnessstache', 'Space-Goats')
  assert.equal(site.url, 'https://guinnessstache.github.io/space-goats/')
  assert.deepEqual(seen.pagesEnabled, { branch: 'main', path: '/' })
  assert.equal((await deploy.pagesStatus('Guinnessstache', 'Space-Goats')).status, 'built')

  await assert.rejects(() => deploy.renderWorkspaces(), /API key/)
  await deploy.setRenderKey('rnd_test')
  const ws = await deploy.renderWorkspaces()
  assert.deepEqual(ws[0], { id: 'tea-123', name: 'Jason', type: 'user' })
  const rs = await deploy.createRenderSite({ name: 'Space-Goats', ownerId: 'tea-123', repoUrl: repo.htmlUrl })
  assert.equal(rs.url, 'https://space-goats.onrender.com')
  assert.equal(seen.renderBody.serviceDetails.publishPath, './')
  assert.equal(seen.renderBody.repo, 'https://github.com/Guinnessstache/Space-Goats')
  assert.equal((await deploy.renderStatus('srv-abc')).status, 'live')

  console.log('PASS  github: sign-in, create repo, first push, merge remote edit + push, Pages, Render')
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
