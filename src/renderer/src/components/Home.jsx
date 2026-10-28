import { useEffect, useState } from 'react'
import { AiBadge, TemplateGlyph, timeAgo } from './ui.jsx'

export default function Home({ settings, onOpen, onOpenStudio, onOpenSettings, error }) {
  const [projects, setProjects] = useState(null)
  const [templates, setTemplates] = useState([])
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

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
        <button className="btn ghost" onClick={onOpenStudio}>⬢ My 3D models</button>
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
          <button className="project-card new import" onClick={() => setImporting(true)}>
            <span className="plus" aria-hidden>↓</span>
            <span className="project-name">Bring in a game</span>
            <span className="project-sub">From GitHub, an HTML file, or a folder</span>
          </button>
          <button className="project-card new studio-card" onClick={onOpenStudio}>
            <span className="plus" aria-hidden>⬢</span>
            <span className="project-name">Make a 3D model</span>
            <span className="project-sub">Describe it; the AI builds it in Blender</span>
          </button>
          {projects === null && <div className="muted pad">Loading…</div>}
          {projects?.map((p) => (
            <button key={p.dir} className="project-card" onClick={() => onOpen(p.dir)}>
              <TemplateGlyph template={p.template} engine={p.engine} />
              <span className="project-name">{p.name}</span>
              <span className="project-sub">
                {p.engine}{p.kind === 'node' ? ' with its own server' : ''}, edited {timeAgo(p.modified)}
              </span>
            </button>
          ))}
        </section>
        <p className="muted small">Games are saved in {settings.projectsDir}</p>
      </main>

      {importing && (
        <ImportDialog
          onCancel={() => setImporting(false)}
          onImported={(p) => {
            setImporting(false)
            onOpen(p.dir)
          }}
        />
      )}
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

function ImportDialog({ onCancel, onImported }) {
  const [ref, setRef] = useState('')
  const [repos, setRepos] = useState(null)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState(null)

  useEffect(() => {
    window.gs.projects.githubRepos().then(setRepos).catch(() => setRepos([]))
    return window.gs.projects.onImportProgress(setProgress)
  }, [])

  const run = async (label, fn) => {
    setBusy(label)
    setErr('')
    try {
      const p = await fn()
      if (!p) return setBusy('')
      if (p.lineEndingsFixed || p.startedTracking || p.imported?.source === 'html') {
        setNote({ p, lineEndings: p.lineEndingsFixed, tracking: p.startedTracking, html: p.imported?.source === 'html' })
        setBusy('')
        return
      }
      onImported(p)
    } catch (e) {
      setErr(e.message)
      setBusy('')
    }
  }

  if (note) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>Opened {note.p.name}</h2>
          {note.html && (
            <>
              <p>
                Made a new game from <strong>{note.p.imported.from}</strong>
                {note.p.engine !== 'JavaScript' ? ` (${note.p.engine})` : ''}.
                {note.p.splitInto?.length > 0 && <> To make it easier for the AI to work on, it's split into <code>index.html</code>{note.p.splitInto.map((f) => <span key={f}>, <code>{f}</code></span>)}. The game works exactly as before, and the original file is the first version in History.</>}
              </p>
              {note.p.needsInternet?.length > 0 && (
                <p className="muted">
                  It loads {note.p.imported.libraries?.length ? note.p.imported.libraries.join(', ') : 'libraries'} from {note.p.needsInternet.join(', ')}, so the preview needs an internet connection. Published versions work the same way.
                </p>
              )}
              {note.p.missing?.length > 0 && (
                <div className="notice">
                  <span>
                    The page refers to {note.p.missing.length} file{note.p.missing.length > 1 ? 's' : ''} that weren't part of the import: {note.p.missing.slice(0, 6).map((f) => <code key={f}>{f} </code>)}
                    {note.p.missing.length > 6 ? '…' : ''} Add them in the game's Files panel (Add assets), or ask the AI to replace them.
                  </span>
                </div>
              )}
            </>
          )}
          {note.tracking && !note.html && <p>This folder wasn't using git, so Gamesmith started tracking its history there (a hidden .git folder). That's what makes Undo and History work.</p>}
          {note.lineEndings && (
            <p>
              This copy has Windows line endings, which Gamesmith's built-in git would have seen as changes to every file. Gamesmith turned on line-ending conversion
              (<code>core.autocrlf</code>) for this repository only, which is what Git for Windows already does.
            </p>
          )}
          <div className="modal-actions">
            <button className="btn play" onClick={() => onImported(note.p)}>Open the game</button>
          </div>
        </div>
      </div>
    )
  }

  const pct = progress?.total ? Math.round((progress.loaded / progress.total) * 100) : null
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onCancel}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Bring in a game</h2>
        <p className="muted">
          Gamesmith works with games made elsewhere too: plain HTML/JavaScript games, and games that run their own server (it runs <code>npm start</code> for you).
        </p>
        <h3>From GitHub</h3>
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault()
            run('github', () => window.gs.projects.importGitHub(ref))
          }}
        >
          <label className="field grow">
            <span>Repository (owner/name or URL)</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Guinnessstache/shattered-crown" autoFocus />
          </label>
          <button className="btn play" disabled={!ref.trim() || !!busy}>
            {busy === 'github' ? (progress ? `${progress.phase}${pct != null ? ` ${pct}%` : ''}…` : 'Downloading…') : 'Import'}
          </button>
        </form>
        {repos?.length > 0 && (
          <div className="repo-pick">
            <span className="muted small">Your repositories, most recently updated first:</span>
            <ul>
              {repos.slice(0, 12).map((r) => (
                <li key={r.fullName}>
                  <button className={`repo-row ${ref === r.fullName ? 'on' : ''}`} onClick={() => setRef(r.fullName)} disabled={!!busy}>
                    <strong>{r.name}</strong>
                    {r.private && <span className="tag">private</span>}
                    <span className="muted small">{r.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {repos?.length === 0 && <p className="muted small">Connect GitHub (Publish panel or Settings) to pick from your repositories, including private ones.</p>}

        <h3>From a single HTML file</h3>
        <div className="field-row">
          <span className="grow-text muted small">A whole game in one .html file, like one an AI chat made for you. It becomes a new game you can keep building on.</span>
          <button className="btn ghost" onClick={() => run('html', () => window.gs.projects.importHtml())} disabled={!!busy}>
            {busy === 'html' ? 'Importing…' : 'Choose .html file…'}
          </button>
        </div>

        <h3>From a folder on this PC</h3>
        <div className="field-row">
          <span className="grow-text muted small">Opens the game where it is; nothing is copied. Gamesmith keeps its own data in a hidden .gamesmith folder that git ignores.</span>
          <button className="btn ghost" onClick={() => run('folder', () => window.gs.projects.openFolder())} disabled={!!busy}>
            {busy === 'folder' ? 'Opening…' : 'Choose folder…'}
          </button>
        </div>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel} disabled={!!busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
