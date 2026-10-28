import { useEffect, useRef, useState } from 'react'

const SERVER_LABEL = { installing: 'Installing packages…', starting: 'Starting server…', running: 'Server running', crashed: 'Server stopped', stopped: 'Server stopped' }

export default function Preview({ url, serverGame = false, initialServer = null }) {
  const [server, setServer] = useState(initialServer)
  useEffect(() => {
    if (!serverGame) return
    return window.gs.preview.onServerStatus(setServer)
  }, [serverGame])
  const [entries, setEntries] = useState([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [reloadedAt, setReloadedAt] = useState(Date.now())
  const listRef = useRef(null)
  const frameRef = useRef(null)

  useEffect(() => {
    const offC = window.gs.preview.onConsole((e) => setEntries((xs) => [...xs.slice(-299), e]))
    const offR = window.gs.preview.onReloading(() => {
      setEntries((xs) => xs.filter((e) => e.server).slice(-80))
      setReloadedAt(Date.now())
    })
    return () => {
      offC()
      offR()
    }
  }, [])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [entries, consoleOpen])

  const errors = entries.filter((e) => e.level === 'error').length
  const warnings = entries.filter((e) => e.level === 'warn').length

  return (
    <div className="preview">
      <div className="preview-bar">
        <button className="btn play small" onClick={() => window.gs.preview.reload()} title="Restart the game">
          ↻ Restart
        </button>
        <button className="btn ghost small" onClick={() => frameRef.current?.focus()} title="Give keyboard focus to the game">
          Focus game
        </button>
        <button className="btn ghost small" onClick={() => window.gs.preview.openExternal()}>Open in browser</button>
        {serverGame && (
          <div className={`server-chip ${server?.state || 'starting'}`} title={server?.detail || ''}>
            <span className="dot" aria-hidden />
            {SERVER_LABEL[server?.state] || 'Starting server…'}
            <button className="btn tiny ghost" onClick={() => window.gs.preview.restartServer()}>Restart server</button>
          </div>
        )}
        <div className="spacer" />
        <button className={`console-toggle ${errors ? 'has-errors' : ''}`} onClick={() => setConsoleOpen((o) => !o)}>
          Console
          {errors > 0 && <span className="count err">{errors} error{errors > 1 ? 's' : ''}</span>}
          {warnings > 0 && <span className="count warn">{warnings}</span>}
          <span className="caret">{consoleOpen ? '▾' : '▴'}</span>
        </button>
      </div>
      <div className="stage">
        <iframe ref={frameRef} key={url} src={url} title="Game preview" allow="autoplay; fullscreen; gamepad; pointer-lock" />
      </div>
      {consoleOpen && (
        <div className="console" ref={listRef}>
          {!entries.length && <div className="muted small pad">Nothing logged since the game started {Math.round((Date.now() - reloadedAt) / 1000)}s ago.</div>}
          {entries.map((e, i) => (
            <pre key={i} className={`log ${e.level} ${e.server ? 'server' : ''}`}>{e.server && <span className="log-src">server</span>}{e.text}</pre>
          ))}
        </div>
      )}
    </div>
  )
}
