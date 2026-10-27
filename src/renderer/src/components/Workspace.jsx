import { useCallback, useEffect, useRef, useState } from 'react'
import FileTree from './FileTree.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import CodeEditor from './CodeEditor.jsx'
import Preview from './Preview.jsx'
import Chat from './Chat.jsx'
import { AiBadge, TemplateGlyph, isTextFile, isImage } from './ui.jsx'

export default function Workspace({ project, settings, onClose, onOpenSettings }) {
  const [files, setFiles] = useState([])
  const [tabs, setTabs] = useState([]) // { path, content, saved }
  const [active, setActive] = useState('game')
  const [leftPanel, setLeftPanel] = useState('files')
  const [historyTick, setHistoryTick] = useState(0)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const refreshFiles = useCallback(async () => setFiles(await window.gs.fs.list()), [])

  // Keep the file list and any open (unmodified) tabs in sync with disk.
  useEffect(() => {
    refreshFiles()
    let timer
    const off = window.gs.fs.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        refreshFiles()
        const updated = await Promise.all(
          tabsRef.current.map(async (t) => {
            if (t.content !== t.saved) return t // user has unsaved edits; leave them alone
            try {
              const disk = await window.gs.fs.read(t.path)
              return disk === t.saved ? t : { ...t, content: disk, saved: disk }
            } catch {
              return null // file was deleted
            }
          })
        )
        setTabs(updated.filter(Boolean))
      }, 250)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [refreshFiles])

  useEffect(() => {
    if (active !== 'game' && !tabs.some((t) => t.path === active)) setActive('game')
  }, [tabs, active])

  const openFile = async (path) => {
    if (tabs.some((t) => t.path === path)) return setActive(path)
    if (isImage(path)) {
      setTabs((ts) => [...ts, { path, image: true }])
      return setActive(path)
    }
    if (!isTextFile(path)) return window.gs.projects.reveal(path)
    const content = await window.gs.fs.read(path)
    setTabs((ts) => [...ts, { path, content, saved: content }])
    setActive(path)
  }

  const closeTab = (path) => {
    const t = tabs.find((x) => x.path === path)
    if (t && t.content !== t.saved && !confirm(`Close ${path} without saving your changes?`)) return
    setTabs((ts) => ts.filter((x) => x.path !== path))
    if (active === path) setActive('game')
  }

  const saveTab = async (path) => {
    const t = tabsRef.current.find((x) => x.path === path)
    if (!t || t.image) return
    await window.gs.fs.write(path, t.content)
    setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, saved: t.content } : x)))
  }

  const activeTab = tabs.find((t) => t.path === active)

  return (
    <div className="workspace">
      <header className="ws-bar">
        <button className="btn ghost back" onClick={onClose} title="Back to all games">‹ Games</button>
        <div className="ws-title">
          <TemplateGlyph template={project.meta.template} />
          <span className="ws-name">{project.meta.name}</span>
          <span className="muted small">{project.meta.engine}</span>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => window.gs.projects.reveal()}>Show folder</button>
        <AiBadge settings={settings} onClick={onOpenSettings} />
      </header>

      <div className="ws-body">
        <aside className="left">
          <div className="seg">
            <button className={leftPanel === 'files' ? 'on' : ''} onClick={() => setLeftPanel('files')}>Files</button>
            <button className={leftPanel === 'history' ? 'on' : ''} onClick={() => setLeftPanel('history')}>History</button>
          </div>
          {leftPanel === 'files' ? (
            <FileTree files={files} active={active} onOpen={openFile} onChanged={refreshFiles} />
          ) : (
            <HistoryPanel tick={historyTick} />
          )}
        </aside>

        <section className="center">
          <nav className="tabs">
            <button className={`tab game-tab ${active === 'game' ? 'on' : ''}`} onClick={() => setActive('game')}>
              <span className="play-icon" aria-hidden>▶</span> Game
            </button>
            {tabs.map((t) => (
              <div key={t.path} className={`tab ${active === t.path ? 'on' : ''}`} onClick={() => setActive(t.path)} title={t.path}>
                <span>{t.path.split('/').pop()}</span>
                {!t.image && t.content !== t.saved && <span className="dirty" title="Unsaved changes">●</span>}
                <button
                  className="tab-x"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.path)
                  }}
                  aria-label={`Close ${t.path}`}
                >
                  ×
                </button>
              </div>
            ))}
          </nav>
          <div className="stage-wrap">
            {/* The preview stays mounted (and running) even while a file is open,
                so the AI can always test the game. */}
            <Preview url={project.url} />
            {activeTab && (
              <div className="editor-layer">
                {activeTab.image ? (
                  <div className="image-view">
                    <img src={project.url + activeTab.path} alt={activeTab.path} />
                    <span className="muted small">{activeTab.path}</span>
                  </div>
                ) : (
                  <CodeEditor
                    path={activeTab.path}
                    value={activeTab.content}
                    onChange={(v) => setTabs((ts) => ts.map((x) => (x.path === activeTab.path ? { ...x, content: v } : x)))}
                    onSave={() => saveTab(activeTab.path)}
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="right">
          <Chat
            project={project}
            settings={settings}
            onOpenSettings={onOpenSettings}
            onOpenFile={openFile}
            onRunFinished={() => {
              refreshFiles()
              setHistoryTick((n) => n + 1)
            }}
          />
        </aside>
      </div>
    </div>
  )
}
