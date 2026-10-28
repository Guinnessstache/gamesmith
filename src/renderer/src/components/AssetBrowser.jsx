import { useEffect, useMemo, useRef, useState } from 'react'

const KINDS = [
  { id: 'models', label: 'Models' },
  { id: 'textures', label: 'Textures' },
  { id: 'hdris', label: 'Skies' },
  { id: 'mine', label: 'In this game' }
]
const RES = ['1k', '2k', '4k']
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export default function AssetBrowser({ project, onUseInGame }) {
  const is2d = project.meta.template === 'phaser-2d'
  const [kind, setKind] = useState(is2d ? 'textures' : 'models')
  const [source, setSource] = useState('polyhaven') // models only: polyhaven | polypizza
  const [ppReady, setPpReady] = useState(null)
  useEffect(() => {
    window.gs.assets.polyPizzaStatus().then(setPpReady)
  }, [])
  const src = kind === 'models' ? source : 'polyhaven'
  const needsKey = src === 'polypizza' && ppReady === false
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [mine, setMine] = useState([])
  const [selected, setSelected] = useState(null)
  const [err, setErr] = useState('')
  const reqId = useRef(0)

  const loadMine = () => window.gs.assets.list().then(setMine).catch(() => {})
  useEffect(() => {
    loadMine()
  }, [])

  // Search as you type (debounced).
  useEffect(() => {
    if (kind === 'mine' || needsKey || (src === 'polypizza' && ppReady === null)) return
    const id = ++reqId.current
    setErr('')
    const t = setTimeout(async () => {
      try {
        const r = await window.gs.assets.search(query, kind, src)
        if (id === reqId.current) setResults(r)
      } catch (e) {
        if (id === reqId.current) {
          setErr(e.message)
          setResults([])
        }
      }
    }, query ? 300 : 0)
    return () => clearTimeout(t)
  }, [query, kind, src, needsKey, ppReady])

  useEffect(() => {
    setSelected(null)
    setResults(null)
  }, [kind, src])

  const installed = useMemo(() => new Map(mine.map((a) => [a.id, a])), [mine])

  const importPack = async () => {
    setErr('')
    try {
      const added = await window.gs.assets.importZip()
      if (added.length) {
        await loadMine()
        setKind('mine')
      }
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <div className="assets">
      <div className="assets-bar">
        <div className="seg inline">
          {KINDS.map((k) => (
            <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
              {k.label}
              {k.id === 'mine' && mine.length > 0 && <span className="seg-count">{mine.length}</span>}
            </button>
          ))}
        </div>
        {kind === 'models' && (
          <div className="seg inline source-seg" role="group" aria-label="Model library">
            <button className={source === 'polyhaven' ? 'on' : ''} onClick={() => setSource('polyhaven')} title="Realistic scanned models, all CC0">Realistic</button>
            <button className={source === 'polypizza' ? 'on' : ''} onClick={() => setSource('polypizza')} title="10,000+ low-poly models from Poly Pizza">Low-poly</button>
          </div>
        )}
        {kind !== 'mine' && !needsKey && (
          <input className="asset-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${KINDS.find((k) => k.id === kind).label.toLowerCase()}, e.g. "${kind === 'hdris' ? 'sunset' : kind === 'textures' ? 'grass' : 'barrel'}"`} aria-label="Search assets" />
        )}
        <div className="spacer" />
        <button className="btn ghost small" onClick={importPack} title="Add a downloaded asset pack, such as one from kenney.nl">Import pack (.zip)</button>
      </div>

      {is2d && (kind === 'models' || kind === 'hdris') && (
        <div className="assets-note">3D models and skies only work in 3D games. For 2D games, use textures or import a sprite pack (Kenney's packs at kenney.nl are free).</div>
      )}
      {err && <div className="notice error assets-note">{err}</div>}

      <div className="assets-body">
        <div className="asset-grid-wrap">
          {needsKey ? (
            <PolyPizzaKey onSaved={() => setPpReady(true)} />
          ) : kind === 'mine' ? (
            <MineList mine={mine} onRemove={async (id) => { await window.gs.assets.remove(id); loadMine() }} onUse={onUseInGame} />
          ) : results === null ? (
            <div className="muted pad">Loading the library…</div>
          ) : !results.length ? (
            <div className="muted pad">
              {err ? '' : 'Nothing found. Try a simpler word.'}
              {!err && src === 'polyhaven' && kind === 'models' && (
                <div className="empty-hint">
                  Poly Haven has a few hundred realistic models. Poly Pizza has over 10,000 low-poly ones, including vehicles, characters and buildings.
                  <button className="btn ghost small" onClick={() => setSource('polypizza')}>Search low-poly models</button>
                </div>
              )}
            </div>
          ) : (
            <div className="asset-grid">
              {results.map((a) => (
                <button key={a.id} className={`asset-card ${selected?.id === a.id ? 'on' : ''}`} onClick={() => setSelected(a)}>
                  <img src={a.thumb} alt="" loading="lazy" />
                  <span className="asset-name">{a.name}</span>
                  {a.source === 'polypizza' && <span className={`lic ${a.license === 'CC0' ? 'cc0' : 'ccby'}`}>{a.license === 'CC0' ? 'CC0' : 'Credit'}</span>}
                  {installed.has(a.id) && <span className="asset-badge">In game</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {selected && kind !== 'mine' && (
          <AssetDetail
            key={selected.id}
            asset={selected}
            installed={installed.get(selected.id)}
            onAdded={loadMine}
            onUse={onUseInGame}
          />
        )}
      </div>

      <div className="assets-foot">
        {src === 'polypizza' ? (
          <>
            <a href="https://poly.pizza" target="_blank" rel="noreferrer">Models from Poly Pizza</a>
            <span className="muted small">"Credit" models are CC-BY: free to use, but the creator must be credited. Gamesmith writes the credit into assets/CREDITS.md for you.</span>
          </>
        ) : (
          <>
            <a href="https://polyhaven.com" target="_blank" rel="noreferrer">Powered by Poly Haven</a>
            <span className="muted small">Free CC0 assets: use them in any game, including commercial ones. Credits are kept in assets/CREDITS.md.</span>
          </>
        )}
      </div>
    </div>
  )
}

function AssetDetail({ asset, installed, onAdded, onUse }) {
  const [res, setRes] = useState('1k')
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setPlan(null)
    window.gs.assets.plan(asset.id, asset.type, res).then(setPlan).catch((e) => setErr(e.message))
  }, [asset.id, asset.type, res])

  useEffect(() => window.gs.assets.onProgress((p) => p.id === asset.id && setProgress(p)), [asset.id])

  const add = async () => {
    setBusy(true)
    setErr('')
    setProgress(null)
    try {
      await window.gs.assets.add({ id: asset.id, type: asset.type, res })
      await onAdded()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="asset-detail">
      <img src={asset.thumb.replace(/width=\d+&height=\d+/, 'width=512&height=512')} alt="" />
      <h3>{asset.name}</h3>
      <div className="muted small">{asset.category}</div>
      {asset.authors.length > 0 && <div className="small">By {asset.authors.join(', ')}</div>}
      {asset.source === 'polypizza' && (
        <div className="small">
          License: <strong>{asset.license}</strong>
          {asset.attributionRequired && ' (credit required; added to CREDITS.md automatically)'}
          {asset.tris ? `. ${Number(asset.tris).toLocaleString()} triangles` : ''}
          {asset.animated ? '. Animated' : ''}
        </div>
      )}
      {asset.description && <p className="small">{asset.description}</p>}
      {asset.tags.length > 0 && (
        <div className="tags">
          {asset.tags.slice(0, 8).map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </div>
      )}
      {installed ? (
        <div className="installed">
          <div className="check ok">In your game</div>
          <code className="path">{installed.entry}</code>
          <button className="btn ai" onClick={() => onUse(installed)}>Ask AI to use it</button>
        </div>
      ) : (
        <>
          {asset.source !== 'polypizza' && <label className="field">
            <span>Detail (bigger looks sharper but loads slower)</span>
            <select value={res} onChange={(e) => setRes(e.target.value)}>
              {RES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>}
          <button className="btn play" onClick={add} disabled={busy || !plan}>
            {busy ? (progress ? `Downloading ${progress.done}/${progress.total}…` : 'Downloading…') : plan ? (plan.totalBytes ? `Add to game (${fmtBytes(plan.totalBytes)})` : 'Add to game') : 'Checking size…'}
          </button>
        </>
      )}
      {err && <div className="notice error">{err}</div>}
    </aside>
  )
}

function MineList({ mine, onRemove, onUse }) {
  if (!mine.length) {
    return <div className="muted pad">No assets yet. Pick something from Models, Textures or Skies, import a pack, or just ask the AI ("add a wooden barrel").</div>
  }
  return (
    <ul className="mine-list">
      {mine.map((a) => (
        <li key={a.id}>
          <div className="mine-main">
            <strong>{a.name}</strong>
            <span className="muted small">
              {a.type === 'pack' ? `Pack, ${a.files.length} files` : { models: 'Model', textures: 'Texture', hdris: 'Sky' }[a.type]}, {a.source}, {a.license}
            </span>
            <code className="path">{a.entry}</code>
          </div>
          <button className="btn ai small" onClick={() => onUse(a)}>Ask AI to use it</button>
          <button
            className="btn ghost small"
            onClick={() => confirm(`Remove ${a.name} from this game? Code that uses it will need updating.`) && onRemove(a.id)}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  )
}

function PolyPizzaKey({ onSaved }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await window.gs.assets.setPolyPizzaKey(key)
      onSaved()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="pp-key" onSubmit={save}>
      <h3>Connect Poly Pizza</h3>
      <p className="muted">
        Poly Pizza has over 10,000 free low-poly models: cars, bikes, characters, buildings, weapons and more. It needs a free API key:
        sign in at <a href="https://poly.pizza/settings/api" target="_blank" rel="noreferrer">poly.pizza/settings/api</a> and copy your key here.
      </p>
      <div className="field-row">
        <label className="field grow">
          <span>Poly Pizza API key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
        </label>
        <button className="btn play" disabled={!key.trim() || busy}>{busy ? 'Checking…' : 'Connect'}</button>
      </div>
      {err && <div className="notice error">{err}</div>}
    </form>
  )
}
