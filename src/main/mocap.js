// Motion capture support in the main process:
//  - the gsassets:// scheme that serves the body-tracking engine (WASM) and model to the UI
//  - downloading Google's MediaPipe pose model once, checked against its known checksum
import fs from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const POSE_MODEL = {
  file: 'pose_landmarker_full.task',
  url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  bytes: 9398198
}

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json' }

export const modelPath = (userData) => process.env.GAMESMITH_POSE_MODEL || join(userData, 'models', POSE_MODEL.file)
export const hasModel = (userData) => fs.existsSync(modelPath(userData))

/** Serve gsassets://mediapipe/<file> and gsassets://models/<file>. */
export function makeHandler({ resourcesDir, userData }) {
  const roots = {
    mediapipe: join(resourcesDir, 'vendor', 'mediapipe'),
    models: () => (process.env.GAMESMITH_POSE_MODEL ? join(process.env.GAMESMITH_POSE_MODEL, '..') : join(userData, 'models'))
  }
  return async (request) => {
    const url = new URL(request.url)
    const base = typeof roots[url.hostname] === 'function' ? roots[url.hostname]() : roots[url.hostname]
    if (!base) return new Response('Not found', { status: 404 })
    const file = normalize(join(base, decodeURIComponent(url.pathname)))
    if (!file.startsWith(normalize(base) + sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(fs.readFileSync(file), {
      headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }
    })
  }
}

/** Download the pose model (about 9 MB) if it isn't here yet. */
export async function ensureModel(userData, { fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  const dest = modelPath(userData)
  if (fs.existsSync(dest)) return { ready: true }
  fs.mkdirSync(join(dest, '..'), { recursive: true })
  const res = await fetchImpl(POSE_MODEL.url, { signal })
  if (!res.ok) throw new Error(`Couldn't download the body-tracking model (HTTP ${res.status}). Check your internet connection and try again.`)
  const total = Number(res.headers.get('content-length')) || POSE_MODEL.bytes
  const reader = res.body.getReader()
  const chunks = []
  let done = 0
  for (;;) {
    const { value, done: end } = await reader.read()
    if (end) break
    chunks.push(value)
    done += value.length
    onProgress({ done, total })
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== POSE_MODEL.sha256) throw new Error("The body-tracking model didn't download correctly (checksum mismatch). Please try again.")
  fs.writeFileSync(dest + '.part', buf)
  fs.renameSync(dest + '.part', dest)
  return { ready: true }
}
