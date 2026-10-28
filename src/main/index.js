import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage, net, protocol, session } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { getSettings, setSettings, AI_PRESETS } from './settings.js'
import * as projects from './projects.js'
import * as git from './git.js'
import { PreviewServer } from './previewServer.js'
import { listModels } from './aiClient.js'
import { runAgent } from './agent.js'
import * as github from './github.js'
import * as deploy from './deploy.js'
import * as assets from './assets.js'
import { createSecretStore } from './secretStore.js'
import * as importer from './importer.js'
import { GameServer } from './gameServer.js'
import * as blender from './blender.js'
import * as library from './library.js'
import { runModelAgent } from './modelAgent.js'
import * as mocap from './mocap.js'
import { Updater } from './updater.js'
import isoGit from 'isomorphic-git'
import nodeFs from 'node:fs'

// gsassets:// serves the body-tracking engine and model to the UI (works the same in dev and installed builds).
protocol.registerSchemesAsPrivileged([{ scheme: 'gsassets', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')

let win = null
const preview = new PreviewServer()
const gameServer = new GameServer()
let current = null // { dir, meta }

// Games with their own server: show its output in the console, and point the preview at it.
gameServer.on('log', (e) => preview.addEntry(e))
gameServer.on('status', (st) => {
  send('server:status', st)
  if (st.state === 'running') {
    preview.setUpstream(st.port)
    preview.reload()
  } else if (st.state === 'crashed') preview.setUpstream(0, st.detail, { crashed: true })
  else if (st.state !== 'stopped') preview.setUpstream(0, st.detail)
})

const CODE = /\.(m?js|cjs|ts|mts|json)$/i
let restartTimer = null
let reloadTimer = null
/** For games with a server: restart it when server code changes, reload the page for anything else. */
async function onServerGameChange(dir, meta, file) {
  const ignored = await isoGit.isIgnored({ fs: nodeFs, dir, filepath: file }).catch(() => false)
  if (ignored) return // e.g. the game writing its own save data
  const inWeb = meta.webRoot && (file === meta.webRoot || file.startsWith(meta.webRoot + '/'))
  const viteHandles = meta.usesVite && !/^(package(-lock)?\.json|vite\.config\.\w+)$/.test(file)
  if (viteHandles) return // Vite's dev server hot-reloads on its own
  if (!inWeb && (CODE.test(file) || file === 'package.json')) {
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => gameServer.restart(), 400)
  } else {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => preview.reload(), 250)
  }
}

async function startPreview(dir, meta) {
  await gameServer.stop()
  if (meta.kind === 'node') {
    const url = await preview.start(dir, { proxy: true, onChange: (f) => onServerGameChange(dir, meta, f) })
    gameServer.start(dir, meta) // installs packages if needed; status events update the preview
    return url
  }
  return preview.start(dir, { webRoot: meta.webRoot })
}
let agentAbort = null

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

preview.on('console', (e) => send('preview:console', e))
preview.on('reloading', () => send('preview:reloading'))
preview.on('files-changed', (f) => send('files:changed', f))

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0e1116',
    title: 'Gamesmith',
    icon: join(resourcesDir, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // Links inside the app open in the user's real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// ---------- helpers ----------
function requireProject() {
  if (!current) throw new Error('No project is open')
  return current
}
const chatFile = (dir) => join(dir, '.gamesmith', 'chat.json')
function loadChat(dir) {
  try {
    return JSON.parse(readFileSync(chatFile(dir), 'utf8'))
  } catch {
    return []
  }
}
function saveChat(dir, turns) {
  mkdirSync(join(dir, '.gamesmith'), { recursive: true })
  writeFileSync(chatFile(dir), JSON.stringify(turns.slice(-200), null, 2))
}

// Wrap handlers so errors reach the UI as { error } instead of crashing.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
}

// ---------- settings & AI ----------
handle('settings:get', () => ({ settings: getSettings(), presets: AI_PRESETS }))
handle('settings:set', (patch) => {
  const s = setSettings(patch)
  if (patch.libraryDir) library.configure(s.libraryDir)
  if (patch.blender) blenderInfo = null
  return s
})
handle('ai:models', (aiOverride) => listModels({ ...getSettings().ai, ...(aiOverride || {}) }))
handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

// ---------- projects ----------
handle('projects:list', () => {
  const s = getSettings()
  const inFolder = projects.listProjects(s.projectsDir)
  const seen = new Set(inFolder.map((p) => p.dir))
  const external = (s.externalProjects || [])
    .filter((d) => !seen.has(d) && existsSync(join(d, '.gamesmith', 'project.json')))
    .map((d) => {
      try {
        return { ...projects.readMeta(d), dir: d, modified: nodeFs.statSync(d).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return [...inFolder, ...external].sort((a, b) => b.modified - a.modified)
})
handle('projects:importGitHub', async (ref) => {
  return importer.importFromGitHub({
    ref,
    projectsDir: getSettings().projectsDir,
    token: github.getToken(),
    onProgress: (p) => send('import:progress', p)
  })
})
handle('projects:githubRepos', () => github.listRepos())
handle('projects:importHtml', async (filePath) => {
  let file = filePath
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an HTML game file', properties: ['openFile'], filters: [{ name: 'Web page', extensions: ['html', 'htm'] }] })
    if (r.canceled) return null
    file = r.filePaths[0]
  }
  return importer.importHtmlFile({ file, projectsDir: getSettings().projectsDir })
})
handle('projects:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a game folder', properties: ['openDirectory'] })
  if (r.canceled) return null
  const dir = r.filePaths[0]
  const out = await importer.openFolder(dir)
  const s = getSettings()
  if (!dir.startsWith(s.projectsDir)) setSettings({ externalProjects: [...new Set([...(s.externalProjects || []), dir])] })
  return out
})
handle('projects:templates', () => projects.listTemplates(resourcesDir))
handle('projects:create', async ({ name, templateId }) =>
  projects.createProject({ projectsDir: getSettings().projectsDir, resourcesDir, name, templateId })
)
handle('projects:open', async (dir) => {
  if (!existsSync(join(dir, '.gamesmith', 'project.json'))) throw new Error('Not a Gamesmith project')
  agentAbort?.abort()
  await git.ensureRepo(dir)
  const meta = projects.readMeta(dir)
  current = { dir, meta }
  const url = await startPreview(dir, meta)
  return { dir, meta, url, chat: loadChat(dir), server: meta.kind === 'node' ? { state: gameServer.state } : null }
})
handle('projects:close', async () => {
  agentAbort?.abort()
  await gameServer.stop()
  await preview.stop()
  current = null
})
handle('server:restart', () => gameServer.restart())
handle('projects:reveal', (rel) => {
  const { dir } = requireProject()
  shell.openPath(rel ? projects.safePath(dir, rel) : dir)
})
handle('preview:openExternal', () => preview.url && shell.openExternal(preview.url))
handle('preview:reload', () => preview.reload())

// ---------- files ----------
handle('fs:list', () => projects.walk(requireProject().dir))
handle('fs:read', (rel) => projects.readText(requireProject().dir, rel))
handle('fs:write', (rel, content) => projects.writeText(requireProject().dir, rel, content))
handle('fs:delete', (rel) => projects.removePath(requireProject().dir, rel))
handle('fs:move', (from, to) => projects.movePath(requireProject().dir, from, to))
handle('fs:import', async (targetFolder = 'assets') => {
  const { dir } = requireProject()
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled) return []
  const added = []
  for (const p of r.filePaths) {
    const name = p.split(/[\\/]/).pop()
    projects.writeBinary(dir, `${targetFolder}/${name}`, readFileSync(p))
    added.push(`${targetFolder}/${name}`)
  }
  return added
})

// ---------- history ----------
handle('git:log', () => git.log(requireProject().dir))
handle('git:snapshot', (msg) => git.commitAll(requireProject().dir, msg || 'Manual save'))
handle('git:restore', async (oid) => {
  const r = await git.restore(requireProject().dir, oid)
  preview.reload()
  return r
})

// ---------- AI agent ----------
handle('chat:clear', () => saveChat(requireProject().dir, []))
handle('agent:stop', () => agentAbort?.abort())
handle('agent:run', async (userText) => {
  const { dir, meta } = requireProject()
  if (agentAbort) throw new Error('The AI is already working')
  const ai = getSettings().ai
  const history = loadChat(dir)
  agentAbort = new AbortController()
  const steps = []
  const emit = (ev) => {
    if (ev.type === 'tool_start') steps.push({ id: ev.id, name: ev.name, path: ev.args?.path || '', ok: null })
    if (ev.type === 'tool_end') {
      const s = steps.find((x) => x.id === ev.id)
      if (s) s.ok = ev.ok
    }
    send('agent:event', ev)
  }

  history.push({ role: 'user', content: userText, time: Date.now() })
  saveChat(dir, history)
  await git.commitAll(dir, 'Your edits (before AI)')

  try {
    const result = await runAgent({
      projectDir: dir,
      meta,
      ai,
      preview,
      history: history.slice(0, -1),
      userText,
      emit,
      signal: agentAbort.signal,
      resourcesDir
    })
    const label = userText.replace(/\s+/g, ' ').slice(0, 72)
    const oid = await git.commitAll(dir, `AI: ${label}`)
    history.push({ role: 'assistant', content: result.reply, time: Date.now(), changedFiles: result.changedFiles, addedAssets: result.addedAssets, check: result.check, commit: oid, steps })
    saveChat(dir, history)
    emit({ type: 'done', ...result, commit: oid })
    return { ...result, commit: oid, steps }
  } catch (e) {
    const oid = await git.commitAll(dir, `AI (stopped): ${userText.slice(0, 60)}`).catch(() => null)
    history.push({ role: 'assistant', content: `⚠ ${e.message}`, time: Date.now(), error: true, commit: oid, steps })
    saveChat(dir, history)
    emit({ type: 'error', message: e.message })
    throw e
  } finally {
    agentAbort = null
  }
})

// ---------- assets ----------
handle('assets:search', (query, type, source) => assets.search(query, type, 48, source || 'polyhaven'))
handle('assets:polyPizzaStatus', () => assets.polyPizza.hasKey())
handle('assets:setPolyPizzaKey', (key) => assets.polyPizza.setKey(key))
handle('assets:plan', (id, type, res) => assets.plan(id, type, res))
handle('assets:list', () => assets.readManifest(requireProject().dir).assets)
handle('assets:add', async ({ id, type, res }) => {
  const { dir } = requireProject()
  const rec = await assets.addAsset(dir, { id, type, res, resourcesDir, onProgress: (p) => send('assets:progress', p) })
  await git.commitAll(dir, `Added ${rec.name} from ${rec.source}`)
  return rec
})
handle('assets:importZip', async () => {
  const { dir } = requireProject()
  const r = await dialog.showOpenDialog(win, { title: 'Import an asset pack', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Zip archives', extensions: ['zip'] }] })
  if (r.canceled) return []
  const out = []
  for (const p of r.filePaths) out.push(assets.importZip(dir, p))
  await git.commitAll(dir, `Imported ${out.map((x) => x.name).join(', ')}`)
  return out
})
handle('assets:remove', async (id) => {
  const { dir } = requireProject()
  assets.removeAsset(dir, id)
  await git.commitAll(dir, `Removed asset ${id}`)
})

// ---------- GitHub ----------
function secretStore(name, fields) {
  // Electron 45+: async safeStorage. Uses Windows DPAPI / macOS Keychain / libsecret.
  return createSecretStore({
    file: join(app.getPath('userData'), name),
    fields,
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: (buf) => safeStorage.decryptStringAsync(buf)
  })
}

let deviceAbort = null
let deviceFlowId = 0
handle('github:account', () => github.getAccount())
handle('github:signInToken', (token) => github.signInWithToken(token))
handle('github:signOut', async () => github.signOut())
// Gets a code and starts waiting for approval. The code is shown in the app
// first; GitHub opens only when the user clicks (github:openVerification), so
// the browser doesn't cover the code.
handle('github:deviceStart', async () => {
  const clientId = getSettings().github?.clientId
  if (!clientId) throw new Error('No GitHub OAuth App client ID is set. Use a token instead, or add a client ID in Settings.')
  deviceAbort?.abort()
  const controller = new AbortController()
  deviceAbort = controller
  const id = ++deviceFlowId
  const flow = await github.startDeviceFlow(clientId)
  clipboard.writeText(flow.user_code)
  github
    .pollDeviceFlow(clientId, flow, controller.signal)
    .then((account) => send('github:auth', { id, ok: true, account }))
    .catch((e) => {
      // A flow replaced by a newer one, or cancelled by the user, ends quietly.
      if (controller.signal.aborted) return
      send('github:auth', { id, ok: false, error: e.message })
    })
  return { id, userCode: flow.user_code, verificationUri: flow.verification_uri, expiresIn: flow.expires_in }
})
handle('github:openVerification', (url) => /^https:\/\/github\.com\//.test(url) && shell.openExternal(url))
handle('github:deviceCancel', () => deviceAbort?.abort())

// ---------- publishing ----------
handle('publish:status', async () => {
  const { dir } = requireProject()
  const meta = projects.readMeta(dir)
  const authExpired = github.getToken() ? !(await github.tokenWorks()) : false
  const out = {
    account: authExpired ? null : github.getAccount(),
    authExpired,
    hasRenderKey: !!deploy.getRenderKey(),
    repo: meta.github || null,
    lastSync: meta.lastSync || null,
    unpushed: meta.github ? await github.unpushedCount(dir) : null,
    pages: meta.pages || null,
    render: meta.render || null,
    kind: meta.kind || 'static',
    webRoot: meta.webRoot || null
  }
  // Imported games may already be deployed on Render (e.g. a web service with its own server).
  if (!out.render && out.hasRenderKey && meta.github && !renderLookupDone.has(dir)) {
    renderLookupDone.add(dir)
    const found = await deploy.findRenderService(meta.github.htmlUrl).catch(() => null)
    if (found) {
      projects.updateMeta(dir, { render: found })
      out.render = found
    }
  }
  if (out.pages && out.account) out.pages = { ...out.pages, ...(await deploy.pagesStatus(meta.github.owner, meta.github.name).catch((e) => ({ status: 'unknown', error: e.message }))) }
  if (out.render && out.hasRenderKey) out.render = { ...out.render, ...(await deploy.renderStatus(meta.render.serviceId).catch((e) => ({ status: 'unknown', error: e.message }))) }

  // Once a host reports the deploy finished, check every file actually loads (once per deployed commit).
  const hosts = [
    ['pages', out.pages?.status === 'built'],
    ['render', out.render?.status === 'live']
  ]
  for (const [host, done] of hosts) {
    if (!done) continue
    out[host].verify = await verifyHost(dir, host, out[host].url).catch((e) => ({ error: e.message }))
  }
  return out
})

const renderLookupDone = new Set()
const verifyCache = new Map() // `${dir}|${host}|${oid}` -> { result, until }
const SETTLE_MS = 10 * 60 * 1000 // hosts can report "live" for the old version for a few minutes after a save
async function verifyHost(dir, host, url, force = false) {
  const { oid, files } = await git.deployedFiles(dir)
  const key = `${dir}|${host}|${oid}`
  const cached = verifyCache.get(key)
  if (!force && cached && Date.now() < cached.until) return cached.result
  const meta = projects.readMeta(dir)
  const paths = meta.kind === 'node' ? [''] : deploy.publicFiles(importer.servedPaths(files, meta.webRoot))
  const result = await deploy.verifySite(url, paths)
  // Missing files right after a save are almost always the new version still going live:
  // say so, and look again shortly instead of reporting a problem.
  const sinceSave = Date.now() - (meta.lastSync || 0)
  if (result.failed.length && sinceSave < SETTLE_MS) {
    result.pending = true
    result.settlesIn = SETTLE_MS - sinceSave
  }
  verifyCache.set(key, { result, until: result.pending ? Date.now() + 15000 : Infinity })
  return result
}
handle('publish:recheck', async (host) => {
  const { dir } = requireProject()
  const meta = projects.readMeta(dir)
  const url = host === 'pages' ? meta.pages?.url : meta.render?.url
  if (!url) throw new Error('This game is not published there yet')
  return verifyHost(dir, host, url, true)
})
handle('publish:createRepo', async ({ name, isPrivate }) => {
  const { dir } = requireProject()
  const repo = await github.createRepo(dir, { name, isPrivate, description: `${current.meta.name}, made with Gamesmith` })
  projects.updateMeta(dir, { github: repo })
  const r = await github.sync(dir, { message: 'First upload from Gamesmith' })
  projects.updateMeta(dir, { lastSync: r.time })
  return repo
})
handle('publish:linkRepo', async (ref) => {
  const { dir } = requireProject()
  const repo = await github.linkRepo(dir, ref)
  projects.updateMeta(dir, { github: repo })
  return repo
})
handle('publish:sync', async (message) => {
  const { dir } = requireProject()
  const r = await github.sync(dir, { message: message || 'Saved from Gamesmith' })
  projects.updateMeta(dir, { lastSync: r.time })
  if (r.pulled) preview.reload()
  return r
})
handle('publish:enablePages', async () => {
  const { dir } = requireProject()
  const meta = projects.readMeta(dir)
  const repo = meta.github
  if (!repo) throw new Error('Save the game to GitHub first')
  if (meta.kind === 'node') throw new Error("This game runs its own server, which GitHub Pages can't host. Use Render instead.")
  const root = meta.webRoot && meta.webRoot !== '.' ? meta.webRoot : null
  if (root && root !== 'docs') throw new Error(`GitHub Pages can only publish the top folder or docs/, and this game lives in ${root}/. Use Render instead.`)
  const site = await deploy.enablePages(repo.owner, repo.name, { branch: await git.branch(dir), path: root ? '/docs' : '/' })
  projects.updateMeta(dir, { pages: { url: site.url } })
  return site
})
handle('render:setKey', async (key) => {
  if (key) await deploy.renderWorkspaces(key) // validate before saving
  await deploy.setRenderKey(key)
  return !!key
})
handle('render:workspaces', () => deploy.renderWorkspaces())
handle('publish:createRender', async (ownerId) => {
  const { dir, meta } = requireProject()
  const m = projects.readMeta(dir)
  const repo = m.github
  if (!repo) throw new Error('Save the game to GitHub first')
  if (m.kind === 'node') {
    const existing = await deploy.findRenderService(repo.htmlUrl)
    if (!existing) {
      throw new Error("This game runs its own server, so it needs a Render web service rather than a static site. Gamesmith can't create those yet: in Render choose New → Web Service (or New → Blueprint if the repo has render.yaml), pick this repo, then come back and click Find my Render service.")
    }
    projects.updateMeta(dir, { render: existing })
    return existing
  }
  const site = await deploy.createRenderSite({
    name: repo.name || meta.name,
    ownerId,
    repoUrl: repo.htmlUrl,
    branch: await git.branch(dir),
    publishPath: m.webRoot && m.webRoot !== '.' ? m.webRoot : './'
  })
  projects.updateMeta(dir, { render: site })
  return site
})
// ---------- Blender + your asset library ----------
const runnerPy = () => join(resourcesDir, 'blender', 'runner.py')
let blenderInfo = null
function findBlender(force) {
  if (!blenderInfo?.found || force) blenderInfo = blender.find(app.getPath('userData'), getSettings().blender?.path)
  return blenderInfo
}
function requireBlender() {
  const b = findBlender()
  if (!b.found) throw new Error('Blender is not set up yet. Open the Blender tab to get it.')
  return b.path
}
let blenderDownload = null
handle('blender:status', (force) => findBlender(force))
handle('blender:download', async () => {
  if (blenderDownload) throw new Error('Blender is already downloading')
  blenderDownload = new AbortController()
  try {
    blenderInfo = await blender.download(app.getPath('userData'), { fetchImpl: net.fetch, signal: blenderDownload.signal, onProgress: (p) => send('blender:progress', p) })
    return blenderInfo
  } finally {
    blenderDownload = null
  }
})
handle('blender:cancelDownload', () => blenderDownload?.abort())
handle('blender:pickPath', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Find blender.exe',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Blender', extensions: ['exe'] }] : []
  })
  if (r.canceled) return findBlender()
  const v = blender.versionOf(r.filePaths[0])
  if (!v) throw new Error("That file didn't start as Blender.")
  setSettings({ blender: { path: r.filePaths[0] } })
  return findBlender(true)
})

let buildAbort = null
async function buildAsset(id, commitMessage) {
  const r = await library.build(id, { blenderPath: requireBlender(), runner: runnerPy(), signal: modelAbort?.signal || buildAbort?.signal, commitMessage })
  send('library:changed', { id })
  return r
}
const assetView = (id) => {
  const f = library.files(id)
  return {
    meta: library.readMeta(id),
    script: library.readScript(id),
    glb: f['model.glb'] ? new Uint8Array(f['model.glb']) : null,
    preview: f['preview.png'] ? `data:image/png;base64,${f['preview.png'].toString('base64')}` : null,
    chat: library.loadChat(id)
  }
}
handle('library:status', () => library.status())
handle('library:list', () =>
  library.list().map((a) => {
    const p = library.files(a.id)['preview.png']
    return { ...a, preview: p ? `data:image/png;base64,${p.toString('base64')}` : null }
  })
)
handle('library:create', async (name, description) => (await library.create(name, description)).id)
handle('library:get', (id) => assetView(id))
handle('library:saveScript', async (id, code) => {
  library.writeScript(id, code)
})
handle('library:build', async (id) => {
  buildAbort = new AbortController()
  try {
    return await buildAsset(id, 'Edited the script')
  } finally {
    buildAbort = null
  }
})
handle('library:rename', (id, name) => library.rename(id, name))
handle('library:remove', (id) => library.remove(id))
handle('library:reveal', (id) => shell.openPath(id ? join(library.dir(), id) : library.dir()))
handle('library:clearChat', (id) => library.saveChat(id, []))
handle('library:addToGame', async (id) => {
  const { dir } = requireProject()
  const rec = assets.addFromLibrary(dir, id)
  await git.commitAll(dir, `Added ${rec.name} from my library`)
  return rec
})
handle('library:connectGitHub', (opts) => library.connectGitHub(opts))
handle('library:sync', () => library.sync())

let modelAbort = null
let modelRun = null // { assetId, name, startedAt, status } while the modeling AI works
handle('model:stop', () => modelAbort?.abort())
handle('model:status', () => modelRun)
handle('model:run', async (id, userText) => {
  if (modelAbort) {
    throw new Error(modelRun && modelRun.assetId !== id ? `The AI is still working on "${modelRun.name}". Stop it there first, or wait for it to finish.` : 'The AI is already working on this model.')
  }
  requireBlender()
  modelRun = { assetId: id, name: library.readMeta(id).name, startedAt: Date.now(), status: 'Thinking…' }
  const ai = getSettings().ai
  const history = library.loadChat(id)
  modelAbort = new AbortController()
  const steps = []
  const emit = (ev) => {
    if (ev.type === 'tool_start') steps.push({ id: ev.id, name: ev.name, path: '', ok: null })
    if (ev.type === 'tool_end') {
      const s = steps.find((x) => x.id === ev.id)
      if (s) s.ok = ev.ok
    }
    if (ev.type === 'status' && modelRun) modelRun.status = ev.text
    send('model:event', { ...ev, assetId: id })
  }
  history.push({ role: 'user', content: userText, time: Date.now() })
  library.saveChat(id, history)
  try {
    // Saving a version is a convenience; a git hiccup must never block (or wedge) the AI.
    await localCommit('Your edits (before AI)').catch((e) => console.warn('library commit failed:', e.message))
    const result = await runModelAgent({
      id,
      ai,
      history: history.slice(0, -1),
      userText,
      emit,
      signal: modelAbort.signal,
      build: () => buildAsset(id, false)
    })
    const oid = await localCommit(`AI: ${userText.replace(/\s+/g, ' ').slice(0, 72)}`).catch(() => null)
    history.push({ role: 'assistant', content: result.reply, time: Date.now(), build: result.build ? { ok: result.build.ok, error: result.build.error } : null, commit: oid, steps })
    library.saveChat(id, history)
    emit({ type: 'done', reply: result.reply, commit: oid })
    return { reply: result.reply, steps }
  } catch (e) {
    await localCommit(`AI (stopped): ${userText.slice(0, 60)}`).catch(() => null)
    history.push({ role: 'assistant', content: `⚠ ${e.message}`, time: Date.now(), error: true, steps })
    library.saveChat(id, history)
    emit({ type: 'error', message: e.message })
    throw e
  } finally {
    modelAbort = null
    modelRun = null
  }
})
const localCommit = (msg) => git.commitAll(library.dir(), msg)

// ---------- updates (installed app) ----------
let updater = null
handle('updater:status', () => updater?.status || null)
handle('updater:check', () => updater.check())
handle('updater:download', () => updater.download())
handle('updater:install', () => updater.install())

// ---------- motion capture ----------
let modelDownload = null
handle('mocap:status', () => ({ model: mocap.hasModel(app.getPath('userData')), modelMB: Math.round(mocap.POSE_MODEL.bytes / 1e6) }))
handle('mocap:downloadModel', async () => {
  if (modelDownload) return modelDownload
  modelDownload = mocap
    .ensureModel(app.getPath('userData'), { fetchImpl: net.fetch, onProgress: (p) => send('mocap:progress', p) })
    .finally(() => (modelDownload = null))
  return modelDownload
})
handle('motions:list', () => library.listMotions())
handle('motions:read', (id) => library.readMotion(id))
handle('motions:video', (id) => {
  const v = library.motionVideo(id)
  return v ? { name: v.name, bytes: new Uint8Array(v.bytes) } : null
})
handle('motions:save', async (data, video) => {
  const m = await library.saveMotion(data, video)
  send('library:changed', {})
  return m
})
handle('motions:rename', async (id, name) => {
  await library.renameMotion(id, name)
  send('library:changed', {})
})
handle('motions:remove', async (id) => {
  await library.removeMotion(id)
  send('library:changed', {})
})
handle('motions:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a video of the move',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'] }]
  })
  if (r.canceled) return null
  const p = r.filePaths[0]
  const size = nodeFs.statSync(p).size
  if (size > 300 * 1e6) throw new Error('That video is over 300 MB. Trim it to just the move (a few seconds) first.')
  return { name: p.split(/[\\/]/).pop(), bytes: new Uint8Array(nodeFs.readFileSync(p)) }
})

handle('open:url', (url) => /^https:\/\//.test(url) && shell.openExternal(url))

// ---------- app lifecycle ----------
app.whenReady().then(async () => {
  const stores = {
    github: secretStore('github.json', ['token']),
    render: secretStore('render.json', ['key']),
    polypizza: secretStore('polypizza.json', ['key'])
  }
  await Promise.all(Object.values(stores).map((st) => st.load())) // decrypt once, before any window opens
  github.configureStore(stores.github)
  assets.configure({ cache: join(app.getPath('userData'), 'asset-cache') })
  assets.polyPizza.configureKeyStore(stores.polypizza)
  deploy.configureRenderStore(stores.render)
  library.configure(getSettings().libraryDir)
  // Tests run Electron on a script, which reports its own version; give it ours.
  if (process.env.GAMESMITH_APP_VERSION && typeof app.setVersion === 'function') app.setVersion(process.env.GAMESMITH_APP_VERSION)
  try {
    updater = new Updater({ packaged: app.isPackaged, version: process.env.GAMESMITH_APP_VERSION || app.getVersion() })
  } catch (e) {
    console.warn('Updates unavailable:', e.message) // never let the updater stop the app from starting
    updater = new Updater({ packaged: false, version: app.getVersion(), feedUrl: '' })
  }
  updater.on('status', (st) => send('updater:status', st))
  if (updater.mode === 'installed') {
    // Quietly look for a new version shortly after start, then every 6 hours.
    setTimeout(() => updater.check(), Number(process.env.GAMESMITH_UPDATE_DELAY_MS || 8000))
    setInterval(() => updater.check(), 6 * 3600 * 1000).unref()
  }
  protocol.handle('gsassets', mocap.makeHandler({ resourcesDir, userData: app.getPath('userData') }))
  // The webcam is only for the app's own Motions screen, never for games in the preview.
  const ownPage = (url) => /^(file:|http:\/\/localhost:)/.test(url || '')
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') return callback(ownPage(details.requestingUrl) && (details.mediaTypes || ['video']).every((t) => t === 'video'))
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && ownPage(origin))
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})
app.on('before-quit', () => gameServer.stop())
app.on('window-all-closed', async () => {
  await gameServer.stop()
  await preview.stop()
  if (process.platform !== 'darwin') app.quit()
})
