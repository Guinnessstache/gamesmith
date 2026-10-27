import { useEffect, useRef, useState } from 'react'

export default function Preview({ url }) {
  const [entries, setEntries] = useState([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [reloadedAt, setReloadedAt] = useState(Date.now())
  const listRef = useRef(null)
  const frameRef = useRef(null)

  useEffect(() => {
    const offC = window.gs.preview.onConsole((e) => setEntries((xs) => [...xs.slice(-299), e]))
    const offR = window.gs.preview.onReloading(() => {
      setEntries([])
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
            <pre key={i} className={`log ${e.level}`}>{e.text}</pre>
          ))}
        </div>
      )}
    </div>
  )
}
