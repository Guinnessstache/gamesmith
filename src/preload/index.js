import { contextBridge, ipcRenderer } from 'electron'

// Every call returns the data or throws an Error with a readable message.
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

function on(channel, fn) {
  const listener = (_e, payload) => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('gs', {
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    pickFolder: () => call('dialog:pickFolder')
  },
  ai: {
    models: (override) => call('ai:models', override),
    run: (text) => call('agent:run', text),
    stop: () => call('agent:stop'),
    clearChat: () => call('chat:clear'),
    onEvent: (fn) => on('agent:event', fn)
  },
  projects: {
    list: () => call('projects:list'),
    templates: () => call('projects:templates'),
    create: (opts) => call('projects:create', opts),
    open: (dir) => call('projects:open', dir),
    close: () => call('projects:close'),
    reveal: (rel) => call('projects:reveal', rel),
    importGitHub: (ref) => call('projects:importGitHub', ref),
    githubRepos: () => call('projects:githubRepos'),
    openFolder: () => call('projects:openFolder'),
    importHtml: (filePath) => call('projects:importHtml', filePath),
    onImportProgress: (fn) => on('import:progress', fn)
  },
  preview: {
    reload: () => call('preview:reload'),
    openExternal: () => call('preview:openExternal'),
    onConsole: (fn) => on('preview:console', fn),
    onReloading: (fn) => on('preview:reloading', fn),
    restartServer: () => call('server:restart'),
    onServerStatus: (fn) => on('server:status', fn)
  },
  fs: {
    list: () => call('fs:list'),
    read: (p) => call('fs:read', p),
    write: (p, c) => call('fs:write', p, c),
    remove: (p) => call('fs:delete', p),
    move: (a, b) => call('fs:move', a, b),
    importFiles: (folder) => call('fs:import', folder),
    onChanged: (fn) => on('files:changed', fn)
  },
  github: {
    account: () => call('github:account'),
    signInToken: (t) => call('github:signInToken', t),
    signOut: () => call('github:signOut'),
    deviceStart: () => call('github:deviceStart'),
    deviceCancel: () => call('github:deviceCancel'),
    openVerification: (url) => call('github:openVerification', url),
    onAuth: (fn) => on('github:auth', fn)
  },
  publish: {
    status: () => call('publish:status'),
    createRepo: (o) => call('publish:createRepo', o),
    linkRepo: (ref) => call('publish:linkRepo', ref),
    sync: (msg) => call('publish:sync', msg),
    enablePages: () => call('publish:enablePages'),
    recheck: (host) => call('publish:recheck', host),
    createRender: (ownerId) => call('publish:createRender', ownerId)
  },
  render: {
    setKey: (k) => call('render:setKey', k),
    workspaces: () => call('render:workspaces')
  },
  assets: {
    search: (q, type, source) => call('assets:search', q, type, source),
    polyPizzaStatus: () => call('assets:polyPizzaStatus'),
    setPolyPizzaKey: (k) => call('assets:setPolyPizzaKey', k),
    plan: (id, type, res) => call('assets:plan', id, type, res),
    list: () => call('assets:list'),
    add: (o) => call('assets:add', o),
    importZip: () => call('assets:importZip'),
    remove: (id) => call('assets:remove', id),
    onProgress: (fn) => on('assets:progress', fn)
  },
  blender: {
    status: (force) => call('blender:status', force),
    download: () => call('blender:download'),
    cancelDownload: () => call('blender:cancelDownload'),
    pickPath: () => call('blender:pickPath'),
    onProgress: (fn) => on('blender:progress', fn)
  },
  library: {
    status: () => call('library:status'),
    list: () => call('library:list'),
    create: (name, description) => call('library:create', name, description),
    get: (id) => call('library:get', id),
    saveScript: (id, code) => call('library:saveScript', id, code),
    build: (id) => call('library:build', id),
    rename: (id, name) => call('library:rename', id, name),
    remove: (id) => call('library:remove', id),
    reveal: (id) => call('library:reveal', id),
    clearChat: (id) => call('library:clearChat', id),
    addToGame: (id) => call('library:addToGame', id),
    connectGitHub: (opts) => call('library:connectGitHub', opts),
    sync: () => call('library:sync'),
    onChanged: (fn) => on('library:changed', fn)
  },
  model: {
    run: (id, text) => call('model:run', id, text),
    stop: () => call('model:stop'),
    status: () => call('model:status'),
    onEvent: (fn) => on('model:event', fn)
  },
  updater: {
    status: () => call('updater:status'),
    check: () => call('updater:check'),
    download: () => call('updater:download'),
    install: () => call('updater:install'),
    onStatus: (fn) => on('updater:status', fn)
  },
  mocap: {
    status: () => call('mocap:status'),
    downloadModel: () => call('mocap:downloadModel'),
    onProgress: (fn) => on('mocap:progress', fn)
  },
  motions: {
    list: () => call('motions:list'),
    read: (id) => call('motions:read', id),
    video: (id) => call('motions:video', id),
    save: (data, video) => call('motions:save', data, video),
    rename: (id, name) => call('motions:rename', id, name),
    remove: (id) => call('motions:remove', id),
    pickVideo: () => call('motions:pickVideo')
  },
  openUrl: (url) => call('open:url', url),
  git: {
    log: () => call('git:log'),
    snapshot: (msg) => call('git:snapshot', msg),
    restore: (oid) => call('git:restore', oid)
  }
})
