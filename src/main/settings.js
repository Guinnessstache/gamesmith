import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// Presets for the common OpenAI-compatible local servers. All of them speak
// the same /v1/chat/completions protocol, so one client covers every backend.
export const AI_PRESETS = {
  ollama: { label: 'Ollama', port: 11434, path: '/v1', hint: 'On the Mac: OLLAMA_HOST=0.0.0.0 so other machines can connect' },
  lmstudio: { label: 'LM Studio', port: 1234, path: '/v1', hint: 'Developer tab → enable "Serve on Local Network"' },
  llamacpp: { label: 'llama.cpp server', port: 8080, path: '/v1', hint: 'Start llama-server with --host 0.0.0.0 --jinja' },
  mlx: { label: 'MLX (mlx_lm.server)', port: 8080, path: '/v1', hint: 'mlx_lm.server --host 0.0.0.0' },
  custom: { label: 'Custom URL', port: 0, path: '', hint: 'Any OpenAI-compatible endpoint' }
}

const DEFAULTS = {
  ai: {
    preset: 'ollama',
    host: 'Mac-Studio.local',
    port: 11434,
    baseUrl: 'http://Mac-Studio.local:11434/v1',
    apiKey: '',
    model: '',
    temperature: 0.2,
    maxSteps: 30,
    autoFixRounds: 3,
    requestTimeoutSec: 600
  },
  projectsDir: ''
}

let cache = null
const file = () => join(app.getPath('userData'), 'settings.json')

function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v
  }
  return out
}

export function getSettings() {
  if (cache) return cache
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    /* first run */
  }
  cache = merge(DEFAULTS, saved)
  if (!cache.projectsDir) cache.projectsDir = join(app.getPath('documents'), 'Gamesmith Projects')
  return cache
}

export function setSettings(patch) {
  cache = merge(getSettings(), patch)
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(cache, null, 2))
  return cache
}
