// "Make a character that looks like me": a stylized 3D character with your proportions, the
// colors of your clothes and (optionally) your face, made from a recorded motion's video.
import { useEffect, useRef, useState } from 'react'
import { bestFrame, measure, sampleOutfit, faceBox, toHex, fromHex } from '../mocap/appearance.js'
import { mirrorFrames } from '../mocap/process.js'

const once = (el, ev) => new Promise((res, rej) => {
  el.addEventListener(ev, res, { once: true })
  el.addEventListener('error', () => rej(new Error("Couldn't read the video.")), { once: true })
})

const PARTS = [
  ['skin', 'Skin'],
  ['hair', 'Hair'],
  ['shirt', 'Shirt'],
  ['pants', 'Pants'],
  ['shoes', 'Shoes']
]

export function MakeMe({ motion, data, studio, onClose }) {
  const shot = useRef(null) // the chosen video frame
  const faceRef = useRef(null) // the face crop
  const [state, setState] = useState({ step: 'loading' })
  const [colors, setColors] = useState(null)
  const [sleeves, setSleeves] = useState('long')
  const [legs, setLegs] = useState('long')
  const [hairStyle, setHairStyle] = useState('short')
  const [feet, setFeet] = useState(5)
  const [inches, setInches] = useState(9)
  const [useFace, setUseFace] = useState(true)
  const [hasFace, setHasFace] = useState(false)
  const [addMotion, setAddMotion] = useState(true)
  const [name, setName] = useState('Me')
  const [legsSeen, setLegsSeen] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // Find the frame that shows you best, grab it from the video and read the colors.
  useEffect(() => {
    if (!data) return
    let url
    let live = true
    ;(async () => {
      const k = bestFrame(data.frames)
      if (k < 0) throw new Error('No frame in this recording shows your face and shoulders clearly. Record one facing the camera, with your head and shoulders (ideally your whole body) in the picture.')
      const v = await window.gs.motions.video(motion.id)
      if (!v) throw new Error('The video for this motion is only on the computer that recorded it.')
      url = URL.createObjectURL(new Blob([v.bytes]))
      const video = document.createElement('video')
      video.muted = true
      video.preload = 'auto'
      video.src = url
      await once(video, 'loadeddata')
      const t = (data.videoStart || 0) + k / data.fps
      video.currentTime = t
      await once(video, 'seeked')
      if (!live) return
      const c = shot.current
      c.width = video.videoWidth
      c.height = video.videoHeight
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(video, 0, 0)
      // Saved frames are mirrored back if you chose "mirror": un-mirror to match the video's pixels.
      const frame = data.mirrored ? mirrorFrames([data.frames[k]])[0] : data.frames[k]
      const outfit = sampleOutfit(ctx.getImageData(0, 0, c.width, c.height), frame)
      setColors(Object.fromEntries(PARTS.map(([key]) => [key, toHex(outfit[key])])))
      setSleeves(outfit.sleeves)
      setLegs(outfit.legs)
      setLegsSeen(outfit.seen.legs)
      const box = faceBox(frame, c.width, c.height)
      if (box && faceRef.current) {
        const f = faceRef.current
        f.width = f.height = 256
        f.getContext('2d').drawImage(c, box.x, box.y, box.size, box.size, 0, 0, 256, 256)
        setHasFace(true)
      } else setUseFace(false)
      setState({ step: 'ready', frame: k })
    })().catch((e) => live && setState({ step: 'error', error: e.message }))
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [data, motion.id])

  const height = Math.round((feet * 12 + inches) * 2.54) / 100 // meters
  const create = async () => {
    setError('')
    try {
      setBusy('Saving…')
      const body = measure(data.frames, height)
      let face = null
      if (useFace && hasFace) {
        const blob = await new Promise((res) => faceRef.current.toBlob(res, 'image/png'))
        face = new Uint8Array(await blob.arrayBuffer())
      }
      const person = {
        name: name.trim() || 'Me',
        from: motion.name,
        body,
        colors: Object.fromEntries(Object.entries(colors).map(([key, hex]) => [key, fromHex(hex)])),
        sleeves,
        legs,
        hairStyle,
        face: !!face,
        motion: addMotion ? motion.name : ''
      }
      const id = await window.gs.library.createPerson(person, face)
      setBusy('Building your character in Blender…')
      const r = await window.gs.library.build(id)
      await studio.refreshList()
      studio.select(id)
      studio.setSection('models')
      if (!r.ok) throw new Error(`Saved, but the build failed: ${r.error}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="asset-view-body make-me">
      <div className="asset-stage make-me-stage">
        <canvas ref={shot} className="make-me-shot" />
        {state.step === 'loading' && <div className="make-me-note">Finding the frame that shows you best…</div>}
        {state.step === 'error' && <div className="make-me-note mm-error">{state.error}</div>}
      </div>
      <aside className="asset-detail">
        <h3>A character that looks like you</h3>
        <p className="small muted">
          Made from this frame of "{motion.name}": your proportions, your outfit's colors and, if you like, your face. It's a simple blocky character you can change afterwards
          (edit the colors here, or ask the modeling AI for anything else).
        </p>
        {colors && (
          <>
            <label className="field">
              <span className="small">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="field">
              <span className="small">Your height (sets the scale; the video can't tell how tall you are)</span>
              <div className="mm-row">
                <input type="number" min="3" max="7" value={feet} onChange={(e) => setFeet(+e.target.value || 0)} aria-label="feet" className="num" /> ft
                <input type="number" min="0" max="11" value={inches} onChange={(e) => setInches(Math.min(11, +e.target.value || 0))} aria-label="inches" className="num" /> in
              </div>
            </div>
            <div className="field">
              <span className="small">Colors (click to change)</span>
              {!legsSeen && <span className="small muted">Your legs weren't in the video, so pants and shoes are a guess (and legs get average lengths). Pick their colors here.</span>}
              <div className="swatches">
                {PARTS.map(([key, label]) => (
                  <label key={key} className="swatch">
                    <input type="color" value={colors[key]} onChange={(e) => setColors({ ...colors, [key]: e.target.value })} aria-label={label} />
                    <span className="small">{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="field-row">
              <label className="field">
                <span className="small">Sleeves</span>
                <select value={sleeves} onChange={(e) => setSleeves(e.target.value)}>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label className="field">
                <span className="small">Legs</span>
                <select value={legs} onChange={(e) => setLegs(e.target.value)}>
                  <option value="long">Pants</option>
                  <option value="shorts">Shorts</option>
                </select>
              </label>
              <label className="field">
                <span className="small">Hair</span>
                <select value={hairStyle} onChange={(e) => setHairStyle(e.target.value)}>
                  <option value="short">Short</option>
                  <option value="long">Long</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>
          </>
        )}
        <div className="make-me-face" hidden={!hasFace}>
          <canvas ref={faceRef} />
          <label className="mm-check">
            <input type="checkbox" checked={useFace} onChange={(e) => setUseFace(e.target.checked)} /> Put my face on it
          </label>
        </div>
        {colors && (
          <>
            <label className="mm-check">
              <input type="checkbox" checked={addMotion} onChange={(e) => setAddMotion(e.target.checked)} /> Also add the "{motion.name}" motion
            </label>
            <button className="btn play" onClick={create} disabled={!!busy || !name.trim()}>
              {busy || 'Create character'}
            </button>
          </>
        )}
        {error && <div className="small mm-error">{error}</div>}
        <button className="btn small ghost" onClick={onClose} disabled={!!busy}>Back</button>
        <p className="small muted">The face photo is saved with the model (and backed up to GitHub with it). Leave it off to keep your face private.</p>
      </aside>
    </div>
  )
}
