import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } from 'electron'
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

const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')

let win = null
const preview = new PreviewServer()
let current = null // { dir, meta }
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
handle('settings:set', (patch) => setSettings(patch))
handle('ai:models', (aiOverride) => listModels({ ...getSettings().ai, ...(aiOverride || {}) }))
handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

// ---------- projects ----------
handle('projects:list', () => projects.listProjects(getSettings().projectsDir))
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
  const url = await preview.start(dir)
  return { dir, meta, url, chat: loadChat(dir) }
})
handle('projects:close', async () => {
  agentAbort?.abort()
  await preview.stop()
  current = null
})
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
      signal: agentAbort.signal
    })
    const label = userText.replace(/\s+/g, ' ').slice(0, 72)
    const oid = await git.commitAll(dir, `AI: ${label}`)
    history.push({ role: 'assistant', content: result.reply, time: Date.now(), changedFiles: result.changedFiles, check: result.check, commit: oid, steps })
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

// ---------- GitHub ----------
function secretStore(name) {
  const canEncrypt = () => safeStorage.isEncryptionAvailable()
  return {
    file: join(app.getPath('userData'), name),
    encrypt: (s) => (canEncrypt() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s),
    decrypt: (s) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s)
  }
}

let deviceAbort = null
handle('github:account', () => github.getAccount())
handle('github:signInToken', (token) => github.signInWithToken(token))
handle('github:signOut', () => github.signOut())
handle('github:deviceStart', async () => {
  const clientId = getSettings().github?.clientId
  if (!clientId) throw new Error('No GitHub OAuth App client ID is set. Use a token instead, or add a client ID in Settings.')
  deviceAbort?.abort()
  deviceAbort = new AbortController()
  const flow = await github.startDeviceFlow(clientId)
  clipboard.writeText(flow.user_code)
  shell.openExternal(flow.verification_uri)
  github
    .pollDeviceFlow(clientId, flow, deviceAbort.signal)
    .then((account) => send('github:auth', { ok: true, account }))
    .catch((e) => send('github:auth', { ok: false, error: e.message }))
  return { userCode: flow.user_code, verificationUri: flow.verification_uri }
})
handle('github:deviceCancel', () => deviceAbort?.abort())

// ---------- publishing ----------
handle('publish:status', async () => {
  const { dir } = requireProject()
  const meta = projects.readMeta(dir)
  const out = {
    account: github.getAccount(),
    hasRenderKey: !!deploy.getRenderKey(),
    repo: meta.github || null,
    lastSync: meta.lastSync || null,
    unpushed: meta.github ? await github.unpushedCount(dir) : null,
    pages: meta.pages || null,
    render: meta.render || null
  }
  if (out.pages && out.account) out.pages = { ...out.pages, ...(await deploy.pagesStatus(meta.github.owner, meta.github.name).catch((e) => ({ status: 'unknown', error: e.message }))) }
  if (out.render && out.hasRenderKey) out.render = { ...out.render, ...(await deploy.renderStatus(meta.render.serviceId).catch((e) => ({ status: 'unknown', error: e.message }))) }
  return out
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
  const { github: repo } = projects.readMeta(dir)
  if (!repo) throw new Error('Save the game to GitHub first')
  const site = await deploy.enablePages(repo.owner, repo.name)
  projects.updateMeta(dir, { pages: { url: site.url } })
  return site
})
handle('render:setKey', async (key) => {
  if (key) await deploy.renderWorkspaces(key) // validate before saving
  deploy.setRenderKey(key)
  return !!key
})
handle('render:workspaces', () => deploy.renderWorkspaces())
handle('publish:createRender', async (ownerId) => {
  const { dir, meta } = requireProject()
  const { github: repo } = projects.readMeta(dir)
  if (!repo) throw new Error('Save the game to GitHub first')
  const site = await deploy.createRenderSite({ name: repo.name || meta.name, ownerId, repoUrl: repo.htmlUrl })
  projects.updateMeta(dir, { render: site })
  return site
})
handle('open:url', (url) => /^https:\/\//.test(url) && shell.openExternal(url))

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  github.configureStore(secretStore('github.json'))
  deploy.configureRenderStore(secretStore('render.json'))
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})
app.on('window-all-closed', async () => {
  await preview.stop()
  if (process.platform !== 'darwin') app.quit()
})
