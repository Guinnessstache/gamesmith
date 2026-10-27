import { useMemo, useState } from 'react'

function buildTree(files) {
  const root = { name: '', path: '', dirs: {}, files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    parts.slice(0, -1).forEach((part, i) => {
      const p = parts.slice(0, i + 1).join('/')
      node = node.dirs[part] ||= { name: part, path: p, dirs: {}, files: [] }
    })
    node.files.push({ name: parts.at(-1), path: f.path, size: f.size })
  }
  return root
}

export default function FileTree({ files, active, onOpen, onChanged }) {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState({ lib: true })

  const [naming, setNaming] = useState(null) // text of the new-file input, or null

  const newFile = async (raw) => {
    const path = (raw || '').trim()
    setNaming(null)
    if (!path || path.endsWith('/')) return
    try {
      await window.gs.fs.write(path, '')
      onChanged()
      onOpen(path)
    } catch (e) {
      alert(e.message)
    }
  }

  const importAssets = async () => {
    try {
      const added = await window.gs.fs.importFiles('assets')
      if (added.length) onChanged()
    } catch (e) {
      alert(e.message)
    }
  }

  const remove = async (path) => {
    if (!confirm(`Delete ${path}? You can bring it back from History.`)) return
    try {
      await window.gs.fs.remove(path)
      onChanged()
    } catch (e) {
      alert(e.message)
    }
  }

  const renderDir = (node, depth) => {
    const dirs = Object.values(node.dirs).sort((a, b) => a.name.localeCompare(b.name))
    return (
      <>
        {dirs.map((d) => {
          const isLib = d.path === 'lib'
          const open = !collapsed[d.path]
          return (
            <div key={d.path}>
              <button
                className={`tree-row dir ${isLib ? 'dim' : ''}`}
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => setCollapsed((c) => ({ ...c, [d.path]: open }))}
                title={isLib ? 'Game engine files (managed by Gamesmith)' : d.path}
              >
                <span className="caret">{open ? '▾' : '▸'}</span>
                {d.name}
                {isLib && <span className="tag">engine</span>}
              </button>
              {open && renderDir(d, depth + 1)}
            </div>
          )
        })}
        {node.files.map((f) => (
          <div key={f.path} className={`tree-row file ${active === f.path ? 'on' : ''}`} style={{ paddingLeft: 24 + depth * 14 }}>
            <button className="tree-open" onClick={() => onOpen(f.path)} title={f.path}>
              {f.name}
            </button>
            {!f.path.startsWith('lib/') && (
              <button className="tree-x" onClick={() => remove(f.path)} aria-label={`Delete ${f.path}`}>
                ×
              </button>
            )}
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="file-tree">
      <div className="tree-actions">
        <button className="btn small ghost" onClick={() => setNaming('src/')}>New file</button>
        <button className="btn small ghost" onClick={importAssets}>Add assets</button>
      </div>
      {naming !== null && (
        <form
          className="new-file"
          onSubmit={(e) => {
            e.preventDefault()
            newFile(naming)
          }}
        >
          <input
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
            onBlur={() => setNaming(null)}
            placeholder="src/enemy.js"
            aria-label="New file path"
          />
        </form>
      )}
      <div className="tree-scroll">{renderDir(tree, 0)}</div>
    </div>
  )
}
