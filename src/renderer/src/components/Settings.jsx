import { useState } from 'react'

function buildUrl(preset, host, port, presets) {
  const p = presets[preset]
  if (!p || preset === 'custom') return null
  return `http://${host.trim() || 'localhost'}:${port || p.port}${p.path}`
}

export default function Settings({ settings, presets, onClose, onSaved }) {
  const [ai, setAi] = useState({ ...settings.ai })
  const [projectsDir, setProjectsDir] = useState(settings.projectsDir)
  const [models, setModels] = useState(settings.ai.model ? [settings.ai.model] : [])
  const [test, setTest] = useState({ state: 'idle', msg: '' })

  const update = (patch) => {
    setAi((cur) => {
      const next = { ...cur, ...patch }
      const url = buildUrl(next.preset, next.host, next.port, presets)
      if (url) next.baseUrl = url
      return next
    })
    if (patch.preset || patch.host || patch.port || patch.baseUrl) setTest({ state: 'idle', msg: '' })
  }

  const choosePreset = (preset) => update({ preset, port: presets[preset]?.port || ai.port })

  const testConnection = async () => {
    setTest({ state: 'busy', msg: 'Connecting…' })
    try {
      const list = await window.gs.ai.models({ baseUrl: ai.baseUrl, apiKey: ai.apiKey })
      setModels(list)
      if (!list.length) setTest({ state: 'error', msg: 'Connected, but the server has no models loaded.' })
      else {
        setTest({ state: 'ok', msg: `Connected. ${list.length} model${list.length > 1 ? 's' : ''} available.` })
        if (!list.includes(ai.model)) update({ model: list.find((m) => /coder/i.test(m)) || list[0] })
      }
    } catch (e) {
      setTest({ state: 'error', msg: e.message })
    }
  }

  const save = async () => {
    await window.gs.settings.set({ ai, projectsDir })
    onSaved()
  }

  const preset = presets[ai.preset] || {}

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <h3 className="ai-heading">AI model server</h3>
        <div className="field-row">
          <label className="field">
            <span>Server type</span>
            <select value={ai.preset} onChange={(e) => choosePreset(e.target.value)}>
              {Object.entries(presets).map(([id, p]) => (
                <option key={id} value={id}>{p.label}</option>
              ))}
            </select>
          </label>
          {ai.preset !== 'custom' && (
            <>
              <label className="field grow">
                <span>Computer name or IP</span>
                <input value={ai.host} onChange={(e) => update({ host: e.target.value })} placeholder="Mac-Studio.local or 192.168.1.50" />
              </label>
              <label className="field narrow">
                <span>Port</span>
                <input type="number" value={ai.port} onChange={(e) => update({ port: Number(e.target.value) })} />
              </label>
            </>
          )}
        </div>
        {ai.preset === 'custom' ? (
          <label className="field">
            <span>Server URL (OpenAI-compatible, ending in /v1)</span>
            <input value={ai.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder="http://192.168.1.50:8000/v1" />
          </label>
        ) : (
          <p className="muted small">
            Connects to <code>{ai.baseUrl}</code>. {preset.hint}
          </p>
        )}

        <div className="field-row">
          <button className="btn ai" onClick={testConnection} disabled={test.state === 'busy'}>
            {test.state === 'busy' ? 'Connecting…' : 'Test connection'}
          </button>
          {test.msg && <span className={`test-msg ${test.state}`}>{test.msg}</span>}
        </div>

        <div className="field-row">
          <label className="field grow">
            <span>Model</span>
            <select value={ai.model} onChange={(e) => update({ model: e.target.value })} disabled={!models.length}>
              {!models.length && <option value="">Test the connection to load models</option>}
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>Creativity</span>
            <input type="number" step="0.1" min="0" max="1.5" value={ai.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} />
          </label>
        </div>

        <details className="advanced">
          <summary>Advanced</summary>
          <div className="field-row">
            <label className="field">
              <span>Max tool steps per request</span>
              <input type="number" min="5" max="100" value={ai.maxSteps} onChange={(e) => update({ maxSteps: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Automatic fix attempts</span>
              <input type="number" min="0" max="10" value={ai.autoFixRounds} onChange={(e) => update({ autoFixRounds: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Request timeout (seconds)</span>
              <input type="number" min="30" value={ai.requestTimeoutSec} onChange={(e) => update({ requestTimeoutSec: Number(e.target.value) })} />
            </label>
          </div>
          <label className="field">
            <span>API key (only if your server requires one)</span>
            <input type="password" value={ai.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
          </label>
        </details>

        <h3>Projects</h3>
        <div className="field-row">
          <label className="field grow">
            <span>Folder where games are saved</span>
            <input value={projectsDir} onChange={(e) => setProjectsDir(e.target.value)} />
          </label>
          <button
            className="btn ghost"
            onClick={async () => {
              const p = await window.gs.settings.pickFolder()
              if (p) setProjectsDir(p)
            }}
          >
            Choose…
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn play" onClick={save}>Save settings</button>
        </div>
      </div>
    </div>
  )
}
