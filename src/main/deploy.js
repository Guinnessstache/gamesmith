// Publishing a game to the web. Games are plain static files, so two free
// options work with zero build step:
//   - GitHub Pages: enabled through the GitHub API on the game's repo
//   - Render static site: created through the Render API, auto-deploys on push
import fs from 'node:fs'
import { api as githubApi } from './github.js'

const RENDER_API = () => process.env.GAMESMITH_RENDER_API || 'https://api.render.com/v1'

// ---------- GitHub Pages ----------
export async function enablePages(owner, repo, { branch = 'main', path = '/' } = {}) {
  try {
    const site = await githubApi(`/repos/${owner}/${repo}/pages`, {
      method: 'POST',
      body: { build_type: 'legacy', source: { branch, path } }
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
let renderStore = { get: () => ({}), set: async () => {} }
export function configureRenderStore(secretStore) {
  renderStore = secretStore
}
export function getRenderKey() {
  return renderStore.get().key || null
}
export async function setRenderKey(key) {
  await renderStore.set(key ? { key: key.trim() } : {})
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

export async function createRenderSite({ name, ownerId, repoUrl, branch = 'main', publishPath = './' }) {
  const body = {
    type: 'static_site',
    name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'my-game',
    ownerId,
    repo: repoUrl.replace(/\.git$/, ''),
    branch,
    autoDeployTrigger: 'commit',
    serviceDetails: { publishPath, buildCommand: 'echo "static game, no build needed"' }
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

/** An existing Render service that deploys this repo (games with their own server). */
export async function findRenderService(repoHtmlUrl) {
  const want = repoHtmlUrl.replace(/\.git$/, '').toLowerCase()
  const list = await render('/services?limit=100')
  const svc = (list || []).map((x) => x.service || x).find((s) => (s.repo || '').replace(/\.git$/, '').toLowerCase() === want)
  return svc ? { serviceId: svc.id, url: svc.serviceDetails?.url, type: svc.type, name: svc.name, dashboardUrl: svc.dashboardUrl } : null
}

export async function triggerRenderDeploy(serviceId) {
  return render(`/services/${serviceId}/deploys`, { method: 'POST', body: {} })
}

// ---------- post-deploy check ----------
// A host can say "live" while some files still fail for visitors: a CDN may
// briefly cache a "not found" right after a first deploy, and file-name case
// mismatches (fine on Windows, broken on Linux hosts) only show up online.
// So after each deploy, request every file of the game from the live site.
export async function verifySite(baseUrl, paths, { concurrency = 6, timeoutMs = 15000 } = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  const queue = [...paths]
  const failed = []
  const check = async (p) => {
    const url = base + p.split('/').map(encodeURIComponent).join('/')
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Gamesmith deploy check' } })
        if (method === 'GET') res.body?.cancel().catch(() => {})
        if (res.ok) return null
        if (method === 'HEAD' && (res.status === 405 || res.status === 501)) continue // host doesn't do HEAD
        return { path: p, status: res.status }
      } catch (e) {
        if (method === 'GET') return { path: p, status: e.name === 'TimeoutError' ? 'timeout' : 'network error' }
      }
    }
    return null
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let p; (p = queue.shift()) !== undefined; ) {
        const f = await check(p)
        if (f) failed.push(f)
      }
    })
  )
  return { url: base, checked: paths.length, failed: failed.sort((a, b) => a.path.localeCompare(b.path)), at: Date.now() }
}

/** Which of the game's files a visitor's browser could request. */
export function publicFiles(paths) {
  return paths.filter((p) => !p.split('/').some((seg) => seg.startsWith('.')) && !/^(README|LICENSE|TODO|CHANGELOG)(\.\w+)?$/i.test(p))
}
