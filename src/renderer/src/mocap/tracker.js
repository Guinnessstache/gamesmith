// Body tracking with Google's MediaPipe Pose Landmarker, running locally (WASM, CPU).
// The engine and model are served by the main process on gsassets:// (see src/main/mocap.js).
import { PoseLandmarker } from '@mediapipe/tasks-vision'

export const FPS = 24 // frames sampled per second of video (matches Blender's clips)
const MAX_SECONDS = 30

let landmarker = null
let clock = 0 // VIDEO mode needs ever-increasing timestamps, across videos too

export async function getTracker() {
  if (landmarker) return landmarker
  try {
    landmarker = await createTracker()
  } catch (e) {
    if (/webgl|activeTexture|context/i.test(String(e?.message || e))) {
      throw new Error("Body tracking needs 3D graphics (WebGL), which couldn't start on this computer. Updating the graphics driver usually fixes it.")
    }
    throw e
  }
  return landmarker
}

function createTracker() {
  return PoseLandmarker.createFromOptions(
    { wasmLoaderPath: 'gsassets://mediapipe/vision_wasm_internal.js', wasmBinaryPath: 'gsassets://mediapipe/vision_wasm_internal.wasm' },
    {
      baseOptions: { modelAssetPath: 'gsassets://models/pose_landmarker_full.task', delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    }
  )
}

const once = (el, ev) => new Promise((res) => el.addEventListener(ev, res, { once: true }))

/** Videos recorded in the browser (MediaRecorder) often don't know their length until you seek to the end. */
async function knownDuration(video) {
  if (video.readyState < 1) await once(video, 'loadedmetadata')
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  video.currentTime = 1e7
  await once(video, 'durationchange')
  const d = video.duration
  video.currentTime = 0
  await once(video, 'seeked')
  return d
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return
  const done = once(video, 'seeked')
  video.currentTime = t
  await done
}

/**
 * Track every frame of a video (FPS samples per second).
 * Returns { fps, frames: [{ w, i } | null], seconds } — see process.js for the frame format.
 */
export async function trackVideo(video, { onProgress = () => {}, signal } = {}) {
  const tracker = await getTracker()
  const duration = Math.min(await knownDuration(video), MAX_SECONDS)
  const count = Math.max(1, Math.floor(duration * FPS) + 1)
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const frames = []
  for (let k = 0; k < count; k++) {
    if (signal?.aborted) throw new Error('Stopped.')
    await seek(video, Math.min(k / FPS, Math.max(0, duration - 0.001)))
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    clock += 1000 / FPS
    const res = tracker.detectForVideo(canvas, Math.round(clock))
    const w = res.worldLandmarks?.[0]
    const i = res.landmarks?.[0]
    frames.push(w && i ? { w: w.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]), i: i.map((p) => [p.x, p.y, p.visibility ?? 1]) } : null)
    onProgress({ done: k + 1, total: count })
    if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0)) // keep the window responsive
  }
  return { fps: FPS, frames, seconds: (count - 1) / FPS, truncated: duration >= MAX_SECONDS }
}
