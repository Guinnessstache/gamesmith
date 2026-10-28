// Live preview server: serves the game folder over http://127.0.0.1:<port>,
// injects a tiny client that forwards console output and errors back here,
// and hot-reloads the game whenever a file changes.
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import net from 'node:net'
import { WebSocketServer } from 'ws'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

// Runs inside the game page. Kept dependency-free and defensive.
const CLIENT = `(() => {
  if (window.__gamesmith) return; window.__gamesmith = true;
  const q = []; let ws;
  const send = (m) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else q.push(m); } catch (e) {} };
  const str = (v) => {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === 'object' && v !== null) { try { const s = new WeakSet(); return JSON.stringify(v, (k, x) => { if (typeof x === 'object' && x !== null) { if (s.has(x)) return '[circular]'; s.add(x); } return x; }).slice(0, 2000); } catch (e) { return String(v); } }
    return String(v);
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      let parts = args;
      if (typeof args[0] === 'string' && args[0].includes('%c')) {
        const n = (args[0].match(/%c/g) || []).length;
        parts = [args[0].replace(/%c/g, '')].concat(args.slice(1 + n));
      }
      const text = parts.map(str).join(' ').trim();
      if (text) send({ type: 'console', level, text });
    };
  });
  addEventListener('error', (e) => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      send({ type: 'console', level: 'error', text: 'Failed to load ' + (e.target.src || e.target.href) });
      return;
    }
    send({ type: 'console', level: 'error', text: (e.error && e.error.stack) || e.message, source: e.filename, line: e.lineno, col: e.colno });
  }, true);
  addEventListener('unhandledrejection', (e) => send({ type: 'console', level: 'error', text: 'Unhandled promise rejection: ' + str(e.reason) }));
  addEventListener('load', () => send({ type: 'loaded' }));
  const connect = () => {
    ws = new WebSocket('ws://' + location.host + '/__gamesmith/ws');
    ws.onopen = () => q.splice(0).forEach((m) => ws.send(JSON.stringify(m)));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'reload') location.reload(); };
    ws.onclose = () => setTimeout(connect, 1000);
  };
  connect();
})();`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class PreviewServer extends EventEmitter {
  constructor() {
    super()
    this.dir = null
    this.server = null
    this.wss = null
    this.watcher = null
    this.port = 0
    this.entries = []
    this.loadedAt = 0
    this.reloadTimer = null
    this.autoReload = true
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/` : null
  }

  get clientCount() {
    return this.wss ? [...this.wss.clients].filter((c) => c.readyState === 1).length : 0
  }

  /**
   * dir: project folder. Options:
   *  webRoot  — serve this subfolder (static games whose index.html isn't at the top)
   *  proxy    — true for games with their own server: requests are forwarded to
   *             the port given by setUpstream(); until then a "starting" page is shown
   *  onChange — called with each changed path instead of reloading the page
   */
  async start(dir, { webRoot = null, proxy = false, onChange = null } = {}) {
    await this.stop()
    this.dir = dir
    this.root = webRoot && webRoot !== '.' ? join(dir, webRoot) : dir
    this.proxy = proxy
    this.upstream = 0
    this.serverNote = 'Starting the game server…'
    this.onChange = onChange
    this.entries = []
    this.server = http.createServer((req, res) => (this.proxy ? this.forward(req, res) : this.handle(req, res)))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url.startsWith('/__gamesmith/ws')) {
        return this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('message', (raw) => this.onClientMessage(raw))
        })
      }
      if (this.proxy && this.upstream) return this.forwardUpgrade(req, socket, head)
      socket.destroy()
    })
    await new Promise((res, rej) => {
      this.server.once('error', rej)
      this.server.listen(0, '127.0.0.1', res)
    })
    this.port = this.server.address().port

    try {
      this.watcher = watch(dir, { recursive: true }, (_evt, file) => {
        if (!file) return
        const f = String(file).replace(/\\/g, '/')
        if (/^(\.git|\.gamesmith|node_modules)(\/|$)/.test(f)) return
        this.emit('files-changed', f)
        if (this.onChange) this.onChange(f)
        else if (this.autoReload) this.scheduleReload()
      })
    } catch (e) {
      console.warn('[preview] file watching unavailable:', e.message)
    }
    return this.url
  }

  async stop() {
    clearTimeout(this.reloadTimer)
    this.watcher?.close()
    this.watcher = null
    if (this.wss) for (const c of this.wss.clients) c.terminate()
    this.wss?.close()
    this.wss = null
    if (this.server) {
      // The preview iframe holds keep-alive connections open; without closing
      // them, server.close() can wait forever and "‹ Games" appears frozen.
      const server = this.server
      const closed = new Promise((r) => server.close(() => r()))
      server.closeAllConnections?.()
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1500))])
    }
    this.server = null
    this.port = 0
  }

  scheduleReload() {
    clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => this.reload(), 200)
  }

  reload() {
    clearTimeout(this.reloadTimer)
    // Page output starts fresh; the game server's own log carries over.
    this.entries = this.entries.filter((e) => e.server).slice(-80)
    this.loadedAt = 0
    this.emit('reloading')
    if (!this.wss) return
    for (const c of this.wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'reload' }))
  }

  addEntry(entry) {
    const e = { time: Date.now(), ...entry }
    this.entries.push(e)
    if (this.entries.length > 500) this.entries.shift()
    this.emit('console', e)
  }

  onClientMessage(raw) {
    let m
    try {
      m = JSON.parse(String(raw))
    } catch {
      return
    }
    if (m.type === 'loaded') {
      this.loadedAt = Date.now()
      this.emit('loaded')
    } else if (m.type === 'console') {
      let text = String(m.text || '')
      if (m.source) {
        const src = m.source.replace(this.url || '', '')
        text += `\n    at ${src}:${m.line}:${m.col}`
      }
      this.addEntry({ level: m.level, text: text.slice(0, 4000) })
    }
  }

  /**
   * Reload the game and collect what it logs during the first moments of play.
   * This is what the AI calls to see whether its changes actually work.
   */
  async check({ settleMs = 1500, timeoutMs = 8000 } = {}) {
    if (!this.server) return { ok: false, note: 'No project is open.', entries: [] }
    if (this.proxy) {
      // A code change may have just triggered a server restart; give it time.
      await sleep(900)
      const until = Date.now() + 60000
      while (!this.upstream && !this.serverCrashed && Date.now() < until) await sleep(250)
    }
    if (this.proxy && !this.upstream) {
      // Hand over the server's last output: the file/line/stack around a crash is what fixes it.
      const tail = this.entries.filter((e) => e.server).slice(-25).map((e) => e.text).join('\n')
      const errors = [{ level: 'error', text: `The game server is not running. ${this.serverNote || ''}\nLast server output:\n${tail || '(none)'}` }]
      return { ok: false, loaded: false, entries: [...this.entries], errors }
    }
    if (this.clientCount === 0) {
      return { ok: false, note: 'The game preview is not open, so the game could not be run.', entries: [] }
    }
    await sleep(300) // let pending file writes and the watcher settle
    const since = Date.now()
    this.reload()
    const start = Date.now()
    while (!this.loadedAt && Date.now() - start < timeoutMs) await sleep(100)
    const loaded = !!this.loadedAt
    await sleep(settleMs)
    const entries = this.entries.filter((e) => e.time >= since)
    const errors = entries.filter((e) => e.level === 'error')
    return { ok: loaded && errors.length === 0, loaded, entries, errors }
  }

  // ---------- proxy mode (games with their own server) ----------
  setUpstream(port, note = '', { crashed = false } = {}) {
    this.upstream = port
    this.serverNote = note
    this.serverCrashed = crashed
  }

  injectClient(html) {
    const tag = '<script src="/__gamesmith/client.js"></script>'
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`) : tag + html
  }

  waitingPage(res) {
    const note = String(this.serverNote || 'Starting the game server…').replace(/[<>&]/g, '')
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(this.injectClient(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#11161f;color:#9fb0cc;font:15px system-ui,sans-serif}p{max-width:46ch;text-align:center;line-height:1.5}</style></head><body><p>${note}<br><small>The console below shows the server's output.</small></p><script>setTimeout(()=>location.reload(),2000)</script></body></html>`))
  }

  forward(req, res) {
    if (req.url === '/__gamesmith/client.js') return this.handle(req, res)
    if (!this.upstream) return this.waitingPage(res)
    const headers = { ...req.headers, host: `127.0.0.1:${this.upstream}`, 'accept-encoding': 'identity' }
    const up = http.request({ host: '127.0.0.1', port: this.upstream, method: req.method, path: req.url, headers }, (upRes) => {
      const type = String(upRes.headers['content-type'] || '')
      if (upRes.statusCode === 404 && !/favicon/.test(req.url)) {
        this.addEntry({ level: 'error', text: `404 Not Found: ${req.url.split('?')[0]} (the game server has nothing at this address)` })
      }
      if (type.includes('text/html')) {
        const chunks = []
        upRes.on('data', (c) => chunks.push(c))
        upRes.on('end', () => {
          const body = Buffer.from(this.injectClient(Buffer.concat(chunks).toString('utf8')))
          const h = { ...upRes.headers, 'content-length': body.length, 'cache-control': 'no-store' }
          delete h['transfer-encoding']
          res.writeHead(upRes.statusCode, h)
          res.end(body)
        })
        return
      }
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) this.waitingPage(res)
      else res.destroy()
    })
    req.pipe(up)
  }

  /** WebSockets (e.g. Socket.io) pass straight through to the game server. */
  forwardUpgrade(req, socket, head) {
    const up = net.connect(this.upstream, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${this.upstream}` : req.rawHeaders[i + 1]}`)
      }
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const close = () => {
      up.destroy()
      socket.destroy()
    }
    up.on('error', close)
    socket.on('error', close)
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x')
      let p = decodeURIComponent(url.pathname)
      if (p === '/__gamesmith/client.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' })
        return res.end(CLIENT)
      }
      if (p.endsWith('/')) p += 'index.html'
      const abs = normalize(join(this.root, p))
      if (!abs.startsWith(normalize(this.root + sep)) && abs !== normalize(this.root)) {
        res.writeHead(403)
        return res.end('Forbidden')
      }
      const rel = abs.slice(this.root.length + 1).replace(/\\/g, '/')
      if (rel.startsWith('.git/') || rel.startsWith('.gamesmith/')) {
        res.writeHead(404)
        return res.end('Not found')
      }
      let s
      try {
        s = await stat(abs)
      } catch {
        s = null
      }
      if (!s || !s.isFile()) {
        if (!p.endsWith('favicon.ico')) {
          this.addEntry({ level: 'error', text: `404 Not Found: ${p} (the file does not exist in the project)` })
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        return res.end('Not found')
      }
      const ext = extname(abs).toLowerCase()
      let body = await readFile(abs)
      if (ext === '.html') {
        const tag = '<script src="/__gamesmith/client.js"></script>'
        let html = body.toString('utf8')
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`) : tag + html
        body = Buffer.from(html)
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      res.end(body)
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  }
}
