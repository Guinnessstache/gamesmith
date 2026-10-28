// Updates from GitHub Releases.
//  - Installed app: electron-updater (download in the background, verify against the release's
//    latest.yml checksum, install on restart).
//  - Running from source (npm run dev): no updates; update the code with git instead.
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Loaded only when updates are used, so a copy without the package (no npm install yet) still starts.
// Note: autoUpdater is created on first access, so only touch it when it's used.
const loadUpdater = () => createRequire(import.meta.url)('electron-updater')
export const REPO = { owner: 'Guinnessstache', repo: 'gamesmith' }

const stripHtml = (s) =>
  String(s || '')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000)

export class Updater extends EventEmitter {
  /**
   * opts: { packaged, version, fetchImpl, feedUrl (tests: a generic update server), apiBase (tests) }
   */
  constructor({ packaged, version, feedUrl = process.env.GAMESMITH_UPDATE_URL } = {}) {
    super()
    this.version = version
    this.mode = packaged || feedUrl ? 'installed' : 'source'
    this.status = { state: this.mode === 'source' ? 'source' : 'idle', version, mode: this.mode }
    if (this.mode === 'installed') {
      const electronUpdater = loadUpdater()
      this.u = feedUrl ? new electronUpdater.NsisUpdater({ provider: 'generic', url: feedUrl }) : electronUpdater.autoUpdater
      if (feedUrl) {
        this.u.forceDevUpdateConfig = true
        // Unpackaged runs (tests) need the update config the installer would carry.
        const cfg = join(tmpdir(), `gamesmith-update-${process.pid}.yml`)
        writeFileSync(cfg, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: gamesmith-updater-test\n`)
        this.u.updateConfigPath = cfg
        // Tests run unpackaged, where Electron reports its own version: use ours.
        if (version) this.u.currentVersion = new this.u.currentVersion.constructor(version)
      }
      this.u.autoDownload = false
      this.u.autoInstallOnAppQuit = true
      this.u.logger = null
      this.u.on('update-available', (i) => this.set({ state: 'available', latest: i.version, notes: stripHtml(i.releaseNotes), date: i.releaseDate }))
      this.u.on('update-not-available', () => this.set({ state: 'current' }))
      this.u.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent), bytes: p.transferred, total: p.total }))
      this.u.on('update-downloaded', (i) => this.set({ state: 'ready', latest: i.version }))
      this.u.on('error', (e) => this.set({ state: 'error', error: friendly(e) }))
    }
  }

  set(patch) {
    this.status = { ...this.status, ...patch, version: this.version, mode: this.mode, checked: Date.now() }
    if (patch.state !== 'error') delete this.status.error
    this.emit('status', this.status)
  }

  async check() {
    this.set({ state: 'checking' })
    try {
      if (this.mode === 'installed') {
        await this.u.checkForUpdates()
        return this.status
      }
      this.set({ state: 'source' })
    } catch (e) {
      this.set({ state: 'error', error: friendly(e) })
    }
    return this.status
  }

  async download() {
    if (this.mode !== 'installed') throw new Error('This copy runs from source. Update it with git pull and npm install.')
    this.set({ state: 'downloading', percent: 0 })
    await this.u.downloadUpdate()
    return this.status
  }

  install() {
    if (this.status.state !== 'ready') throw new Error('The update has not finished downloading.')
    setImmediate(() => this.u.quitAndInstall(false, true)) // install, then reopen Gamesmith
  }
}

function friendly(e) {
  const msg = String(e?.message || e)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo|network/i.test(msg)) return "Couldn't reach GitHub to check for updates. Check your internet connection."
  if (/sha512|checksum/i.test(msg)) return "The update didn't download correctly (checksum mismatch). Try again."
  if (/404|latest\.yml/i.test(msg)) return "The newest release doesn't have an installer yet. Try again in a few minutes."
  return msg.split('\n')[0].slice(0, 300)
}
