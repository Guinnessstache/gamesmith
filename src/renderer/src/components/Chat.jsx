import { useEffect, useRef, useState } from 'react'

const SUGGESTIONS = {
  'phaser-2d': ['Add enemies that patrol the platforms', 'Add a title screen and a game over screen', 'Give the player a double jump', 'Add a timer and a high score'],
  'three-3d': ['Add obstacles that bump the ball away', 'Add a jump with the space bar', 'Make gems worth more the faster you collect them', 'Add a 60-second timer and a final score screen']
}

// Shown above the input once the conversation has started.
const FOLLOW_UPS = {
  'phaser-2d': ['Add a title screen', 'Add sound effects', 'Add enemies', 'Add a second level', 'Make it harder over time', 'Add a pause menu', 'Polish the visuals'],
  'three-3d': ['Add a title screen', 'Add sound effects', 'Add obstacles', 'Add a timer', 'Make the camera smoother', 'Add a pause menu', 'Polish the lighting']
}

const TOOL_LABELS = {
  list_files: () => 'Looked at the files',
  read_file: (a) => `Read ${a.path || 'a file'}`,
  edit_file: (a) => `Edited ${a.path || 'a file'}`,
  write_file: (a) => `Wrote ${a.path || 'a file'}`,
  delete_file: (a) => `Deleted ${a.path || 'a file'}`,
  check_game: () => 'Ran the game'
}

function cleanText(t) {
  return t
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .trim()
}
function thinkingOf(seg) {
  const tags = [...seg.text.matchAll(/<think>([\s\S]*?)(<\/think>|$)/g)].map((m) => m[1]).join('\n')
  return (seg.reasoning + tags).trim()
}

export default function Chat({ project, settings, onOpenSettings, onOpenFile, onRunFinished, draft, onDraftUsed }) {
  const [turns, setTurns] = useState(project.chat || [])
  const [input, setInput] = useState('')
  const [live, setLive] = useState(null) // { segments: [], status }
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  // "Ask AI to use it" from the asset browser drops a started sentence here.
  useEffect(() => {
    if (!draft) return
    setInput(draft)
    onDraftUsed?.()
    setTimeout(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }, 0)
  }, [draft, onDraftUsed])
  const running = !!live

  useEffect(() => {
    return window.gs.ai.onEvent((ev) => {
      setLive((cur) => {
        if (!cur) return cur
        const segs = [...cur.segments]
        const last = segs[segs.length - 1]
        switch (ev.type) {
          case 'status':
            return { ...cur, status: ev.text }
          case 'turn_start':
            segs.push({ kind: 'text', text: '', reasoning: '' })
            return { ...cur, segments: segs }
          case 'delta':
            if (last?.kind === 'text') {
              segs[segs.length - 1] = { ...last, text: last.text + (ev.content || ''), reasoning: last.reasoning + (ev.reasoning || '') }
            }
            return { ...cur, segments: segs }
          case 'tool_start':
            segs.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, state: 'running' })
            return { ...cur, segments: segs }
          case 'tool_end':
            return {
              ...cur,
              segments: segs.map((s) => (s.kind === 'tool' && s.id === ev.id ? { ...s, state: ev.ok ? 'ok' : 'error', result: ev.result } : s))
            }
          case 'check':
            segs.push({ kind: 'check', result: ev.result })
            return { ...cur, segments: segs }
          default:
            return cur
        }
      })
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, live])

  const send = async (text) => {
    const msg = (text ?? input).trim()
    if (!msg || running) return
    setInput('')
    setTurns((t) => [...t, { role: 'user', content: msg, time: Date.now() }])
    setLive({ segments: [], status: 'Thinking…' })
    try {
      const result = await window.gs.ai.run(msg)
      setTurns((t) => [...t, { role: 'assistant', content: result.reply, changedFiles: result.changedFiles, addedAssets: result.addedAssets, check: result.check, time: Date.now(), commit: result.commit, steps: result.steps }])
    } catch (e) {
      setTurns((t) => [...t, { role: 'assistant', content: `⚠ ${e.message}`, error: true, time: Date.now() }])
    } finally {
      setLive(null)
      onRunFinished()
    }
  }

  const undo = async (turn) => {
    const log = await window.gs.git.log()
    const idx = log.findIndex((c) => c.oid === turn.commit)
    const before = idx >= 0 ? log[idx + 1] : null
    if (!before) return alert('That version is no longer in the history.')
    if (!confirm('Undo the changes the AI made in this step?')) return
    await window.gs.git.restore(before.oid)
    setTurns((t) => t.map((x) => (x === turn ? { ...x, undone: true } : x)))
    onRunFinished()
  }

  const clear = async () => {
    if (!confirm('Clear the conversation? Your game files are not changed.')) return
    await window.gs.ai.clearChat()
    setTurns([])
  }

  const noModel = !settings.ai.model

  return (
    <div className="chat">
      <div className="chat-head">
        <h2>Build with AI</h2>
        <div className="spacer" />
        {turns.length > 0 && !running && (
          <button className="btn tiny ghost" onClick={clear}>Clear chat</button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !running && (
          <div className="chat-empty">
            <p>Tell the AI what to build or change. It edits the code, runs the game, and fixes its own errors.</p>
            <div className="suggestions">
              {(SUGGESTIONS[project.meta.template] || []).map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)} disabled={noModel}>{s}</button>
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
                      <li key={j} className={st.ok === false ? 'failed' : ''}>
                        {(TOOL_LABELS[st.name] || (() => st.name))({ path: st.path })}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="msg-text">{t.content}</div>
              {t.addedAssets?.length > 0 && <div className="small added-assets">Added assets: {t.addedAssets.join(', ')}</div>}
              {t.changedFiles?.length > 0 && (
                <div className="changed">
                  {t.changedFiles.map((f) => (
                    <button key={f} className="file-chip" onClick={() => onOpenFile(f)}>{f}</button>
                  ))}
                </div>
              )}
              <div className="msg-foot">
                {t.check && <CheckBadge result={t.check} />}
                {t.commit && (t.changedFiles?.length > 0 || t.addedAssets?.length > 0) && !t.undone && (
                  <button className="btn tiny ghost" onClick={() => undo(t)} disabled={running}>Undo these changes</button>
                )}
                {t.undone && <span className="muted small">Undone</span>}
              </div>
            </div>
          )
        )}

        {live && (
          <div className="msg ai live">
            {live.segments.map((s, i) => {
              if (s.kind === 'tool') {
                const label = (TOOL_LABELS[s.name] || ((a) => `${s.name}`))(s.args || {})
                return (
                  <details key={i} className={`tool ${s.state}`}>
                    <summary>
                      <span className="tool-dot" aria-hidden />
                      {label}
                    </summary>
                    {s.result && <pre>{s.result}</pre>}
                  </details>
                )
              }
              if (s.kind === 'check') return <CheckBadge key={i} result={s.result} />
              const text = cleanText(s.text)
              const thinking = thinkingOf(s)
              return (
                <div key={i}>
                  {thinking && (
                    <details className="thinking">
                      <summary>Thinking</summary>
                      <pre>{thinking}</pre>
                    </details>
                  )}
                  {text && <div className="msg-text">{text}</div>}
                </div>
              )
            })}
            <div className="status">
              <span className="spinner" aria-hidden /> {live.status}
            </div>
          </div>
        )}
      </div>

      {!noModel && turns.length > 0 && !running && (
        <div className="follow-ups">
          {(FOLLOW_UPS[project.meta.template] || [])
            .filter((f) => !turns.some((t) => t.role === 'user' && t.content === f))
            .slice(0, 4)
            .map((f) => (
              <button key={f} className="chip" onClick={() => send(f)}>{f}</button>
            ))}
        </div>
      )}
      {noModel ? (
        <div className="chat-input disabled">
          <span>Choose a model to start building.</span>
          <button className="btn ai" onClick={onOpenSettings}>Connect AI</button>
        </div>
      ) : (
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={running ? 'The AI is working…' : 'Describe what to add or change'}
            rows={3}
            disabled={running}
          />
          {running ? (
            <button type="button" className="btn stop" onClick={() => window.gs.ai.stop()}>Stop</button>
          ) : (
            <button className="btn ai" disabled={!input.trim()}>Send</button>
          )}
        </form>
      )}
    </div>
  )
}

function CheckBadge({ result }) {
  if (!result) return null
  if (result.note) return <div className="check neutral">{result.note}</div>
  if (result.ok) return <div className="check ok">Game runs without errors</div>
  return (
    <details className="check bad">
      <summary>{result.errors?.length || 0} error{result.errors?.length === 1 ? '' : 's'} when running the game</summary>
      {result.errors?.map((e, i) => (
        <pre key={i}>{e}</pre>
      ))}
    </details>
  )
}
