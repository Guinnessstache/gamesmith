import { useEffect, useState } from 'react'

export function useUpdater() {
  const [st, setSt] = useState(null)
  useEffect(() => {
    window.gs.updater.status().then(setSt).catch(() => {})
    return window.gs.updater.onStatus(setSt)
  }, [])
  return st
}

const act = (fn) => fn().catch(() => {}) // errors arrive as a status

/** Bottom-corner notice when a new version is ready to download or install. */
export function UpdateNotice() {
  const st = useUpdater()
  const [hidden, setHidden] = useState(null) // the version the user dismissed
  const [notes, setNotes] = useState(false)
  if (!st || !['available', 'downloading', 'ready'].includes(st.state) || hidden === st.latest) return null
  return (
    <div className="update-notice" role="status">
      <div className="update-head">
        <strong>
          {st.state === 'ready' ? `Gamesmith ${st.latest} is ready` : `Gamesmith ${st.latest} is available`}
        </strong>
        {st.state === 'available' && (
          <button className="tab-x" aria-label="Not now" onClick={() => setHidden(st.latest)}>×</button>
        )}
      </div>
      {st.state === 'downloading' ? (
        <div className="progress-block">
          <div className="progress"><span style={{ width: `${st.percent || 0}%` }} /></div>
          <span className="small muted">Downloading… {st.percent || 0}%</span>
        </div>
      ) : st.state === 'ready' ? (
        <>
          <p className="small muted">Restart to finish. Your games and models aren't affected.</p>
          <button className="btn play small" onClick={() => act(window.gs.updater.install)}>Restart to update</button>
        </>
      ) : (
        <>
          <p className="small muted">You have {st.version}.</p>
          <div className="update-actions">
            <button className="btn play small" onClick={() => act(window.gs.updater.download)}>Update now</button>
            {st.notes && <button className="btn ghost small" onClick={() => setNotes((n) => !n)}>{notes ? 'Hide' : "What's new"}</button>}
          </div>
          {notes && <pre className="update-notes">{st.notes}</pre>}
        </>
      )}
    </div>
  )
}

/** The Updates section in Settings. */
export function UpdateSettings() {
  const st = useUpdater()
  if (!st) return null
  if (st.mode === 'source') {
    return (
      <p className="muted small">
        Version {st.version}, running from source. Updates here are for the installed app; this copy is updated with git (git pull, then npm install).
      </p>
    )
  }
  const line = {
    idle: '',
    checking: 'Checking…',
    current: "You're up to date.",
    available: `Version ${st.latest} is available.`,
    downloading: `Downloading ${st.latest}… ${st.percent || 0}%`,
    ready: `Version ${st.latest} is downloaded. Restart to install it.`,
    error: st.error
  }[st.state]
  return (
    <div className="field-row">
      <span className="grow-text">
        Version {st.version}. {line && <span className={st.state === 'error' ? 'test-msg error' : 'muted'}>{line}</span>}
      </span>
      {st.state === 'available' && <button className="btn play small" onClick={() => act(window.gs.updater.download)}>Update now</button>}
      {st.state === 'ready' && <button className="btn play small" onClick={() => act(window.gs.updater.install)}>Restart to update</button>}
      {!['available', 'ready', 'downloading', 'checking'].includes(st.state) && (
        <button className="btn ghost small" onClick={() => act(window.gs.updater.check)}>Check for updates</button>
      )}
    </div>
  )
}
