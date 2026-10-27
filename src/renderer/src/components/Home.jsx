import { useEffect, useState } from 'react'
import { AiBadge, TemplateGlyph, timeAgo } from './ui.jsx'

export default function Home({ settings, onOpen, onOpenSettings, error }) {
  const [projects, setProjects] = useState(null)
  const [templates, setTemplates] = useState([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    window.gs.projects.list().then(setProjects)
    window.gs.projects.templates().then(setTemplates)
  }, [])

  const aiReady = !!settings.ai.model

  return (
    <div className="home">
      <header className="home-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span> Gamesmith
        </div>
        <div className="spacer" />
        <AiBadge settings={settings} onClick={onOpenSettings} />
        <button className="btn ghost" onClick={onOpenSettings}>Settings</button>
      </header>

      <main className="home-main">
        <section className="home-intro">
          <h1>What are you building today?</h1>
          <p>Describe your game to the AI, watch it come to life in the preview, and change anything by asking.</p>
          {!aiReady && (
            <div className="notice">
              <strong>Connect your AI first.</strong> Point Gamesmith at the model server on your Mac Studio (Ollama, LM Studio or llama.cpp).
              <button className="btn ai" onClick={onOpenSettings}>Connect AI</button>
            </div>
          )}
          {error && <div className="notice error">{error}</div>}
        </section>

        <section className="project-grid">
          <button className="project-card new" onClick={() => setCreating(true)}>
            <span className="plus" aria-hidden>+</span>
            <span className="project-name">New game</span>
            <span className="project-sub">Start from a 2D or 3D template</span>
          </button>
          {projects === null && <div className="muted pad">Loading…</div>}
          {projects?.map((p) => (
            <button key={p.dir} className="project-card" onClick={() => onOpen(p.dir)}>
              <TemplateGlyph template={p.template} />
              <span className="project-name">{p.name}</span>
              <span className="project-sub">
                {p.engine}, edited {timeAgo(p.modified)}
              </span>
            </button>
          ))}
        </section>
        <p className="muted small">Games are saved in {settings.projectsDir}</p>
      </main>

      {creating && (
        <NewGameDialog
          templates={templates}
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false)
            onOpen(p.dir)
          }}
        />
      )}
    </div>
  )
}

function NewGameDialog({ templates, onCancel, onCreated }) {
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState(templates[0]?.id || 'phaser-2d')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const create = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr('')
    try {
      onCreated(await window.gs.projects.create({ name: name.trim(), templateId }))
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={create}>
        <h2>New game</h2>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Space Goats" />
        </label>
        <div className="field">
          <span>Kind of game</span>
          <div className="template-choices">
            {templates.map((t) => (
              <button
                type="button"
                key={t.id}
                className={`template-choice ${templateId === t.id ? 'selected' : ''}`}
                onClick={() => setTemplateId(t.id)}
              >
                <TemplateGlyph template={t.id} />
                <strong>{t.name}</strong>
                <span className="muted small">{t.engine}</span>
                <span className="small">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn play" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create game'}</button>
        </div>
      </form>
    </div>
  )
}
