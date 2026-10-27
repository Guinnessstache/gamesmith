// Publishing a game to the web. Games are plain static files, so two free
// options work with zero build step:
//   - GitHub Pages: enabled through the GitHub API on the game's repo
//   - Render static site: created through the Render API, auto-deploys on push
import fs from 'node:fs'
import { api as githubApi } from './github.js'

const RENDER_API = () => process.env.GAMESMITH_RENDER_API || 'https://api.render.com/v1'

// ---------- GitHub Pages ----------
export async function enablePages(owner, repo) {
  try {
    const site = await githubApi(`/repos/${owner}/${repo}/pages`, {
      method: 'POST',
      body: { build_type: 'legacy', source: { branch: 'main', path: '/' } }
    })
    return { url: site.html_url, status: site.status || 'building' }
  } catch (e) {
    if (e.status === 409) {
      const site = await githubApi(`/repos/${owner}/${repo}/pages`)
      return { url: site.html_url, status: site.status }
    }
    if (e.status === 422 || e.status === 403) {
      throw new Error('GitHub Pages could not be turned on. Free GitHub accounts can only publish public repositories; make the repo public or use Render instead.')
    }
    throw e
  }
}

export async function pagesStatus(owner, repo) {
  const site = await githubApi(`/repos/${owner}/${repo}/pages`)
  let build = null
  try {
    build = await githubApi(`/repos/${owner}/${repo}/pages/builds/latest`)
  } catch {
    /* no build yet */
  }
  // build.status: queued | building | built | errored
  return { url: site.html_url, status: build?.status || site.status || 'queued', error: build?.error?.message || null, updated: build?.updated_at || null }
}

// ---------- Render ----------
let renderStore = { file: null, encrypt: (s) => s, decrypt: (s) => s }
export function configureRenderStore(opts) {
  renderStore = opts
}
export function getRenderKey() {
  try {
    const s = JSON.parse(fs.readFileSync(renderStore.file, 'utf8'))
    return s.key ? renderStore.decrypt(s.key) : null
  } catch {
    return null
  }
}
export function setRenderKey(key) {
  fs.writeFileSync(renderStore.file, JSON.stringify(key ? { key: renderStore.encrypt(key.trim()) } : {}))
}

async function render(path, { method = 'GET', body, key = getRenderKey() } = {}) {
  if (!key) throw new Error('Add your Render API key in Settings first')
  const res = await fetch(RENDER_API() + path, {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { message: text }
  }
  if (!res.ok) {
    const err = new Error(`Render: ${json?.message || res.statusText}`)
    err.status = res.status
    throw err
  }
  return json
}

/** Workspaces the key can deploy into: [{ id, name }] */
export async function renderWorkspaces(key) {
  const list = await render('/owners?limit=20', { key })
  return (list || []).map((x) => x.owner || x).map((o) => ({ id: o.id, name: o.name, type: o.type }))
}

export async function createRenderSite({ name, ownerId, repoUrl }) {
  const body = {
    type: 'static_site',
    name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'my-game',
    ownerId,
    repo: repoUrl.replace(/\.git$/, ''),
    branch: 'main',
    autoDeployTrigger: 'commit',
    serviceDetails: { publishPath: './', buildCommand: 'echo "static game, no build needed"' }
  }
  let json
  try {
    json = await render('/services', { method: 'POST', body })
  } catch (e) {
    if (/repo|github|access|install/i.test(e.message)) {
      throw new Error(`${e.message}. Render needs access to this GitHub repository: in the Render dashboard, connect your GitHub account and allow the Render app to see this repo, then try again.`)
    }
    throw e
  }
  const svc = json.service || json
  return { serviceId: svc.id, url: svc.serviceDetails?.url || `https://${svc.slug || body.name}.onrender.com`, dashboardUrl: svc.dashboardUrl || null }
}

export async function renderStatus(serviceId) {
  const list = await render(`/services/${serviceId}/deploys?limit=1`)
  const d = (list || []).map((x) => x.deploy || x)[0]
  // live | build_in_progress | update_in_progress | created | build_failed | update_failed | canceled | deactivated
  return { status: d?.status || 'unknown', updated: d?.finishedAt || d?.updatedAt || null }
}

export async function triggerRenderDeploy(serviceId) {
  return render(`/services/${serviceId}/deploys`, { method: 'POST', body: {} })
}
