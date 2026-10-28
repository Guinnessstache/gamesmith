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

// ---- appearance: colors and proportions for "Make a character that looks like me" ----
const A = await import(pathToFileURL(join(root, 'src/renderer/src/mocap/appearance.js')).href)
{
  // A 400x800 picture of a person: face/forearms/shins skin, brown hair, blue shirt, grey shorts, black shoes.
  const W = 400, H = 800
  const data = new Uint8ClampedArray(W * H * 4).fill(255)
  const rect = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.round(y0 * H); y < y1 * H; y++) for (let x = Math.round(x0 * W); x < x1 * W; x++) data.set([...rgb, 255], (y * W + x) * 4)
  }
  const SKIN = [224, 172, 140], HAIR = [70, 45, 30], SHIRT = [40, 90, 200], SHORTS = [120, 120, 120], SHOES = [20, 20, 20]
  rect(0.4, 0.04, 0.6, 0.1, HAIR)       // hair on top of the head
  rect(0.42, 0.1, 0.58, 0.2, SKIN)      // face
  rect(0.3, 0.22, 0.7, 0.5, SHIRT)      // torso + sleeves
  rect(0.25, 0.32, 0.32, 0.46, SKIN)    // left forearm (short sleeves)
  rect(0.4, 0.5, 0.6, 0.66, SHORTS)     // shorts
  rect(0.4, 0.66, 0.6, 0.9, SKIN)       // shins
  rect(0.4, 0.9, 0.6, 0.97, SHOES)      // shoes
  const i = Array.from({ length: 33 }, () => [0.5, 0.5, 0.95])
  const put = (k, x, y) => (i[k] = [x, y, 0.95])
  put(0, 0.5, 0.16); put(2, 0.46, 0.14); put(5, 0.54, 0.14); put(7, 0.43, 0.15); put(8, 0.57, 0.15)
  put(11, 0.33, 0.24); put(12, 0.67, 0.24); put(13, 0.31, 0.32); put(14, 0.69, 0.32); put(15, 0.28, 0.45); put(16, 0.72, 0.45)
  put(23, 0.45, 0.5); put(24, 0.55, 0.5); put(25, 0.45, 0.68); put(26, 0.55, 0.68); put(27, 0.45, 0.88); put(28, 0.55, 0.88)
  put(29, 0.44, 0.93); put(30, 0.56, 0.93); put(31, 0.47, 0.95); put(32, 0.53, 0.95)
  const outfit = A.sampleOutfit({ width: W, height: H, data }, { i })
  const near = (c, rgb) => Math.max(...c.map((v, k) => Math.abs(v - rgb[k] / 255))) < 0.02
  ok(near(outfit.skin, SKIN) && near(outfit.hair, HAIR) && near(outfit.shirt, SHIRT) && near(outfit.pants, SHORTS) && near(outfit.shoes, SHOES), 'skin, hair, shirt, pants and shoe colors sampled from the right places')
  ok(outfit.sleeves === 'short' && outfit.legs === 'shorts', `short sleeves and shorts noticed (${outfit.sleeves}, ${outfit.legs})`)
  ok(A.toHex([1, 0.5, 0]) === '#ff8000' && A.fromHex('#ff8000')[1] === 0.502, 'color picker conversions')
  const box = A.faceBox({ i }, W, H)
  ok(box && box.size > 40 && box.x > 150 && box.x < 200, `face found for the photo (${box?.size} px square)`)

  // Proportions: a person with long legs, measured and scaled to a typed-in height
  const tall = person()
  for (const k of [P.LM.knL, P.LM.knR]) tall.w[k][1] = 0.5
  for (const k of [P.LM.anL, P.LM.anR]) tall.w[k][1] = 1.0
  tall.w[7] = [0.08, -0.65, 0, 0.95]; tall.w[8] = [-0.08, -0.65, 0, 0.95]
  const m = A.measure([tall, tall], 1.8)
  ok(m.height === 1.8 && m.thigh > m.upper_arm && m.thigh <= 0.239 * 1.8 * 1.25 + 0.001, `measurements scaled to 1.8 m and kept in a sensible range (thigh ${m.thigh} m, shoulders ${m.shoulders} m)`)
  const weird = person()
  weird.w[P.LM.shL] = [3, -0.5, 0, 0.95]
  ok(A.measure([weird], 1.7).shoulders <= 0.222 * 1.7 * 1.25 + 0.001, 'a tracking glitch can\'t make a strange body')
  ok(A.bestFrame([null, { i: i.map((p) => [p[0], p[1], 0.2]) }, { i }]) === 2, 'best frame is the one where everything is visible')

  // A webcam at a desk: only the upper body. Still works; legs get average lengths and colors.
  const desk = i.map((p, k) => (k >= 23 ? [p[0], p[1], 0.1] : p))
  ok(A.bestFrame([{ i: desk }, { i }]) === 1 && A.bestFrame([null, { i: desk }]) === 1, 'a whole-body frame is preferred, but an upper-body one is fine')
  const deskOutfit = A.sampleOutfit({ width: W, height: H, data }, { i: desk })
  ok(near(deskOutfit.shirt, SHIRT) && near(deskOutfit.skin, SKIN) && !deskOutfit.seen.legs && deskOutfit.legs === 'long', 'upper body only: shirt and skin read, legs left as a guess')
  const upper = person()
  for (const k of [P.LM.hipL, P.LM.hipR, P.LM.knL, P.LM.knR, P.LM.anL, P.LM.anR]) upper.w[k][3] = 0.1
  const um = A.measure([upper], 1.7)
  ok(Math.abs(um.thigh - 0.239 * 1.7) < 0.002 && Math.abs(um.shoulders - 0.222 * 1.7) < 0.002 && um.upper_arm > 0, `upper body only: average legs, arms measured (${JSON.stringify(um)})`)
}

console.log(`PASS  mocap clean-up: ${n} checks (mirror, gap filling, smoothing, leg length, jump height, loop blend, trim, outfit colors, proportions, face)`)
