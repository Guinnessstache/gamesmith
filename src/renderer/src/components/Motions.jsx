import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { drawSkeleton } from '../mocap/draw.js'

const FPS = 24 // must match mocap/tracker.js
// The tracker (MediaPipe) loads only when you track a video, so the rest of the app never depends on it.
const loadTracker = () => import('../mocap/tracker.js')
import { processMotion, LM } from '../mocap/process.js'

const RECORD_MAX = 15 // seconds
const SMOOTHING = { Low: 3, Medium: 5, High: 9 }

/** The Motions side of the Blender tab: recorded moves you can put on any person-shaped model. */
export function useMotions() {
  const [motions, setMotions] = useState(null)
  const [selected, setSelected] = useState(null) // motion id, or 'new'
  const refresh = useCallback(async () => {
    const list = await window.gs.motions.list()
    setMotions(list)
    return list
  }, [])
  useEffect(() => {
    refresh()
    return window.gs.library.onChanged(() => refresh())
  }, [refresh])
  return { motions, selected, select: setSelected, refresh }
}

export function MotionList({ m }) {
  return (
    <>
      <div className="lib-head">
        <h3>My motions</h3>
        <div className="spacer" />
        <button className="btn small play" onClick={() => m.select('new')}>● Record</button>
      </div>
      <div className="lib-list">
        {m.motions === null && <div className="muted small pad">Loading…</div>}
        {m.motions?.length === 0 && (
          <p className="muted small pad">
            Film yourself doing a move, like a wave or a sword swing, and put it on any person-shaped character. Click <strong>● Record</strong> to start.
          </p>
        )}
        {m.motions?.map((x) => (
          <button key={x.id} className={`lib-item ${x.id === m.selected ? 'on' : ''}`} onClick={() => m.select(x.id)}>
            <span className="lib-thumb motion-thumb" aria-hidden>
              <MiniFigure id={x.id} />
            </span>
            <span className="lib-text">
              <span className="asset-name">{x.name}</span>
              <span className="muted small">
                {x.seconds} s{x.loop ? ', loops' : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

export function MotionMain({ m, studio }) {
  if (m.selected === 'new') return <MotionCapture onSaved={async (saved) => { await m.refresh(); m.select(saved.id) }} onCancel={() => m.select(m.motions?.[0]?.id || null)} />
  const motion = m.motions?.find((x) => x.id === m.selected)
  if (!motion) {
    return (
      <div className="studio-empty muted">
        {m.motions?.length ? 'Pick a motion on the left.' : 'No motions yet. Click ● Record to film your first one.'}
      </div>
    )
  }
  return <MotionDetail key={motion.id} motion={motion} studio={studio} onChanged={m.refresh} onDeleted={() => m.select(null)} />
}

// ---------------------------------------------------------------------------------------------
// Recording / uploading, tracking and reviewing a new motion

function MotionCapture({ onSaved, onCancel }) {
  const [step, setStep] = useState('source') // source | camera | tracking | review
  const [model, setModel] = useState(null) // { model: bool, modelMB }
  const [download, setDownload] = useState(null)
  const [err, setErr] = useState('')
  const [video, setVideo] = useState(null) // { url, bytes, ext, name }
  const [raw, setRaw] = useState(null) // tracker output
  const [progress, setProgress] = useState(null)
  const abort = useRef(null)

  useEffect(() => {
    window.gs.mocap.status().then(setModel)
    return window.gs.mocap.onProgress(setDownload)
  }, [])
  useEffect(() => () => video?.url && URL.revokeObjectURL(video.url), [video])

  const ensureModel = async () => {
    if (model?.model) return true
    setErr('')
    try {
      await window.gs.mocap.downloadModel()
      setModel((s) => ({ ...s, model: true }))
      return true
    } catch (e) {
      setErr(e.message)
      return false
    } finally {
      setDownload(null)
    }
  }

  const startTracking = async (v) => {
    setVideo(v)
    if (!(await ensureModel())) return
    setStep('tracking')
    setErr('')
    setProgress({ done: 0, total: 1 })
    abort.current = new AbortController()
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.src = v.url
    try {
      const { trackVideo } = await loadTracker().catch(() => {
        throw new Error('The body tracker is missing from this copy of Gamesmith. Run npm install in the gamesmith folder, then restart.')
      })
      const out = await trackVideo(el, { onProgress: setProgress, signal: abort.current.signal })
      const found = out.frames.filter(Boolean).length
      if (!found) throw new Error("Couldn't find a person in this video. Make sure your whole body is in view, in good light, with the camera held still.")
      setRaw(out)
      setStep('review')
    } catch (e) {
      setErr(e.message)
      setStep('source')
    } finally {
      abort.current = null
    }
  }

  const pickFile = async () => {
    setErr('')
    try {
      const f = await window.gs.motions.pickVideo()
      if (!f) return
      const ext = (f.name.split('.').pop() || 'mp4').toLowerCase()
      const url = URL.createObjectURL(new Blob([f.bytes], { type: ext === 'webm' ? 'video/webm' : 'video/mp4' }))
      startTracking({ url, bytes: f.bytes.length < 50e6 ? f.bytes : null, ext, name: f.name.replace(/\.[^.]+$/, '') })
    } catch (e) {
      setErr(e.message)
    }
  }

  if (step === 'camera') {
    return (
      <Camera
        onCancel={() => setStep('source')}
        onRecorded={(blob) => blob.arrayBuffer().then((buf) => startTracking({ url: URL.createObjectURL(blob), bytes: new Uint8Array(buf), ext: 'webm', name: '' }))}
      />
    )
  }
  if (step === 'tracking') {
    const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      <div className="mocap-pane">
        <div className="mocap-center">
          <h2>Finding your body…</h2>
          <p className="muted">
            Frame {progress?.done || 0} of {progress?.total || '…'}. This runs on your computer; nothing is uploaded.
          </p>
          <div className="progress wide">
            <span style={{ width: `${pct}%` }} />
          </div>
          <button className="btn ghost small" onClick={() => abort.current?.abort()}>Cancel</button>
        </div>
      </div>
    )
  }
  if (step === 'review' && raw) {
    return <Review raw={raw} video={video} onRedo={() => { setRaw(null); setStep('source') }} onSaved={onSaved} />
  }
  return (
    <div className="mocap-pane">
      <div className="mocap-center">
        <h2>Record a motion</h2>
        <p className="muted">Film yourself doing one move. Gamesmith tracks your body and turns it into an animation for any person-shaped character.</p>
        <div className="setup-actions">
          <button className="btn play" onClick={() => setStep('camera')}>● Use my webcam</button>
          <button className="btn ghost" onClick={pickFile}>Choose a video…</button>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
        <ul className="tips">
          <li>Stand back until your whole body, feet included, is in the picture.</li>
          <li>Keep the camera still: on a shelf or a tripod, not in your hand.</li>
          <li>Good, even light. Plain clothes against a plain background track best.</li>
          <li>One move per recording, 2 to 10 seconds. You can trim it afterwards.</li>
        </ul>
        {model && !model.model && !download && <p className="small muted">The first time, Gamesmith downloads Google's body-tracking model ({model.modelMB} MB, free).</p>}
        {download && (
          <div className="progress-block">
            <div className="progress">
              <span style={{ width: `${Math.round((download.done / download.total) * 100)}%` }} />
            </div>
            <span className="small muted">Downloading the body-tracking model…</span>
          </div>
        )}
        {err && <div className="notice error">{err}</div>}
      </div>
    </div>
  )
}

function Camera({ onRecorded, onCancel }) {
  const videoRef = useRef(null)
  const [stream, setStream] = useState(null)
  const [err, setErr] = useState('')
  const [count, setCount] = useState(null) // countdown
  const [elapsed, setElapsed] = useState(null)
  const recorder = useRef(null)

  useEffect(() => {
    let live = null
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        live = s
        setStream(s)
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch((e) => setErr(e.name === 'NotAllowedError' ? 'Gamesmith was not allowed to use the camera. Allow it in Windows Settings, Privacy, Camera.' : e.name === 'NotFoundError' ? 'No webcam found. You can choose a video file instead.' : e.message))
    return () => live?.getTracks().forEach((t) => t.stop())
  }, [])

  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop()

  const start = async () => {
    for (let n = 3; n > 0; n--) {
      setCount(n)
      await new Promise((r) => setTimeout(r, 1000))
    }
    setCount(null)
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => onRecorded(new Blob(chunks, { type: 'video/webm' }))
    recorder.current = rec
    rec.start(250)
    const t0 = Date.now()
    setElapsed(0)
    const tick = setInterval(() => {
      const s = (Date.now() - t0) / 1000
      setElapsed(s)
      if (s >= RECORD_MAX) {
        clearInterval(tick)
        stop()
      }
    }, 100)
    rec.addEventListener('stop', () => clearInterval(tick))
  }

  return (
    <div className="mocap-pane">
      <div className="camera">
        <video ref={videoRef} autoPlay muted playsInline className="mirror" />
        {count && <div className="countdown">{count}</div>}
        {elapsed !== null && <div className="rec-dot">● {elapsed.toFixed(1)} s</div>}
      </div>
      <div className="mocap-bar">
        {err ? (
          <div className="notice error">{err}</div>
        ) : elapsed !== null ? (
          <button className="btn stop" onClick={stop}>■ Stop</button>
        ) : (
          <button className="btn play" onClick={start} disabled={!stream || count !== null}>
            {count !== null ? 'Get ready…' : '● Start recording'}
          </button>
        )}
        <span className="muted small">Shown mirrored, like a mirror. Recording starts after a 3-second countdown and stops by itself at {RECORD_MAX} s.</span>
        <div className="spacer" />
        <button className="btn ghost small" onClick={onCancel}>Back</button>
      </div>
    </div>
  )
}

function Review({ raw, video, onRedo, onSaved }) {
  const total = raw.seconds
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(total)
  const [mirror, setMirror] = useState(false)
  const [loop, setLoop] = useState(false)
  const [smoothing, setSmoothing] = useState('Medium')
  const [name, setName] = useState(video?.name || '')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const vid = useRef(null)
  const canvas = useRef(null)

  const found = raw.frames.filter(Boolean).length
  const feetSeen = useMemo(() => {
    const vis = raw.frames.filter(Boolean).map((f) => Math.min(f.w[LM.anL][3], f.w[LM.anR][3]))
    return vis.filter((v) => v > 0.5).length / Math.max(1, vis.length)
  }, [raw])

  // Keep playback inside the trimmed range, and draw the tracked skeleton over the video.
  useEffect(() => {
    let raf
    const draw = () => {
      const v = vid.current
      const c = canvas.current
      if (v && c) {
        if (v.currentTime < start || v.currentTime > end) v.currentTime = start
        setT(v.currentTime)
        const ctx = c.getContext('2d')
        c.width = c.clientWidth
        c.height = c.clientHeight
        ctx.clearRect(0, 0, c.width, c.height)
        const k = Math.round(v.currentTime * FPS)
        const frame = raw.frames[Math.min(raw.frames.length - 1, k)]
        // map video coordinates into the letterboxed area the video occupies
        const vr = v.videoWidth / v.videoHeight || 16 / 9
        const cr = c.width / c.height
        const w = vr > cr ? c.width : c.height * vr
        const h = vr > cr ? c.width / vr : c.height
        ctx.save()
        ctx.translate((c.width - w) / 2, (c.height - h) / 2)
        drawSkeleton(ctx, frame, w, h)
        ctx.restore()
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [raw, start, end])

  useEffect(() => {
    const v = vid.current
    if (!v) return
    if (playing) v.play().catch(() => {})
    else v.pause()
  }, [playing])

  const save = async () => {
    setBusy(true)
    setErr('')
    try {
      const out = processMotion(raw.frames, { fps: raw.fps, start, end, mirror, smoothing: SMOOTHING[smoothing], loop })
      if (out.frames.length < 2) throw new Error('Nothing left after trimming. Widen the start and end.')
      const saved = await window.gs.motions.save(
        { name: name.trim(), fps: raw.fps, loop, legLength: out.legLength, frames: out.frames, source: video?.ext === 'webm' && !video?.name ? 'webcam' : 'video' },
        video?.bytes ? { bytes: video.bytes, ext: video.ext } : null
      )
      onSaved(saved)
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="mocap-pane review">
      <div className="camera">
        <video ref={vid} src={video?.url} muted loop playsInline autoPlay className={mirror ? 'mirror' : ''} />
        <canvas ref={canvas} className={`overlay ${mirror ? 'mirror' : ''}`} />
      </div>
      <div className="review-controls">
        <div className="trim-row">
          <button className="btn ghost small" onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <span className="small muted time">{t.toFixed(1)} s</span>
          <label className="trim">
            <span className="small">Start {start.toFixed(1)} s</span>
            <input type="range" min={0} max={total} step={1 / FPS} value={start} onChange={(e) => setStart(Math.min(+e.target.value, end - 0.2))} />
          </label>
          <label className="trim">
            <span className="small">End {end.toFixed(1)} s</span>
            <input type="range" min={0} max={total} step={1 / FPS} value={end} onChange={(e) => setEnd(Math.max(+e.target.value, start + 0.2))} />
          </label>
        </div>
        <div className="trim-row">
          <label className="check-label small">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loops (walks, idles, dances)
          </label>
          <label className="check-label small" title="If your left and right came out swapped (some phones save front-camera video mirrored)">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Swap left and right
          </label>
          <label className="check-label small">
            Smoothing
            <select value={smoothing} onChange={(e) => setSmoothing(e.target.value)}>
              {Object.keys(SMOOTHING).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>
        {found / raw.frames.length < 0.8 && (
          <div className="notice small">The tracker lost you in {Math.round((1 - found / raw.frames.length) * 100)}% of frames; those are filled in from the frames around them. Trim them off if the result looks wrong.</div>
        )}
        {feetSeen < 0.5 && <div className="notice small">Your feet weren't in view for most of the clip, so the character's legs will mostly stay still.</div>}
        <div className="trim-row">
          <label className="field grow">
            <span className="small">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wave, Sword swing, Jump…" autoFocus />
          </label>
          <button className="btn play" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save motion'}</button>
          <button className="btn ghost" onClick={onRedo} disabled={busy}>Record again</button>
        </div>
        {err && <div className="notice error">{err}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A saved motion

function useMotionData(id) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    window.gs.motions.read(id).then((d) => live && setData(d)).catch(() => {})
    return () => {
      live = false
    }
  }, [id])
  return data
}

/** Stick figure playing the motion, fitted to the canvas. */
function FigurePlayer({ data, className = '', small = false }) {
  const ref = useRef(null)
  const box = useMemo(() => {
    if (!data) return null
    let minX = 1, minY = 1, maxX = 0, maxY = 0
    for (const f of data.frames) {
      if (!f?.i) continue
      for (const p of f.i) {
        if ((p[2] ?? 1) < 0.3) continue
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
      }
    }
    return { minX, minY, span: Math.max(maxX - minX, maxY - minY, 0.05) }
  }, [data])
  useEffect(() => {
    if (!data || !box) return
    let raf
    const t0 = performance.now()
    const draw = (now) => {
      const c = ref.current
      if (!c) return
      c.width = c.clientWidth
      c.height = c.clientHeight
      const size = Math.min(c.width, c.height) * 0.86
      const k = Math.floor(((now - t0) / 1000) * data.fps) % data.frames.length
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, c.width, c.height)
      drawSkeleton(ctx, data.frames[k], c.width, c.height, {
        box: { ...box, size, x: (c.width - size) / 2, y: (c.height - size) / 2 },
        joint: small ? 'transparent' : '#ffffff'
      })
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [data, box, small])
  return <canvas ref={ref} className={className} />
}

function MiniFigure({ id }) {
  const data = useMotionData(id)
  return <FigurePlayer data={data} className="mini-figure" small />
}

function MotionDetail({ motion, studio, onChanged, onDeleted }) {
  const data = useMotionData(motion.id)
  const [videoUrl, setVideoUrl] = useState(null)
  const [showVideo, setShowVideo] = useState(false)
  const models = studio.list || []
  const [target, setTarget] = useState(() => models.find((a) => a.stats?.humanoid)?.id || models[0]?.id || '')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!showVideo || videoUrl || !motion.video) return
    window.gs.motions.video(motion.id).then((v) => v && setVideoUrl(URL.createObjectURL(new Blob([v.bytes]))))
  }, [showVideo, videoUrl, motion])
  useEffect(() => () => videoUrl && URL.revokeObjectURL(videoUrl), [videoUrl])

  const useOn = () => {
    const model = models.find((a) => a.id === target)
    if (!model) return
    const text = model.stats?.humanoid
      ? `Add my recorded motion "${motion.name}" as a clip called "${motion.name}" using rig.apply_motion("${motion.name}").`
      : `Give this character a person-shaped skeleton with Rig.humanoid() (rebuild its parts on rig.limb or attach them to the humanoid bones), then add my recorded motion "${motion.name}" as a clip called "${motion.name}" using rig.apply_motion("${motion.name}").`
    studio.setPendingPrompt({ id: model.id, text })
    studio.select(model.id)
    studio.setSection('models')
  }
  const rename = async () => {
    const name = prompt('New name', motion.name)
    if (name?.trim()) {
      await window.gs.motions.rename(motion.id, name.trim())
      onChanged()
    }
  }
  const remove = async () => {
    if (!confirm(`Delete the motion "${motion.name}"? Characters that already use it keep their animation.`)) return
    await window.gs.motions.remove(motion.id)
    onDeleted()
    onChanged()
  }

  return (
    <div className="asset-view">
      <div className="assets-bar">
        <div className="seg inline">
          <button className={!showVideo ? 'on' : ''} onClick={() => setShowVideo(false)}>Motion</button>
          <button className={showVideo ? 'on' : ''} onClick={() => setShowVideo(true)} disabled={!motion.video} title={motion.video ? '' : 'The video is only kept on the computer that recorded it'}>
            Video
          </button>
        </div>
      </div>
      <div className="asset-view-body">
        <div className="asset-stage">
          {showVideo && videoUrl ? <video src={videoUrl} autoPlay loop muted playsInline className="motion-video" /> : <FigurePlayer data={data} className="figure-stage" />}
        </div>
        <aside className="asset-detail">
          <h3>{motion.name}</h3>
          <dl className="stats">
            <dt>Length</dt>
            <dd>{motion.seconds} s, {motion.frames} frames</dd>
            <dt>Plays</dt>
            <dd>{motion.loop ? 'On a loop' : 'Once'}</dd>
          </dl>
          <label className="field">
            <span className="small">Put it on a character</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {models.length === 0 && <option value="">Make a model first</option>}
              {models.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.stats?.humanoid ? '' : ' (needs a person skeleton)'}
                </option>
              ))}
            </select>
          </label>
          <button className="btn play" onClick={useOn} disabled={!target}>Add to character</button>
          <p className="small muted">The modeling AI adds it as a clip; you'll see it in that model's 3D view. Characters need a person-shaped skeleton, and the AI adds one if they don't have it.</p>
          {msg && <div className="small">{msg}</div>}
          <div className="detail-actions">
            <button className="btn small ghost" onClick={rename}>Rename</button>
            <button className="btn small ghost danger" onClick={remove}>Delete</button>
          </div>
          <p className="small muted">Only the tracked motion is backed up to GitHub. The video of you stays on this computer.</p>
        </aside>
      </div>
    </div>
  )
}
