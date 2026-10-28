// Unit tests for motion clean-up (src/renderer/src/mocap/process.js).
//   npm run test:mocap
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const P = await import(pathToFileURL(join(root, 'src/renderer/src/mocap/process.js')).href)

// A standing person, hips at the origin (MediaPipe world: y down), 0.9 m legs; image: hips at y=0.5.
function person({ lean = 0, hipImgY = 0.5, armUp = 0 } = {}) {
  const w = Array.from({ length: 33 }, () => [0, 0, 0, 0.95])
  const i = Array.from({ length: 33 }, () => [0.5, 0.5, 0.95])
  const set = (k, x, y, z, ix) => {
    w[k] = [x, y, z, 0.95]
    i[k] = [ix ?? 0.5 + x / 4, hipImgY + y / 4, 0.95]
  }
  set(P.LM.hipL, 0.1, 0, 0); set(P.LM.hipR, -0.1, 0, 0)
  set(P.LM.knL, 0.1, 0.45, 0); set(P.LM.knR, -0.1, 0.45, 0)
  set(P.LM.anL, 0.1, 0.9, 0); set(P.LM.anR, -0.1, 0.9, 0)
  set(P.LM.shL, 0.2, -0.5, lean); set(P.LM.shR, -0.2, -0.5, lean)
  set(P.LM.elL, 0.22, -0.2 - armUp, 0); set(P.LM.elR, -0.22, -0.2, 0)
  return { w, i }
}

let n = 0
const ok = (c, m) => {
  assert.ok(c, m)
  n++
}

// mirror: left and right swap, x flips
const m = P.mirrorFrames([person({ armUp: 0.3 })])[0]
ok(m.w[P.LM.elR][1] === -0.5 && m.w[P.LM.elR][0] === -0.22, 'mirroring moves the raised arm to the other side')
ok(Math.abs(m.i[P.LM.hipL][0] - (1 - (0.5 - 0.1 / 4))) < 1e-9, 'mirroring flips the picture horizontally')

// gaps: missing frames are interpolated
const filled = P.fillGaps([person({ hipImgY: 0.5 }), null, person({ hipImgY: 0.6 })])
ok(Math.abs(filled[1].i[P.LM.hipL][1] - 0.55) < 1e-9 && filled[1].filled, 'a frame with nobody found is filled in from its neighbours')
ok(P.fillGaps([null, null]).every((f) => f === null), 'nothing to fill when nobody was ever found')

// smoothing removes jitter but keeps the average
const jitter = [0, 1, 0, 1, 0, 1, 0].map((k) => person({ armUp: k * 0.2 }))
const sm = P.smooth(jitter, 5)
const swing = (fs) => Math.max(...fs.map((f) => f.w[P.LM.elL][1])) - Math.min(...fs.map((f) => f.w[P.LM.elL][1]))
ok(swing(sm.slice(2, 5)) < swing(jitter.slice(2, 5)) / 3, `smoothing cuts frame-to-frame jitter (${swing(jitter.slice(2, 5)).toFixed(2)} -> ${swing(sm.slice(2, 5)).toFixed(3)} m)`)

// leg length and lift (a jump: hips rise 0.05 of the picture = 0.2 m at this scale)
ok(Math.abs(P.legLength([person()]) - 0.9) < 1e-9, 'leg length measured from the landmarks')
const jump = [person(), person(), person({ hipImgY: 0.45 }), person()]
const lift = P.computeLift(jump)
ok(Math.abs(lift[2] - 0.2) < 1e-6 && lift[0] === 0, `jump height in meters (${lift[2].toFixed(2)} m)`)

// loop: the last frame becomes the first
const looped = P.loopBlend([person(), person({ armUp: 0.4 }), person({ armUp: 0.4 }), person({ armUp: 0.4 })], 24, 0.1)
ok(Math.abs(looped[3].w[P.LM.elL][1] - person().w[P.LM.elL][1]) < 1e-9, 'loop: the end blends back into the start')

// parts outside the picture don't count
const cropped = person()
cropped.i[P.LM.anL] = [0.6, 1.3, 0.9]
const marked = P.markOffscreen([cropped])[0]
ok(marked.w[P.LM.anL][3] === 0 && marked.i[P.LM.anL][2] === 0 && marked.w[P.LM.knL][3] > 0.9, 'a body part below the picture is ignored, the rest kept')

// the whole pipeline: trim to 1 s at 24 fps
const raw = Array.from({ length: 72 }, (_, k) => (k % 10 === 3 ? null : person({ armUp: 0.2 * Math.sin(k / 6) })))
const out = P.processMotion(raw, { fps: 24, start: 0.5, end: 1.5, smoothing: 5 })
ok(out.frames.length === 25 && out.frames.every(Boolean) && out.found === 65, `trim + fill + smooth (${out.frames.length} frames kept, ${out.found} tracked)`)
ok(Math.abs(out.legLength - 0.9) < 1e-6 && out.frames.every((f) => typeof f.lift === 'number'), 'every frame has a lift, leg length kept')

console.log(`PASS  mocap clean-up: ${n} checks (mirror, gap filling, smoothing, leg length, jump height, loop blend, trim)`)
