// GitHub: sign-in, repo creation, and push/pull. No git install needed —
// pushes go through isomorphic-git over HTTPS using the user's token.
// The token is stored encrypted with the OS keychain (Electron safeStorage)
// when available. Electron-specific bits are injected so this file can be
// tested in plain Node.
import fs from 'node:fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import * as localGit from './git.js'

export const API = () => process.env.GAMESMITH_GITHUB_API || 'https://api.github.com'
const WEB = () => process.env.GAMESMITH_GITHUB_WEB || 'https://github.com'

// ---------- token storage ----------
// A secretStore (see secretStore.js): get() is sync, set() is async.
let store = { get: () => ({}), set: async () => {} }
export function configureStore(secretStore) {
  store = secretStore
}
export function getToken() {
  return store.get().token || null
}
export function getAccount() {
  const s = store.get()
  return s.token ? s.account || null : null
}
export async function signOut() {
  await store.set({})
}

// ---------- API helpers ----------
export async function api(path, { method = 'GET', body, token = getToken() } = {}) {
  const res = await fetch(API() + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Gamesmith',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
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
    const detail = json?.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ')
    const err = new Error(`GitHub: ${json?.message || res.statusText}${detail ? ` (${detail})` : ''}`)
    err.status = res.status
    throw err
  }
  return json
}

/**
 * Is the saved token still accepted? (Tokens expire or get revoked on github.com.)
 * Cached for a minute so the Publish panel doesn't ask on every refresh.
 */
let tokenCheck = { token: null, at: 0, ok: true }
export async function tokenWorks() {
  const token = getToken()
  if (!token) return false
  if (tokenCheck.token === token && Date.now() - tokenCheck.at < 60000) return tokenCheck.ok
  let ok = true
  try {
    await api('/user', { token })
  } catch (e) {
    if (e.status === 401) ok = false
    else return true // offline or GitHub hiccup: don't claim the sign-in is broken
  }
  tokenCheck = { token, at: Date.now(), ok }
  return ok
}

/** Save a token after checking it works. Accepts a personal access token or an OAuth token. */
export async function signInWithToken(token) {
  const user = await api('/user', { token: token.trim() })
  const account = {
    login: user.login,
    name: user.name || user.login,
    id: user.id,
    avatar: user.avatar_url,
    email: `${user.id}+${user.login}@users.noreply.github.com`
  }
  await store.set({ token: token.trim(), account })
  return account
}

// ---------- OAuth device flow ----------
// Needs a GitHub OAuth App with "Enable Device Flow" checked. The client ID is
// public; no client secret is needed (or safe) in a desktop app.
export async function startDeviceFlow(clientId) {
  const res = await fetch(`${WEB()}/login/device/code`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo' })
  })
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(`GitHub sign-in: ${json.error_description || json.error || res.statusText}`)
  return json // { device_code, user_code, verification_uri, expires_in, interval }
}

export async function pollDeviceFlow(clientId, flow, signal) {
  let interval = (flow.interval || 5) * 1000
  const deadline = Date.now() + (flow.expires_in || 900) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    if (signal?.aborted) throw new Error('Sign-in cancelled')
    const res = await fetch(`${WEB()}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: flow.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const json = await res.json()
    if (json.access_token) return signInWithToken(json.access_token)
    if (json.error === 'authorization_pending') continue
    if (json.error === 'slow_down') {
      interval += 5000
      continue
    }
    throw new Error(`GitHub sign-in: ${json.error_description || json.error}`)
  }
  throw new Error('GitHub sign-in timed out. Try again.')
}

// ---------- repos ----------
function slug(name) {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'my-game'
}

export async function createRepo(dir, { name, isPrivate, description }) {
  const repo = await api('/user/repos', {
    method: 'POST',
    body: { name: slug(name), private: !!isPrivate, description: description || 'Made with Gamesmith', auto_init: false }
  })
  await setRemote(dir, repo.clone_url)
  return repoInfo(repo)
}

/** The signed-in user's repositories, most recently updated first. */
export async function listRepos() {
  if (!getToken()) return []
  const list = await api('/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator')
  return list.map((r) => ({ fullName: r.full_name, name: r.name, private: r.private, description: r.description || '', updated: r.pushed_at || r.updated_at }))
}

/** Link to an existing repo given "owner/name" or a GitHub URL. */
export async function linkRepo(dir, ref) {
  const m = String(ref).trim().match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  if (!m) throw new Error('Enter the repository as owner/name or paste its GitHub URL')
  const repo = await api(`/repos/${m[1]}/${m[2]}`)
  await setRemote(dir, repo.clone_url)
  return repoInfo(repo)
}

function repoInfo(repo) {
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    htmlUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch || 'main'
  }
}

async function setRemote(dir, url) {
  const remotes = await git.listRemotes({ fs, dir })
  if (remotes.some((r) => r.remote === 'origin')) await git.deleteRemote({ fs, dir, remote: 'origin' })
  await git.addRemote({ fs, dir, remote: 'origin', url })
}

const onAuth = () => ({ username: 'x-access-token', password: getToken() })
// Send credentials up front (saves a 401 round trip), and via onAuth as a fallback.
const authHeaders = () => ({ Authorization: 'Basic ' + Buffer.from(`x-access-token:${getToken()}`).toString('base64') })

/**
 * Save the current state as a commit and push it. If GitHub has commits the
 * app doesn't (edited on github.com), they are merged in first.
 */
export async function sync(dir, { message = 'Saved from Gamesmith', account = getAccount() } = {}) {
  if (!getToken()) throw new Error('Sign in to GitHub first')
  const author = account ? { name: account.name, email: account.email } : undefined
  await localGit.commitAll(dir, message, author)

  const ref = await localGit.branch(dir)
  const push = () => git.push({ fs, http, dir, remote: 'origin', ref, onAuth, headers: authHeaders() })
  let pulled = 0
  try {
    const r = await push()
    if (r?.ok === false) throw Object.assign(new Error(r.error || 'Push failed'), { code: 'PushRejectedError' })
  } catch (e) {
    if (!/PushRejected|not a simple fast-forward|fast-forward|rejected/i.test(`${e.code} ${e.message}`)) throw friendly(e)
    // Remote has new commits: fetch and merge, then push again.
    await git.fetch({ fs, http, dir, remote: 'origin', ref, singleBranch: true, onAuth, headers: authHeaders() })
    try {
      const m = await git.merge({ fs, dir, ours: ref, theirs: `remotes/origin/${ref}`, author: author || localGit.AUTHOR, message: 'Merge changes from GitHub' })
      await git.checkout({ fs, dir, ref, force: true })
      pulled = m?.alreadyMerged ? 0 : 1
    } catch (me) {
      if (me.code === 'MergeConflictError' || me.code === 'MergeNotSupportedError') {
        throw new Error('GitHub has changes to the same files that were changed here. Gamesmith can\'t combine them automatically yet; restore one side from History or resolve it on github.com.')
      }
      throw friendly(me)
    }
    await push()
  }
  const head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
  return { commit: head, pulled, time: Date.now() }
}

function friendly(e) {
  const msg = e?.message || String(e)
  if (/401|auth/i.test(msg)) {
    tokenCheck = { token: getToken(), at: Date.now(), ok: false }
    return new Error('Your GitHub sign-in has expired or was revoked. Connect GitHub again (Publish panel, step 1).')
  }
  if (/403/.test(msg)) return new Error("GitHub refused the push: this sign-in can't write to the repository. Connect again with a token that has the repo scope.")
  if (/404/.test(msg)) return new Error('GitHub repository not found. It may have been renamed or deleted; link it again.')
  return new Error(msg)
}

/** How many local versions haven't been pushed yet (null if never pushed). */
export async function unpushedCount(dir) {
  try {
    const remotes = await git.listRemotes({ fs, dir })
    if (!remotes.some((r) => r.remote === 'origin')) return null
    let remoteOid
    try {
      remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${await localGit.branch(dir)}` })
    } catch {
      return null
    }
    const commits = await git.log({ fs, dir, depth: 500 })
    const i = commits.findIndex((c) => c.oid === remoteOid)
    return i === -1 ? commits.length : i
  } catch {
    return null
  }
}
