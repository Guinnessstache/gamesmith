import { useCallback, useEffect, useState } from 'react'
import Home from './components/Home.jsx'
import Workspace from './components/Workspace.jsx'
import Settings from './components/Settings.jsx'

export default function App() {
  const [settings, setSettings] = useState(null)
  const [presets, setPresets] = useState({})
  const [showSettings, setShowSettings] = useState(false)
  const [project, setProject] = useState(null) // { dir, meta, url, chat }
  const [error, setError] = useState('')

  const loadSettings = useCallback(async () => {
    const r = await window.gs.settings.get()
    setSettings(r.settings)
    setPresets(r.presets)
    return r.settings
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const openProject = async (dir) => {
    setError('')
    try {
      setProject(await window.gs.projects.open(dir))
    } catch (e) {
      setError(e.message)
    }
  }

  const closeProject = async () => {
    await window.gs.projects.close()
    setProject(null)
  }

  if (!settings) return null

  return (
    <>
      {project ? (
        <Workspace
          key={project.dir}
          project={project}
          settings={settings}
          onClose={closeProject}
          onOpenSettings={() => setShowSettings(true)}
        />
      ) : (
        <Home settings={settings} onOpen={openProject} onOpenSettings={() => setShowSettings(true)} error={error} />
      )}
      {showSettings && (
        <Settings
          settings={settings}
          presets={presets}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            await loadSettings()
            setShowSettings(false)
          }}
        />
      )}
    </>
  )
}
