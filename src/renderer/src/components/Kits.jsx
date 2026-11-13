// Kits: model packs the modeling AI builds with. Gamesmith has a built-in catalog of free (CC0)
// packs; "Add" downloads one and converts every model, with sizes and thumbnails. The AI can also
// add a kit itself when it needs one. (A pack's .zip can still be dropped on the list.)
import { useCallback, useEffect, useState } from 'react'

const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const GET_KITS = '__get-kits__'

export function useKits() {
  const [kits, setKits] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [selected, setSelected] = useState(null)
  const [progress, setProgress] = useState(null)
  const [msg, setMsg] = useState('')
  const refresh = useCallback(async () => {
    const [l, c] = await Promise.all([window.gs.kits.list(), window.gs.kits.catalog()])
    setKits(l)
    setCatalog(c)
    return l
  }, [])
  useEffect(() => {
    refresh().then((l) => setSelected((cur) => cur || l[0]?.id || GET_KITS))
    const offP = window.gs.kits.onProgress(setProgress)
    const offC = window.gs.kits.onChanged(() => refresh()) // the AI may add a kit while you're here
    return () => {
      offP?.()
      offC?.()
    }
  }, [refresh])
  const install = async (pack) => {
    setMsg('')
    try {
      const k = await window.gs.kits.install(pack.id)
      await refresh()
      setSelected(k.id)
      setMsg(`Added ${k.name}: ${k.parts} parts.${k.failed ? ` ${k.failed} model${k.failed > 1 ? 's' : ''} couldn't be read.` : ''}`)
    } catch (e) {
      const m = cleanErr(e)
      setMsg(m === 'Cancelled' ? '' : m)
    }
  }
  const importKits = async (paths) => {
    setMsg('')
    try {
      const done = await window.gs.kits.import(paths)
      if (!done.length) return
      await refresh()
      setSelected(done[done.length - 1].id)
      const notCC0 = done.filter((k) => k.license !== 'CC0')
      setMsg(
        `Imported ${done.map((k) => `${k.name} (${k.parts} parts)`).join(', ')}.` +
          (notCC0.length ? ` Check the license of ${notCC0.map((k) => k.name).join(', ')} before using it in a published game.` : '')
      )
    } catch (e) {
      setMsg(cleanErr(e))
    }
  }
  return { kits, catalog, selected, setSelected, progress, msg, setMsg, refresh, install, importKits }
}

export function KitList({ k }) {
  // Coming back to Kits shows kits added meanwhile (by the AI, say).
  useEffect(() => {
    k.refresh().then((l) => k.setSelected((cur) => (cur === GET_KITS || (cur && l.some((x) => x.id === cur)) ? cur : l[0]?.id || GET_KITS)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="lib-head">
        <h3>Kits</h3>
        <div className="spacer" />
        <button className="btn small play" onClick={() => k.setSelected(GET_KITS)}>+ Add kits</button>
      </div>
      <div
        className="lib-list"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const paths = [...e.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name)).map((f) => window.gs.kits.pathFor(f))
          if (paths.length) k.importKits(paths)
        }}
      >
        <button className={`lib-item ${k.selected === GET_KITS ? 'on' : ''}`} onClick={() => k.setSelected(GET_KITS)}>
          <span className="lib-thumb" aria-hidden>＋</span>
          <span className="lib-text">
            <span className="asset-name">Free kits</span>
            <span className="muted small">{k.catalog ? `${k.catalog.packs.length} pack${k.catalog.packs.length === 1 ? '' : 's'}, one click to add` : 'Loading…'}</span>
          </span>
        </button>
        {k.kits === null && <div className="muted small pad">Loading…</div>}
        {k.kits?.map((x) => (
          <button key={x.id} className={`lib-item ${x.id === k.selected ? 'on' : ''}`} onClick={() => k.setSelected(x.id)}>
            <span className="lib-thumb" aria-hidden>▦</span>
            <span className="lib-text">
              <span className="asset-name">{x.name}</span>
              <span className="muted small">
                {x.parts} parts · {x.source}
                {x.license !== 'CC0' ? ' · check license' : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

function Progress({ p }) {
  return (
    <div className="kit-progress-inline">
      <div className="small">
        {p.phase}
        {p.total ? `: ${p.done} of ${p.total}` : '…'}
      </div>
      {p.total > 0 && (
        <div className="bar">
          <span style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} />
        </div>
      )}
    </div>
  )
}

function Catalog({ k }) {
  const [filter, setFilter] = useState('')
  const c = k.catalog
  if (!c) return <div className="studio-empty muted">Loading…</div>
  const q = filter.trim().toLowerCase()
  const packs = c.packs.filter((p) => !q || `${p.name} ${p.about} ${p.sample.join(' ')}`.toLowerCase().includes(q))
  const busy = k.progress
  return (
    <div className="kit-view">
      <div className="kit-head">
        <div>
          <h2>Free kits</h2>
          <div className="muted small">
            Ready-made parts in one matching style: buildings, nature, furniture, dungeons, characters, animals, vehicles. Models built from them look far better than ones made
            from simple shapes. All are CC0, free for any game. The modeling AI can also add one itself when it needs it.
          </div>
          {k.msg && <p className="notice small">{k.msg}</p>}
        </div>
        <div className="spacer" />
        <input className="kit-filter" placeholder="Search kits" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="kit-catalog">
        {packs.map((p) => {
          const mine = busy?.packId === p.id
          return (
            <div key={p.id} className={`kit-card ${p.installed ? 'have' : ''}`}>
              <div className="kit-card-head">
                <strong>{p.name}</strong>
                <span className="muted small">{p.models} models</span>
              </div>
              <div className="small">{p.about}</div>
              <div className="muted small kit-sample">{p.sample.join(', ')}…</div>
              {mine ? (
                <div className="kit-card-foot">
                  <Progress p={busy} />
                  {busy.phase === 'Downloading' && (
                    <button className="btn small ghost" onClick={() => window.gs.kits.cancel()}>Cancel</button>
                  )}
                </div>
              ) : (
                <div className="kit-card-foot">
                  <span className="muted small">
                    {p.source} · {p.license}
                  </span>
                  <div className="spacer" />
                  {p.installed ? (
                    <button className="btn small ghost" onClick={() => k.setSelected(p.installed)}>Added ✓</button>
                  ) : (
                    <button className="btn small play" disabled={!!busy} onClick={() => k.install(p)}>Add</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {c.credit && <p className="muted small">{c.credit}</p>}
    </div>
  )
}

export function KitMain({ k }) {
  const [kit, setKit] = useState(null)
  const [filter, setFilter] = useState('')
  const isCatalog = k.selected === GET_KITS || !k.selected
  useEffect(() => {
    let live = true
    setKit(null)
    if (!isCatalog) window.gs.kits.get(k.selected).then((x) => live && setKit(x)).catch(() => live && setKit(null))
    return () => {
      live = false
    }
  }, [k.selected, k.kits, isCatalog])

  if (isCatalog) return <Catalog k={k} />
  if (k.progress && !k.progress.packId) {
    const p = k.progress
    return (
      <div className="studio-empty kit-progress">
        <div>
          <strong>Importing {p.file}</strong>
          {p.count > 1 ? ` (${p.index + 1} of ${p.count})` : ''}
        </div>
        <Progress p={p} />
      </div>
    )
  }
  if (!kit) return <div className="studio-empty muted">{k.msg || 'Loading…'}</div>
  const parts = kit.parts.filter((p) => !filter || p.name.includes(filter.toLowerCase()))
  return (
    <div className="kit-view">
      <div className="kit-head">
        <div>
          <h2>{kit.name}</h2>
          <div className="muted small">
            {kit.parts.length} parts · {kit.source}
            {kit.url ? ` (${kit.url.replace(/^https?:\/\//, '')})` : ''} · License: <strong>{kit.license}</strong>
            {kit.failed?.length ? ` · ${kit.failed.length} couldn't be read` : ''}
          </div>
          {k.msg && <p className="notice small">{k.msg}</p>}
        </div>
        <div className="spacer" />
        <input className="kit-filter" placeholder="Filter parts" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button
          className="btn small ghost danger"
          onClick={async () => {
            if (!confirm(`Remove the kit "${kit.name}"? Models already built with it keep their copy, and you can add it again any time.`)) return
            await window.gs.kits.remove(kit.id)
            const l = await k.refresh()
            k.setSelected(l[0]?.id || GET_KITS)
          }}
        >
          Remove
        </button>
      </div>
      {kit.license !== 'CC0' && <p className="notice small">This pack isn't marked CC0. Check its license before putting models made from it in a published game.</p>}
      <p className="muted small">The modeling AI finds these parts by name. Ask for something they fit, e.g. "a small village using the {kit.name} kit".</p>
      <div className="kit-grid">
        {parts.map((p) => (
          <div key={p.name} className="kit-part" title={`${kit.id}/${p.name}\n${p.size.join(' × ')} m, ${p.triangles} triangles${p.rigged ? '\nRigged' : ''}${p.animations?.length ? `: ${p.animations.join(', ')}` : ''}`}>
            {p.thumb ? <img src={p.thumb} alt="" /> : <span className="kit-noimg">▦</span>}
            <span className="small">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
