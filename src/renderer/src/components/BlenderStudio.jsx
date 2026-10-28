import { useCallback, useEffect, useState } from 'react'
import ModelViewer from './ModelViewer.jsx'
import CodeEditor from './CodeEditor.jsx'
import { BuildBadge } from './ModelChat.jsx'
import { timeAgo } from './ui.jsx'

/** State shared by the Blender tab's center view and its AI chat. */
export function useModelStudio() {
  const [blender, setBlender] = useState(null)
  const [list, setList] = useState(null)
  const [assetId, setAssetId] = useState(null)
  const [asset, setAsset] = useState(null)
  const [pendingPrompt, setPendingPrompt] = useState(null) // { id, text }: send to the AI once the new asset is open

  const refreshList = useCallback(async () => {
    const l = await window.gs.library.list()
    setList(l)
    return l
  }, [])
  const refreshAsset = useCallback(async (id) => {
    if (!id) return setAsset(null)
    try {
      setAsset(await window.gs.library.get(id))
    } catch {
      setAsset(null)
    }
  }, [])

  useEffect(() => {
    window.gs.blender.status().then(setBlender)
    refreshList().then((l) => l[0] && setAssetId((cur) => cur || l[0].id))
  }, [refreshList])
  useEffect(() => {
    refreshAsset(assetId)
  }, [assetId, refreshAsset])

  const refresh = useCallback(async () => {
    await Promise.all([refreshList(), refreshAsset(assetId)])
  }, [refreshList, refreshAsset, assetId])

  return { blender, setBlender, list, assetId, select: setAssetId, asset, refresh, refreshList, pendingPrompt, setPendingPrompt }
}

export default function BlenderStudio({ studio, project }) {
  const { blender, list, assetId, select, asset, refresh, refreshList } = studio
  const [view, setView] = useState('model') // model | image | script
  const [creating, setCreating] = useState(false)

  if (!blender) return <div className="studio"><div className="muted pad">Looking for Blender…</div></div>
  if (!blender.found) return <BlenderSetup studio={studio} />

  return (
    <div className="studio">
      <div className="studio-body">
        <aside className="lib">
          <div className="lib-head">
            <h3>My library</h3>
            <div className="spacer" />
            <button className="btn small play" onClick={() => setCreating(true)}>+ New</button>
          </div>
          <div className="lib-list">
            {list === null && <div className="muted small pad">Loading…</div>}
            {list?.length === 0 && <p className="muted small pad">Nothing here yet. Make your first model with <strong>+ New</strong>, and you can reuse it in every game.</p>}
            {list?.map((a) => (
              <button key={a.id} className={`lib-item ${a.id === assetId ? 'on' : ''}`} onClick={() => select(a.id)}>
                {a.preview ? <img src={a.preview} alt="" /> : <span className="lib-thumb" aria-hidden>◆</span>}
                <span className="lib-text">
                  <span className="asset-name">{a.name}</span>
                  <span className="muted small">{a.hasModel ? `${a.stats?.triangles?.toLocaleString() ?? '?'} tris` : 'not built yet'} · {timeAgo(a.updated)}</span>
                </span>
              </button>
            ))}
          </div>
          <LibraryGitHub count={list?.length || 0} />
        </aside>

        <section className="studio-main">
          {!asset ? (
            <div className="studio-empty muted">{list?.length ? 'Pick a model on the left.' : 'Click + New to start your first model.'}</div>
          ) : (
            <AssetView key={asset.meta.id} asset={asset} view={view} setView={setView} project={project} onChanged={refresh} blender={blender} />
          )}
        </section>
      </div>
      {creating && (
        <NewAssetDialog
          onCancel={() => setCreating(false)}
          onCreated={async (id, description) => {
            setCreating(false)
            if (description) studio.setPendingPrompt({ id, text: description })
            await refreshList()
            select(id)
          }}
        />
      )}
    </div>
  )
}

function AssetView({ asset, view, setView, project, onChanged, blender }) {
  const { meta } = asset
  const [script, setScript] = useState(asset.script)
  const [savedScript, setSavedScript] = useState(asset.script)
  const [building, setBuilding] = useState(false)
  const [lastBuild, setLastBuild] = useState(null)
  const [msg, setMsg] = useState('')
  const [wire, setWire] = useState(false)

  // The AI changes the script too: take its version unless there are unsaved edits here.
  useEffect(() => {
    if (script === savedScript) setScript(asset.script)
    setSavedScript(asset.script)
  }, [asset.script]) // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (m) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 5000)
  }
  const build = async () => {
    setBuilding(true)
    setLastBuild(null)
    try {
      if (script !== savedScript) {
        await window.gs.library.saveScript(meta.id, script)
        setSavedScript(script)
      }
      const r = await window.gs.library.build(meta.id)
      setLastBuild(r)
      if (r.ok) setView((v) => (v === 'script' ? 'model' : v))
      await onChanged()
    } catch (e) {
      setLastBuild({ ok: false, error: e.message })
    } finally {
      setBuilding(false)
    }
  }
  const addToGame = async () => {
    try {
      const rec = await window.gs.library.addToGame(meta.id)
      flash(`Added to ${project.meta.name}: ${rec.entry}`)
    } catch (e) {
      flash(e.message)
    }
  }
  const rename = async () => {
    const name = prompt('New name', meta.name)
    if (name?.trim()) {
      await window.gs.library.rename(meta.id, name.trim())
      onChanged()
    }
  }
  const remove = async () => {
    if (!confirm(`Delete "${meta.name}" from your library? Games that already use it keep their copy.`)) return
    await window.gs.library.remove(meta.id)
    onChanged()
  }
  const s = meta.stats

  return (
    <div className="asset-view">
      <div className="assets-bar">
        <div className="seg inline">
          <button className={view === 'model' ? 'on' : ''} onClick={() => setView('model')}>3D view</button>
          <button className={view === 'image' ? 'on' : ''} onClick={() => setView('image')}>Render</button>
          <button className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>
            Script{script !== savedScript ? ' ●' : ''}
          </button>
        </div>
        {view === 'model' && asset.glb && (
          <label className="check-label small">
            <input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> Wireframe
          </label>
        )}
        <div className="spacer" />
        <span className="muted small" title={blender.path}>Blender {blender.version}</span>
        <button className="btn small play" onClick={build} disabled={building}>{building ? 'Building…' : 'Build'}</button>
      </div>
      <div className="asset-view-body">
        <div className="asset-stage">
          {view === 'script' ? (
            <CodeEditor path={`${meta.id}/model.py`} value={script} onChange={setScript} onSave={build} />
          ) : !asset.glb ? (
            <div className="studio-empty muted">Not built yet. Ask the AI on the right to make it, or write the script and click Build.</div>
          ) : view === 'model' ? (
            <ModelViewer glb={asset.glb} fallback={asset.preview} wireframe={wire} />
          ) : (
            <div className="viewer fallback">{asset.preview ? <img src={asset.preview} alt={`${meta.name} rendered in Blender`} /> : <span className="muted">No render yet.</span>}</div>
          )}
          {lastBuild && !lastBuild.ok && (
            <div className="build-error">
              <BuildBadge result={lastBuild} />
            </div>
          )}
        </div>
        <aside className="asset-detail">
          <h3>{meta.name}</h3>
          {meta.description && <p>{meta.description}</p>}
          {s ? (
            <dl className="stats">
              <dt>Size</dt>
              <dd>{s.size_m.width} × {s.size_m.depth} m, {s.size_m.height} m tall</dd>
              <dt>Triangles</dt>
              <dd>{s.triangles.toLocaleString()}</dd>
              <dt>Parts</dt>
              <dd>{s.objects}</dd>
              <dt>Materials</dt>
              <dd>{s.materials.join(', ') || 'none'}</dd>
            </dl>
          ) : (
            <p className="small">Build it to see its size and triangle count.</p>
          )}
          {lastBuild?.ok && <BuildBadge result={lastBuild} />}
          {project && (
            <button className="btn play" onClick={addToGame} disabled={!asset.glb}>Add to {project.meta.name}</button>
          )}
          {!project && <p className="small muted">Open a game to add this model to it, or ask that game's AI to use it.</p>}
          {msg && <div className="small">{msg}</div>}
          <div className="detail-actions">
            <button className="btn small ghost" onClick={rename}>Rename</button>
            <button className="btn small ghost" onClick={() => window.gs.library.reveal(meta.id)}>Show folder</button>
            <button className="btn small ghost danger" onClick={remove}>Delete</button>
          </div>
          <p className="small muted">The model is rebuilt from <code>model.py</code>, a Blender Python script. Edit it in the Script view, or open it in Blender yourself.</p>
        </aside>
      </div>
    </div>
  )
}

function BlenderSetup({ studio }) {
  const { blender, setBlender } = studio
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => window.gs.blender.onProgress(setProgress), [])

  const run = async (fn) => {
    setBusy(true)
    setErr('')
    try {
      setBlender(await fn())
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className="studio">
      <div className="blender-setup">
        <span className="setup-mark" aria-hidden>◆</span>
        <h2>Make your own 3D models</h2>
        <p>
          Describe a model and the AI builds it in <strong>Blender</strong>, the free open-source 3D app. Gamesmith runs Blender in the background, so you never need to learn it.
          Models are saved to your own library and can be used in any game.
        </p>
        {blender.tooOld && (
          <div className="notice">Found Blender {blender.tooOld.version}, but Gamesmith needs 4.2 or newer.</div>
        )}
        {busy && progress ? (
          <div className="progress-block">
            <div className="progress"><span style={{ width: `${pct}%` }} /></div>
            <span className="small muted">
              {progress.phase}
              {progress.phase === 'Downloading' ? ` ${Math.round(progress.done / 1e6)} of ${Math.round(progress.total / 1e6)} MB` : '…'}
            </span>
            {progress.phase === 'Downloading' && <button className="btn small ghost" onClick={() => window.gs.blender.cancelDownload()}>Cancel</button>}
          </div>
        ) : (
          <div className="setup-actions">
            {blender.canDownload && (
              <button className="btn play" onClick={() => run(() => window.gs.blender.download())} disabled={busy}>
                Get Blender {blender.download.version} ({blender.download.approxMB} MB)
              </button>
            )}
            <button className="btn ghost" onClick={() => run(() => window.gs.blender.pickPath())} disabled={busy}>I have Blender: find it…</button>
            <button className="btn ghost" onClick={() => run(() => window.gs.blender.status(true))} disabled={busy}>Check again</button>
          </div>
        )}
        <p className="small muted">
          {blender.canDownload
            ? 'The download is the official portable build from blender.org, checked against its published checksum. It goes into Gamesmith\'s own folder and doesn\'t change anything else on your PC.'
            : 'Install Blender from blender.org, then click Check again.'}
        </p>
        {err && <div className="notice error">{err}</div>}
      </div>
    </div>
  )
}

function NewAssetDialog({ onCancel, onCreated }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      onCreated(await window.gs.library.create(name.trim(), description.trim()), description.trim())
    } catch (e2) {
      setErr(e2.message)
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={create}>
        <h2>New model</h2>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Treasure chest" />
        </label>
        <label className="field">
          <span>Describe it (the AI starts building as soon as you click Create)</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Small wooden chest with gold trim and a curved lid, about knee high" />
        </label>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn play" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}

function LibraryGitHub({ count }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = useCallback(() => window.gs.library.status().then(setSt).catch(() => {}), [])
  useEffect(() => {
    load()
    return window.gs.library.onChanged(load)
  }, [load, count])

  const act = async (fn, done) => {
    setBusy(true)
    setMsg('')
    try {
      const r = await fn()
      setMsg(done(r))
      load()
    } catch (e) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }
  if (!st) return null
  return (
    <div className="lib-foot">
      {st.github ? (
        <>
          <button className="btn small ghost" onClick={() => act(() => window.gs.library.sync(), () => 'Saved to GitHub')} disabled={busy}>
            {busy ? 'Saving…' : 'Save library to GitHub'}
            {st.unpushed > 0 && !busy && <span className="count warn">{st.unpushed}</span>}
          </button>
          <button className="linkish small" onClick={() => window.gs.openUrl(st.github.htmlUrl)}>{st.github.fullName}</button>
        </>
      ) : (
        <button
          className="btn small ghost"
          disabled={busy}
          title={count === 0 ? 'Downloads your gamesmith-assets repository, if you have one' : 'Creates a private gamesmith-assets repository'}
          onClick={() =>
            act(
              () => window.gs.library.connectGitHub({ isPrivate: true }),
              (r) => (r.downloaded ? `Downloaded ${r.downloaded} models from ${r.repo.fullName}` : `Saved to ${r.repo.fullName}`)
            )
          }
        >
          {busy ? 'Connecting…' : count === 0 ? 'Get my library from GitHub' : 'Back up to GitHub'}
        </button>
      )}
      {msg && <span className="small muted">{msg}</span>}
    </div>
  )
}
