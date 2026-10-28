import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque'
import './styles.css'
import App from './App.jsx'
import * as mocapProcess from './mocap/process.js'

// Used by the automated app tests to exercise body tracking directly.
window.gsMocap = { tracker: () => import('./mocap/tracker.js'), process: mocapProcess }

createRoot(document.getElementById('root')).render(<App />)
