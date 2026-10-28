// Runs a game's own server (npm start / npm run dev) for games that have one,
// such as multiplayer games with an Express + Socket.io backend.
//
// The server gets a free port through the PORT environment variable. Its output
// goes to the preview console. Gamesmith's preview proxies to it, so console
// capture and the AI's game checks work the same as for static games.
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.setTimeout(1000, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

export function findNpm() {
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['--version'], { shell: isWin, encoding: 'utf8', timeout: 15000 })
  return r.status === 0 ? r.stdout.trim() : null
}

/** Packages need installing if node_modules is missing or older than the lock file / package.json. */
export function needsInstall(dir) {
  if (!fs.existsSync(join(dir, 'package.json'))) return false
  const marker = join(dir, 'node_modules', '.package-lock.json')
  if (!fs.existsSync(join(dir, 'node_modules')) || !fs.existsSync(marker)) return true
  const installed = fs.statSync(marker).mtimeMs
  return ['package.json', 'package-lock.json'].some((f) => fs.existsSync(join(dir, f)) && fs.statSync(join(dir, f)).mtimeMs > installed + 1000)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
}

export class GameServer extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.port = 0
    this.state = 'stopped' // installing | starting | running | crashed | stopped
    this.dir = null
    this.meta = null
    this.generation = 0
  }

  setState(state, detail = '') {
    this.state = state
    this.emit('status', { state, detail, port: this.port })
  }

  log(level, text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) this.emit('log', { level, text: line })
    }
  }

  run(cmd, args, { env = {}, onLine } = {}) {
    const child = spawn(isWin ? `${cmd}.cmd` : cmd, args, {
      cwd: this.dir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      shell: isWin, // npm is a .cmd script on Windows
      detached: !isWin, // own process group, so the whole tree can be stopped
      windowsHide: true
    })
    const forward = (stream, level) => {
      let buf = ''
      stream.on('data', (d) => {
        buf += d.toString()
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\x1b\[[0-9;]*m/g, '')
          buf = buf.slice(nl + 1)
          onLine?.(line)
          if (line.trim()) this.emit('log', { level: level === 'stderr' ? (/error|exception|ERR!|EADDRINUSE|cannot find|failed/i.test(line) ? 'error' : 'warn') : 'info', text: line, server: true })
        }
      })
    }
    forward(child.stdout, 'stdout')
    forward(child.stderr, 'stderr')
    return child
  }

  async install() {
    if (!findNpm()) throw new Error('This game needs Node.js to run its server, and npm was not found. Install Node.js from nodejs.org, then restart Gamesmith.')
    this.setState('installing', 'Installing packages (first time only)…')
    this.log('info', '[gamesmith] npm install')
    const child = this.run('npm', ['install', '--no-audit', '--no-fund'])
    this.child = child
    const code = await new Promise((r) => child.on('close', r))
    this.child = null
    if (code !== 0) throw new Error(`npm install failed (exit code ${code}). See the console for details.`)
  }

  async start(dir, meta, { env = {} } = {}) {
    await this.stop()
    const gen = ++this.generation
    this.dir = dir
    this.meta = meta
    try {
      if (needsInstall(dir)) await this.install()
      if (gen !== this.generation) return
      this.port = await freePort()
      this.setState('starting', `Starting the game server (npm run ${meta.runScript})…`)
      this.log('info', `[gamesmith] npm run ${meta.runScript} (PORT=${this.port})`)
      let announced = null
      const child = this.run('npm', ['run', meta.runScript], {
        env: { PORT: String(this.port), HOST: '127.0.0.1', BROWSER: 'none', ...env },
        // Some servers ignore PORT; notice the port they print instead.
        onLine: (line) => {
          const m = line.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/) || line.match(/\bport\s+(\d{2,5})\b/i)
          if (m) announced = Number(m[1])
        }
      })
      this.child = child
      child.on('close', (code) => {
        if (this.child !== child) return
        this.child = null
        if (gen === this.generation && this.state !== 'stopped') {
          this.log('error', `[gamesmith] The game server stopped (exit code ${code}).`)
          this.setState('crashed', `The game server stopped (exit code ${code}). Check the console, fix the error, and it restarts automatically.`)
        }
      })

      const deadline = Date.now() + 90000
      while (Date.now() < deadline && gen === this.generation && this.child === child) {
        if (await canConnect(this.port)) break
        if (announced && announced !== this.port && (await canConnect(announced))) {
          this.log('warn', `[gamesmith] The server ignored PORT and is using port ${announced}.`)
          this.port = announced
          break
        }
        await sleep(300)
      }
      if (gen !== this.generation || this.child !== child) return
      if (!(await canConnect(this.port))) {
        this.setState('crashed', 'The game server did not start within 90 seconds. Check the console.')
        return
      }
      this.setState('running', `Game server running on port ${this.port}`)
    } catch (e) {
      if (gen === this.generation) {
        this.log('error', e.message)
        this.setState('crashed', e.message)
      }
    }
  }

  async restart() {
    if (this.dir) await this.start(this.dir, this.meta)
  }

  async stop() {
    this.generation++
    const child = this.child
    this.child = null
    if (child) {
      this.setState('stopped')
      killTree(child)
      await Promise.race([new Promise((r) => child.once('close', r)), sleep(3000)])
    }
    this.state = 'stopped'
  }
}
