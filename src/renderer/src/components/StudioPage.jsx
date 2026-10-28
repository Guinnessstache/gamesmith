import BlenderStudio, { useModelStudio } from './BlenderStudio.jsx'
import ModelChat from './ModelChat.jsx'
import { AiBadge } from './ui.jsx'

/** The Blender tab on its own, opened from the home screen (no game open). */
export default function StudioPage({ settings, onClose, onOpenSettings }) {
  const studio = useModelStudio()
  return (
    <div className="workspace">
      <header className="ws-bar">
        <button className="btn ghost back" onClick={onClose} title="Back to all games">‹ Games</button>
        <div className="ws-title">
          <span className="studio-glyph" aria-hidden>⬢</span>
          <span className="ws-name">My 3D models</span>
          <span className="muted small">made with Blender, usable in every game</span>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => window.gs.library.reveal()}>Show folder</button>
        <AiBadge settings={settings} onClick={onOpenSettings} />
      </header>
      <div className="ws-body studio-page">
        <section className="center">
          <div className="stage-wrap">
            <div className="editor-layer">
              <BlenderStudio studio={studio} project={null} />
            </div>
          </div>
        </section>
        <aside className="right">
          <ModelChat asset={studio.asset} settings={settings} blenderReady={!!studio.blender?.found} onOpenSettings={onOpenSettings} onRunFinished={studio.refresh}
              autoPrompt={studio.pendingPrompt}
              onAutoPromptUsed={() => studio.setPendingPrompt(null)} />
        </aside>
      </div>
    </div>
  )
}
