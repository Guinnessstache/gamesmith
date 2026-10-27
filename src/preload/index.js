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
    reveal: (rel) => call('projects:reveal', rel)
  },
  preview: {
    reload: () => call('preview:reload'),
    openExternal: () => call('preview:openExternal'),
    onConsole: (fn) => on('preview:console', fn),
    onReloading: (fn) => on('preview:reloading', fn)
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
  git: {
    log: () => call('git:log'),
    snapshot: (msg) => call('git:snapshot', msg),
    restore: (oid) => call('git:restore', oid)
  }
})
