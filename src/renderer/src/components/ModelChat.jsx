import { useEffect, useRef, useState } from 'react'

const STARTERS = [
  'A wooden treasure chest with gold trim',
  'A low-poly pine tree, about 4 m tall',
  'A medieval wooden door with iron hinges',
  'A simple sci-fi crate with glowing edges',
  'A blocky knight with idle, walk and attack animations'
]
const FOLLOW_UPS = ['Animate it', 'Add more detail', 'Make it bigger', 'Use fewer triangles', 'Change the colors']

const TOOL_LABELS = {
  read_script: () => 'Read the script',
  write_script: () => 'Wrote the script',
  edit_script: () => 'Edited the script',
  build_model: () => 'Built it in Blender'
}

function cleanText(t) {
  return t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '').trim()
}

/** AI chat for the Blender tab: one conversation per library asset. */
export default function ModelChat({ asset, settings, onOpenSettings, onRunFinished, blenderReady, autoPrompt, onAutoPromptUsed }) {
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [live, setLive] = useState(null)
  const scrollRef = useRef(null)
  const id = asset?.meta.id

  const [elsewhere, setElsewhere] = useState(null) // the AI is busy with a different model
  const idRef = useRef(id)
  idRef.current = id

  // Switching models (or coming back to this tab) while the AI is still working:
  // pick its progress back up instead of looking idle.
  useEffect(() => {
    setTurns(asset?.chat || [])
    setElsewhere(null)
    let gone = false
    window.gs.model.status().then((run) => {
      if (gone || !run) return
      if (run.assetId === id) setLive((cur) => cur || { segments: [], status: run.status || 'Working…', attached: true })
      else setElsewhere(run)
    })
    return () => {
      gone = true
      setLive((cur) => (cur?.attached ? null : cur))
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () =>
      window.gs.model.onEvent((ev) => {
        if (ev.type === 'build') onRunFinished?.({ partial: true })
        if (ev.assetId !== idRef.current) {
          if (ev.type === 'done' || ev.type === 'error') setElsewhere(null)
          return
        }
        if (ev.type === 'done' || ev.type === 'error') {
          // A run this view only re-attached to: its send() isn't waiting, so finish up here.
          setLive((cur) => {
            if (cur?.attached) {
              window.gs.library.get(ev.assetId).then((a) => idRef.current === ev.assetId && setTurns(a.chat || []))
              onRunFinished?.({})
              return null
            }
            return cur
          })
          return
        }
        setLive((cur) => {
          if (!cur) return cur
          const segs = [...cur.segments]
          const last = segs[segs.length - 1]
          switch (ev.type) {
            case 'status':
              return { ...cur, status: ev.text }
            case 'turn_start':
              segs.push({ kind: 'text', text: '' })
              return { ...cur, segments: segs }
            case 'delta':
              if (last?.kind === 'text') segs[segs.length - 1] = { ...last, text: last.text + (ev.content || '') }
              return { ...cur, segments: segs }
            case 'tool_start':
              segs.push({ kind: 'tool', id: ev.id, name: ev.name, state: 'running' })
              return { ...cur, segments: segs }
            case 'tool_end':
              return { ...cur, segments: segs.map((s) => (s.kind === 'tool' && s.id === ev.id ? { ...s, state: ev.ok ? 'ok' : 'error', result: ev.result } : s)) }
            case 'build':
              segs.push({ kind: 'build', result: ev.result })
              return { ...cur, segments: segs }
            default:
              return cur
          }
        })
      }),
    [onRunFinished]
  )

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, live])

  const running = !!live
  const send = async (text) => {
    const msg = (text ?? input).trim()
    if (!msg || running || !id) return
    setInput('')
    setTurns((t) => [...t, { role: 'user', content: msg }])
    setLive({ segments: [], status: 'Thinking…' })
    try {
      const r = await window.gs.model.run(id, msg)
      setTurns((t) => [...t, { role: 'assistant', content: r.reply, steps: r.steps }])
    } catch (e) {
      setTurns((t) => [...t, { role: 'assistant', content: `⚠ ${e.message}`, error: true }])
    } finally {
      setLive(null)
      onRunFinished?.({})
    }
  }

  const clear = async () => {
    if (!confirm('Clear this conversation? The model is not changed.')) return
    await window.gs.library.clearChat(id)
    setTurns([])
  }

  const noModel = !settings.ai.model
  const disabled = noModel || !blenderReady || !id || !!elsewhere

  // A description typed in the New model dialog goes straight to the AI.
  useEffect(() => {
    if (!autoPrompt || autoPrompt.id !== id || running) return
    onAutoPromptUsed?.()
    if (disabled) setInput(autoPrompt.text) // can't run yet: leave it ready in the box
    else send(autoPrompt.text)
  }, [autoPrompt, id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="chat">
      <div className="chat-head">
        <h2>Model with AI</h2>
        <div className="spacer" />
        {turns.length > 0 && !running && <button className="btn tiny ghost" onClick={clear}>Clear chat</button>}
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {!id && <div className="chat-empty"><p>Pick an asset from your library, or make a new one, to start modeling.</p></div>}
        {id && turns.length === 0 && !running && (
          <div className="chat-empty">
            <p>Describe the model. The AI writes a Blender script, builds it, checks the size, and fixes its own errors. Every version is saved, so you can always go back.</p>
            <div className="suggestions">
              {STARTERS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)} disabled={disabled}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="msg user">{t.content}</div>
          ) : (
            <div key={i} className={`msg ai ${t.error ? 'error' : ''}`}>
              {t.steps?.length > 0 && (
                <details className="steps">
                  <summary>{t.steps.length} step{t.steps.length > 1 ? 's' : ''}</summary>
                  <ul>
                    {t.steps.map((st, j) => (
                      <li key={j} className={st.ok === false ? 'failed' : ''}>{(TOOL_LABELS[st.name] || (() => st.name))()}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="msg-text">{t.content}</div>
              {t.build && <BuildBadge result={t.build} />}
            </div>
          )
        )}
        {live && (
          <div className="msg ai live">
            {live.segments.map((s, i) => {
              if (s.kind === 'tool') {
                return (
                  <details key={i} className={`tool ${s.state}`}>
                    <summary>
                      <span className="tool-dot" aria-hidden />
                      {(TOOL_LABELS[s.name] || (() => s.name))()}
                    </summary>
                    {s.result && <pre>{s.result}</pre>}
                  </details>
                )
              }
              if (s.kind === 'build') return <BuildBadge key={i} result={s.result} />
              const text = cleanText(s.text)
              return text ? <div key={i} className="msg-text">{text}</div> : null
            })}
            <div className="status"><span className="spinner" aria-hidden /> {live.status}</div>
          </div>
        )}
      </div>
      {elsewhere && (
        <div className="notice busy-elsewhere">
          <span>The AI is still working on <strong>{elsewhere.name}</strong>.</span>
          <button className="btn small stop" onClick={() => window.gs.model.stop()}>Stop it</button>
        </div>
      )}
      {id && !disabled && turns.length > 0 && !running && (
        <div className="follow-ups">
          {FOLLOW_UPS.slice(0, 4).map((f) => (
            <button key={f} className="chip" onClick={() => send(f)}>{f}</button>
          ))}
        </div>
      )}
      {noModel ? (
        <div className="chat-input disabled">
          <span>Choose a model to start.</span>
          <button className="btn ai" onClick={onOpenSettings}>Connect AI</button>
        </div>
      ) : !blenderReady ? (
        <div className="chat-input disabled"><span>Set up Blender first, then describe a model here.</span></div>
      ) : (
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={running ? 'The AI is modeling…' : id ? 'Describe the model or what to change' : 'Pick an asset first'}
            rows={3}
            disabled={running || !id}
          />
          {running ? (
            <button type="button" className="btn stop" onClick={() => window.gs.model.stop()}>Stop</button>
          ) : (
            <button className="btn ai" disabled={!input.trim() || !id}>Send</button>
          )}
        </form>
      )}
    </div>
  )
}

export function BuildBadge({ result }) {
  if (!result) return null
  if (result.ok) {
    const s = result.stats
    return <div className="check ok">Built: {s ? `${s.size_m.width} × ${s.size_m.depth} × ${s.size_m.height} m, ${s.triangles.toLocaleString()} triangles` : 'OK'}</div>
  }
  return (
    <details className="check bad">
      <summary>Blender error</summary>
      <pre>{result.error}{result.where ? `\n${result.where}` : ''}</pre>
    </details>
  )
}
