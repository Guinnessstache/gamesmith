// Mock GitHub + Render APIs and a real git smart-HTTP server (git http-backend),
// used by the Electron UI smoke test. Requires git on PATH.
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

function startMockServices(remoteRoot) {
  mkdirSync(remoteRoot, { recursive: true })
  const backend = execFileSync('git', ['--exec-path']).toString().trim() + '/git-http-backend'
  const state = { repos: [], pages: null, render: null }
  let port

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const url = req.url
    if (url.startsWith('/git/')) {
      const [pathInfo, query = ''] = url.slice(4).split('?')
      const child = spawn(backend, [], {
        env: { GIT_PROJECT_ROOT: remoteRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo, QUERY_STRING: query, REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'tester' }
      })
      req.pipe(child.stdin)
      const chunks = []
      child.stdout.on('data', (c) => chunks.push(c))
      child.on('close', () => {
        const buf = Buffer.concat(chunks)
        const sep = buf.indexOf('\r\n\r\n')
        const head = buf.slice(0, sep).toString()
        let status = 200
        const headers = {}
        for (const line of head.split('\r\n')) {
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
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const data = body ? JSON.parse(body) : null
      if (url === '/api/user') {
        if (req.headers.authorization !== 'Bearer ghp_testtoken') return json(res, 401, { message: 'Bad credentials' })
        return json(res, 200, { login: 'Guinnessstache', id: 42, name: 'Jason Thistle', avatar_url: '' })
      }
      if (url === '/api/user/repos' && req.method === 'POST') {
        const dir = join(remoteRoot, `${data.name}.git`)
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
        execFileSync('git', ['--git-dir', dir, 'config', 'http.receivepack', 'true'])
        state.repos.push(data.name)
        return json(res, 201, {
          name: data.name, full_name: `Guinnessstache/${data.name}`, owner: { login: 'Guinnessstache' }, private: data.private,
          html_url: `https://github.com/Guinnessstache/${data.name}`, clone_url: `http://127.0.0.1:${port}/git/${data.name}.git`, default_branch: 'main'
        })
      }
      const pagesUrl = 'https://guinnessstache.github.io/Space-Goats/'
      if (url.endsWith('/pages') && req.method === 'POST') {
        state.pages = { at: Date.now() }
        return json(res, 201, { html_url: pagesUrl, status: null })
      }
      if (url.endsWith('/pages')) return state.pages ? json(res, 200, { html_url: pagesUrl, status: 'built' }) : json(res, 404, { message: 'Not Found' })
      if (url.endsWith('/pages/builds/latest')) return json(res, 200, { status: Date.now() - state.pages.at > 4000 ? 'built' : 'building' })
      if (url.startsWith('/render/owners')) return json(res, req.headers.authorization === 'Bearer rnd_testkey' ? 200 : 401, req.headers.authorization === 'Bearer rnd_testkey' ? [{ owner: { id: 'tea-1', name: 'Jason', type: 'user' } }] : { message: 'Unauthorized' })
      if (url === '/render/services' && req.method === 'POST') {
        state.render = data
        return json(res, 201, { service: { id: 'srv-1', serviceDetails: { url: `https://${data.name}.onrender.com` } } })
      }
      if (url.startsWith('/render/services/srv-1/deploys')) return json(res, 200, [{ deploy: { status: 'live' } }])
      json(res, 404, { message: `no mock for ${req.method} ${url}` })
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve({ server, port, state })
    })
  )
}

module.exports = { startMockServices }
