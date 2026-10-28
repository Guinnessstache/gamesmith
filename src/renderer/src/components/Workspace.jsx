import { useCallback, useEffect, useRef, useState } from 'react'
import FileTree from './FileTree.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import CodeEditor from './CodeEditor.jsx'
import Preview from './Preview.jsx'
import Chat from './Chat.jsx'
import PublishPanel from './PublishPanel.jsx'
import AssetBrowser from './AssetBrowser.jsx'
import BlenderStudio, { useModelStudio } from './BlenderStudio.jsx'
import ModelChat from './ModelChat.jsx'
import { AiBadge, TemplateGlyph, isTextFile, isImage } from './ui.jsx'

export default function Workspace({ project, settings, onClose, onOpenSettings }) {
  const [files, setFiles] = useState([])
  const [tabs, setTabs] = useState([]) // { path, content, saved }
  const [active, setActive] = useState('game')
  const [leftPanel, setLeftPanel] = useState('files')
  const [historyTick, setHistoryTick] = useState(0)
  const [showPublish, setShowPublish] = useState(false)
  const [draft, setDraft] = useState(null) // text to drop into the AI chat box
  const [pub, setPub] = useState(null) // publish status for the top bar
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const studio = useModelStudio()

  const refreshPub = useCallback(() => {
    window.gs.publish.status().then(setPub).catch(() => setPub(null))
  }, [])
  useEffect(() => {
    refreshPub()
  }, [refreshPub, historyTick])

  const quickSave = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      await window.gs.publish.sync()
      setSaveMsg('Saved to GitHub')
      setHistoryTick((n) => n + 1)
    } catch (e) {
      setSaveMsg(e.message)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 6000)
    }
  }
  const liveUrl = pub?.pages?.url || pub?.render?.url
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
    if (active !== 'game' && active !== 'assets' && active !== 'blender' && !tabs.some((t) => t.path === active)) setActive('game')
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
          <TemplateGlyph template={project.meta.template} engine={project.meta.engine} />
          <span className="ws-name">{project.meta.name}</span>
          <span className="muted small">{project.meta.engine}{project.meta.kind === 'node' ? ', own server' : ''}</span>
        </div>
        <div className="spacer" />
        {saveMsg && <span className={`save-msg ${saveMsg === 'Saved to GitHub' ? 'ok' : 'bad'}`}>{saveMsg}</span>}
        <button className="btn ghost" onClick={() => window.gs.projects.reveal()}>Show folder</button>
        {liveUrl && (
          <button className="btn ghost" onClick={() => window.gs.openUrl(liveUrl)} title={liveUrl}>View live game</button>
        )}
        {pub?.repo ? (
          <button className="btn ghost" onClick={quickSave} disabled={saving} title={`Upload to ${pub.repo.fullName}`}>
            {saving ? 'Saving…' : 'Save to GitHub'}
            {pub.unpushed > 0 && !saving && <span className="count warn">{pub.unpushed}</span>}
          </button>
        ) : null}
        <button className="btn play" onClick={() => setShowPublish(true)}>Publish</button>
        <AiBadge settings={settings} onClick={onOpenSettings} />
      </header>

      <div className={`ws-body ${active === 'blender' ? 'no-left' : ''}`}>
        <aside className="left" hidden={active === 'blender'}>
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
            <button className={`tab assets-tab ${active === 'assets' ? 'on' : ''}`} onClick={() => setActive('assets')}>
              <span className="play-icon" aria-hidden>◆</span> Assets
            </button>
            <button className={`tab blender-tab ${active === 'blender' ? 'on' : ''}`} onClick={() => setActive('blender')}>
              <span className="play-icon" aria-hidden>⬢</span> Blender
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
            <Preview url={project.url} serverGame={project.meta.kind === 'node'} initialServer={project.server} />
            {active === 'assets' && (
              <div className="editor-layer">
                <AssetBrowser
                  project={project}
                  onUseInGame={(a) =>
                    setDraft(
                      a.type === 'pack'
                        ? `Use images from the "${a.name}" pack (${a.entry}/) for `
                        : `Use the ${a.name} (${a.entry}) in the game: `
                    )
                  }
                />
              </div>
            )}
            {active === 'blender' && (
              <div className="editor-layer">
                <BlenderStudio studio={studio} project={project} />
              </div>
            )}
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
          {active === 'blender' && (
            <ModelChat
              asset={studio.asset}
              settings={settings}
              blenderReady={!!studio.blender?.found}
              onOpenSettings={onOpenSettings}
              onRunFinished={studio.refresh}
              autoPrompt={studio.pendingPrompt}
              onAutoPromptUsed={() => studio.setPendingPrompt(null)}
            />
          )}
          <div className="chat-slot" hidden={active === 'blender'}>
          <Chat
            project={project}
            settings={settings}
            onOpenSettings={onOpenSettings}
            onOpenFile={openFile}
            draft={draft}
            onDraftUsed={() => setDraft(null)}
            onRunFinished={() => {
              refreshFiles()
              setHistoryTick((n) => n + 1)
            }}
          />
          </div>
        </aside>
      </div>
      {showPublish && (
        <PublishPanel
          project={project}
          settings={settings}
          onClose={() => {
            setShowPublish(false)
            refreshPub()
          }}
          onChanged={() => setHistoryTick((n) => n + 1)}
        />
      )}
    </div>
  )
}
