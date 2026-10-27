import { useEffect, useState } from 'react'
import { timeAgo } from './ui.jsx'

// Every AI request and every manual save is a version. Restoring is itself
// saved as a new version, so nothing is ever lost.
export default function HistoryPanel({ tick }) {
  const [log, setLog] = useState(null)
  const [busy, setBusy] = useState('')

  const load = () => window.gs.git.log().then(setLog)
  useEffect(() => {
    load()
  }, [tick])

  const restore = async (c) => {
    if (!confirm(`Restore the game to this version?\n\n"${c.message}"\n\nYour current version is saved first, so you can come back to it.`)) return
    setBusy(c.oid)
    try {
      await window.gs.git.restore(c.oid)
      await load()
    } catch (e) {
      alert(e.message)
    } finally {
      setBusy('')
    }
  }

  const saveNow = async () => {
    await window.gs.git.snapshot('Saved by you')
    load()
  }

  if (!log) return <div className="muted pad">Loading…</div>
  return (
    <div className="history">
      <div className="tree-actions">
        <button className="btn small ghost" onClick={saveNow}>Save a version now</button>
      </div>
      <ol className="history-list">
        {log.map((c, i) => (
          <li key={c.oid} className={c.message.startsWith('AI') ? 'ai' : ''}>
            <div className="h-msg">{c.message}</div>
            <div className="h-meta">
              <span className="muted small">{timeAgo(c.time)}</span>
              {i === 0 ? (
                <span className="tag">current</span>
              ) : (
                <button className="btn tiny ghost" disabled={!!busy} onClick={() => restore(c)}>
                  {busy === c.oid ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
