import { useCallback, useEffect, useState } from 'react'
import { timeAgo } from './ui.jsx'

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=Gamesmith'
const RENDER_KEYS_URL = 'https://dashboard.render.com/u/settings#api-keys'

const PAGES_LABEL = { built: 'Live', building: 'Updating…', queued: 'Updating…', errored: 'Failed', unknown: 'Unknown' }
const RENDER_LABEL = {
  live: 'Live',
  created: 'Updating…',
  build_in_progress: 'Updating…',
  update_in_progress: 'Updating…',
  pre_deploy_in_progress: 'Updating…',
  build_failed: 'Failed',
  update_failed: 'Failed',
  pre_deploy_failed: 'Failed',
  canceled: 'Canceled',
  deactivated: 'Turned off',
  unknown: 'Unknown'
}

export default function PublishPanel({ project, settings, onClose, onChanged }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setSt(await window.gs.publish.status())
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // While a site is updating, refresh its status every few seconds.
  const updating = st && ((st.pages && !['built', 'errored'].includes(st.pages.status)) || (st.render && /progress|created/.test(st.render.status || '')))
  useEffect(() => {
    if (!updating) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [updating, load])

  const act = async (label, fn) => {
    setBusy(label)
    setErr('')
    try {
      await fn()
      await load()
      onChanged?.()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide publish" onMouseDown={(e) => e.stopPropagation()}>
        <div className="publish-head">
          <h2>Publish {project.meta.name}</h2>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        {err && <div className="notice error">{err}</div>}
        {!st ? (
          <div className="muted">Loading…</div>
        ) : (
          <>
            <GitHubSection st={st} project={project} settings={settings} busy={busy} act={act} reload={load} />
            <WebSection st={st} busy={busy} act={act} onRecheck={async (host) => { await window.gs.publish.recheck(host); await load() }} />
          </>
        )}
      </div>
    </div>
  )
}

function Step({ n, title, done, children }) {
  return (
    <section className={`pub-step ${done ? 'done' : ''}`}>
      <div className="pub-num">{done ? '✓' : n}</div>
      <div className="pub-body">
        <h3>{title}</h3>
        {children}
      </div>
    </section>
  )
}

function GitHubSection({ st, project, settings, busy, act, reload }) {
  const [token, setToken] = useState('')
  const [device, setDevice] = useState(null)
  const [repoName, setRepoName] = useState(project.meta.name.replace(/[^A-Za-z0-9._-]+/g, '-'))
  const [isPrivate, setIsPrivate] = useState(false)
  const [linkRef, setLinkRef] = useState('')
  const [showLink, setShowLink] = useState(false)

  const [deviceErr, setDeviceErr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(
    () =>
      window.gs.github.onAuth((r) => {
        setDevice((cur) => {
          if (!cur || cur.id !== r.id) return cur // event from an older attempt
          if (!r.ok) setDeviceErr(r.error)
          return r.ok ? null : cur
        })
        if (r.ok) reload()
      }),
    [reload]
  )

  if (!st.account) {
    return (
      <Step n={1} title="Connect GitHub">
        <p className="muted">Your game's files are saved to a GitHub repository. That's also what the web hosts publish from.</p>
        {device ? (
          <div className="device-code">
            <span className="muted small">1. Your sign-in code (already copied):</span>
            <div className="code-row">
              <strong>{device.userCode}</strong>
              <button
                className="btn ghost small"
                onClick={() => {
                  navigator.clipboard.writeText(device.userCode)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span className="muted small">2. Open GitHub, press Ctrl+V in the first box, then approve.</span>
            <button className="btn play" onClick={() => window.gs.github.openVerification(device.verificationUri)}>Open GitHub</button>
            {deviceErr ? (
              <div className="notice error">
                {deviceErr}
                <button className="btn ghost small" onClick={() => { setDevice(null); setDeviceErr('') }}>Try again</button>
              </div>
            ) : (
              <span className="status"><span className="spinner" aria-hidden /> Waiting for you to approve on GitHub…</span>
            )}
            <button className="linkish" onClick={() => { window.gs.github.deviceCancel(); setDevice(null); setDeviceErr('') }}>Cancel</button>
          </div>
        ) : (
          <>
            {settings.github?.clientId && (
              <button className="btn play" disabled={!!busy} onClick={() => act('device', async () => { setDeviceErr(''); setDevice(await window.gs.github.deviceStart()) })}>
                Sign in with GitHub
              </button>
            )}
            <form
              className="field-row"
              onSubmit={(e) => {
                e.preventDefault()
                act('token', () => window.gs.github.signInToken(token))
              }}
            >
              <label className="field grow">
                <span>
                  {settings.github?.clientId ? 'Or paste' : 'Paste'} a GitHub token with the "repo" scope (
                  <a href={TOKEN_URL} target="_blank" rel="noreferrer">create one</a>)
                </span>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_…" />
              </label>
              <button className="btn play" disabled={!token.trim() || !!busy}>{busy === 'token' ? 'Checking…' : 'Connect'}</button>
            </form>
          </>
        )}
      </Step>
    )
  }

  if (!st.repo) {
    return (
      <Step n={1} title="Save to GitHub">
        <p className="muted">Signed in as <strong>{st.account.login}</strong>. Create a repository for this game and upload it.</p>
        <div className="field-row">
          <label className="field grow">
            <span>Repository name</span>
            <input value={repoName} onChange={(e) => setRepoName(e.target.value)} />
          </label>
          <label className="check-field">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Private
          </label>
          <button className="btn play" disabled={!repoName.trim() || !!busy} onClick={() => act('create', () => window.gs.publish.createRepo({ name: repoName, isPrivate }))}>
            {busy === 'create' ? 'Uploading…' : 'Create and upload'}
          </button>
        </div>
        {isPrivate && <p className="muted small">Free GitHub accounts can only use GitHub Pages with public repositories. Render works with either.</p>}
        {showLink ? (
          <div className="field-row">
            <label className="field grow">
              <span>Existing repository (owner/name or URL)</span>
              <input value={linkRef} onChange={(e) => setLinkRef(e.target.value)} placeholder={`${st.account.login}/my-game`} />
            </label>
            <button className="btn ghost" disabled={!linkRef.trim() || !!busy} onClick={() => act('link', () => window.gs.publish.linkRepo(linkRef))}>Link</button>
          </div>
        ) : (
          <button className="linkish" onClick={() => setShowLink(true)}>Use an existing repository instead</button>
        )}
      </Step>
    )
  }

  const pending = st.unpushed ?? 0
  return (
    <Step n={1} title="Saved on GitHub" done={pending === 0}>
      <div className="pub-row">
        <a href={st.repo.htmlUrl} target="_blank" rel="noreferrer" className="repo-link">{st.repo.fullName}</a>
        <span className="muted small">
          {st.lastSync ? `last saved ${timeAgo(st.lastSync)}` : 'not uploaded yet'}
          {pending > 0 && `, ${pending} new version${pending > 1 ? 's' : ''} not uploaded`}
        </span>
        <div className="spacer" />
        <button className="btn play small" disabled={!!busy} onClick={() => act('sync', () => window.gs.publish.sync())}>
          {busy === 'sync' ? 'Saving…' : 'Save to GitHub'}
        </button>
      </div>
    </Step>
  )
}

function WebSection({ st, busy, act, onRecheck }) {
  const [renderKey, setRenderKey] = useState('')
  const [workspaces, setWorkspaces] = useState(null)
  const [ownerId, setOwnerId] = useState('')

  useEffect(() => {
    if (st.hasRenderKey && !st.render && workspaces === null) {
      window.gs.render
        .workspaces()
        .then((ws) => {
          setWorkspaces(ws)
          setOwnerId(ws[0]?.id || '')
        })
        .catch(() => setWorkspaces([]))
    }
  }, [st.hasRenderKey, st.render, workspaces])

  const locked = !st.repo
  return (
    <Step n={2} title="Put it on the web" done={[st.pages, st.render].some((h) => h?.verify && !h.verify.error && !h.verify.failed?.length)}>
      {locked ? (
        <p className="muted">Save the game to GitHub first. Then pick a free host; every later "Save to GitHub" updates the live game automatically.</p>
      ) : (
        <div className="hosts">
          {st.kind === 'node' ? (
            <div className="host">
              <div className="host-head">
                <strong>GitHub Pages</strong>
                <span className="muted small">Not available for this game</span>
              </div>
              <span className="muted small">This game runs its own server (multiplayer, saves). GitHub Pages only hosts plain files, so use Render.</span>
            </div>
          ) : (
          <div className="host">
            <div className="host-head">
              <strong>GitHub Pages</strong>
              <span className="muted small">Free, public repositories</span>
            </div>
            {st.pages ? (
              <SiteLink url={st.pages.url} label={PAGES_LABEL[st.pages.status] || st.pages.status} bad={st.pages.status === 'errored'} error={st.pages.error} verify={st.pages.verify} host="pages" onRecheck={onRecheck} />
            ) : (
              <button className="btn play" disabled={!!busy} onClick={() => act('pages', () => window.gs.publish.enablePages())}>
                {busy === 'pages' ? 'Publishing…' : 'Publish on GitHub Pages'}
              </button>
            )}
          </div>

          )}
          <div className="host">
            <div className="host-head">
              <strong>Render</strong>
              <span className="muted small">Free static hosting; later supports multiplayer servers</span>
            </div>
            {st.render ? (
              <SiteLink url={st.render.url} label={RENDER_LABEL[st.render.status] || st.render.status} bad={/failed/.test(st.render.status || '')} verify={st.render.verify} host="render" onRecheck={onRecheck} />
            ) : !st.hasRenderKey ? (
              <form
                className="field-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  act('renderKey', () => window.gs.render.setKey(renderKey))
                }}
              >
                <label className="field grow">
                  <span>
                    Render API key (<a href={RENDER_KEYS_URL} target="_blank" rel="noreferrer">get one</a>)
                  </span>
                  <input type="password" value={renderKey} onChange={(e) => setRenderKey(e.target.value)} placeholder="rnd_…" />
                </label>
                <button className="btn ghost" disabled={!renderKey.trim() || !!busy}>{busy === 'renderKey' ? 'Checking…' : 'Connect'}</button>
              </form>
            ) : (
              <div className="field-row">
                {workspaces?.length > 1 && (
                  <label className="field grow">
                    <span>Workspace</span>
                    <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <button className="btn play" disabled={!!busy || (!ownerId && st.kind !== 'node')} onClick={() => act('render', () => window.gs.publish.createRender(ownerId))}>
                  {busy === 'render' ? (st.kind === 'node' ? 'Looking…' : 'Publishing…') : st.kind === 'node' ? 'Find my Render service' : 'Publish on Render'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Step>
  )
}

function SiteLink({ url, label, bad, error, verify, host, onRecheck }) {
  const [busy, setBusy] = useState(false)
  const failing = verify?.failed?.length > 0
  const shown = label === 'Live' && verify && !verify.error ? (failing ? 'Live, with problems' : 'Live') : label === 'Live' ? 'Checking files…' : label
  const recheck = async () => {
    setBusy(true)
    try {
      await onRecheck(host)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="site">
      <span className={`site-state ${shown === 'Live' ? 'live' : bad || failing ? 'bad' : 'wait'}`}>{shown}</span>
      <a href={url} target="_blank" rel="noreferrer">{url}</a>
      {error && <span className="muted small">{error}</span>}
      {label === 'Live' && verify && !verify.error && !failing && <span className="muted small">All {verify.checked} files load.</span>}
      {failing && (
        <div className="verify-fail">
          <span className="small">
            {verify.failed.length} of {verify.checked} files don't load on the live site:
          </span>
          <ul>
            {verify.failed.slice(0, 8).map((f) => (
              <li key={f.path}><code>{f.path}</code> ({f.status})</li>
            ))}
            {verify.failed.length > 8 && <li>…and {verify.failed.length - 8} more</li>}
          </ul>
          <span className="muted small">
            Right after a first deploy this usually clears within 5 minutes. If it doesn't, check the file names: the host's servers treat capital letters as different, Windows doesn't.
          </span>
          <button className="btn ghost small" onClick={recheck} disabled={busy}>{busy ? 'Checking…' : 'Recheck'}</button>
        </div>
      )}
      {verify?.error && <span className="muted small">Couldn't check the files: {verify.error}</span>}
    </div>
  )
}
