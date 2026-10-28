// "Make a character that looks like me": proportions and colors from a recorded motion.
// Pure functions (images are { width, height, data } like ImageData), unit-tested in Node.
import { LM } from './process.js'

const K = { ...LM, eyeL: 2, eyeR: 5, idxL: 19, idxR: 20, heelL: 29, heelR: 30, toeL: 31, toeR: 32 }
const vis = (p) => p[3] ?? p[2] ?? 1
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0)]
const len = (v) => Math.hypot(v[0], v[1], v[2] ?? 0)
const dist = (a, b) => len(sub(a, b))
const mid = (a, b) => a.map((v, k) => (v + b[k]) / 2)
const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q)
  return a.length ? a[a.length >> 1] : NaN
}

const MUST = [K.nose, K.shL, K.shR] // face and shoulders: enough for skin, hair and shirt
const UPPER = [K.earL, K.earR, K.elL, K.elR, K.wrL, K.wrR]
const LOWER = [K.hipL, K.hipR, K.knL, K.knR, K.anL, K.anR]

/**
 * The frame that shows the person best: facing the camera (wide shoulders in the picture), arms
 * away from the body so sleeves and torso don't mix, and the whole body in the picture if any
 * frame has it. A webcam at a desk only sees the upper body; that works too (legs are average).
 */
export function bestFrame(frames) {
  let best = -1
  let score = -Infinity
  frames.forEach((f, k) => {
    if (!f?.i) return
    const i = f.i
    if (Math.min(...MUST.map((n) => vis(i[n]))) < 0.5) return
    const upper = UPPER.filter((n) => vis(i[n]) >= 0.5).length // ears, elbows, wrists in view
    const lower = Math.min(...LOWER.map((n) => vis(i[n])))
    const shoulders = Math.abs(i[K.shL][0] - i[K.shR][0])
    const armsOut = upper === UPPER.length ? Math.abs(i[K.wrL][0] - i[K.shL][0]) + Math.abs(i[K.wrR][0] - i[K.shR][0]) : 0
    const s = (lower >= 0.5 ? 20 : 0) + upper + shoulders * 4 + Math.min(armsOut, 0.2) * 3
    if (s > score) {
      score = s
      best = k
    }
  })
  return best
}

/** Whether a frame shows the legs (so their colors and lengths can be read). */
export const showsLegs = (f) => !!f?.i && Math.min(...LOWER.map((n) => vis(f.i[n]))) >= 0.5

/** Average adult proportions, as a fraction of height (matches Rig.humanoid's defaults). */
const AVG = { shoulders: 0.222, hips: 0.111, upper_arm: 0.161, forearm: 0.139, thigh: 0.239, shin: 0.239 }

/**
 * Body measurements in meters for someone `height` m tall. The tracker can't know true size
 * from one camera, so it gives ratios and the user's height sets the scale. Each value is kept
 * within 25% of average so a tracking glitch can't make a strange body.
 */
export function measure(frames, height) {
  const seen = (f, pts) => f?.w && Math.min(...pts.map((n) => vis(f.w[n]))) >= 0.5
  // each measurement only from frames where its joints are clearly visible
  const m = (pts, fn) => median(frames.filter((f) => seen(f, pts)).map((f) => fn(f.w)))
  const both = (a, b, c, d) => (w) => (dist(w[a], w[b]) + dist(w[c], w[d])) / 2
  const raw = {
    shoulders: m([K.shL, K.shR], (w) => dist(w[K.shL], w[K.shR])),
    hips: m([K.hipL, K.hipR], (w) => dist(w[K.hipL], w[K.hipR])),
    upper_arm: m([K.shL, K.elL, K.shR, K.elR], both(K.shL, K.elL, K.shR, K.elR)),
    forearm: m([K.elL, K.wrL, K.elR, K.wrR], both(K.elL, K.wrL, K.elR, K.wrR)),
    thigh: m([K.hipL, K.knL, K.hipR, K.knR], both(K.hipL, K.knL, K.hipR, K.knR)),
    shin: m([K.knL, K.anL, K.knR, K.anR], both(K.knL, K.anL, K.knR, K.anR)),
    torso: m([K.shL, K.shR, K.hipL, K.hipR], (w) => dist(mid(w[K.hipL], w[K.hipR]), mid(w[K.shL], w[K.shR]))),
    neckHead: m([K.shL, K.shR, K.earL, K.earR], (w) => dist(mid(w[K.shL], w[K.shR]), mid(w[K.earL], w[K.earR]))),
    headWidth: m([K.earL, K.earR], (w) => dist(w[K.earL], w[K.earR]))
  }
  // The tracker measures in its own units; scale so the body adds up to your height.
  // Full body: ankle height + legs + torso + shoulders-to-top-of-head. Upper body only: the
  // shoulders are a steady yardstick instead.
  let scale
  const tracked = raw.shin + raw.thigh + raw.torso + raw.neckHead * 1.9
  if (Number.isFinite(tracked) && tracked > 0.5) scale = (height * 0.95) / tracked
  else if (Number.isFinite(raw.shoulders) && raw.shoulders > 0.1) scale = (AVG.shoulders * height) / raw.shoulders
  else scale = NaN
  const out = { height: +height.toFixed(3) }
  for (const [key, avg] of Object.entries(AVG)) {
    const v = raw[key] * scale
    const lo = avg * height * 0.75
    const hi = avg * height * 1.25
    out[key] = +(Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : avg * height).toFixed(3)
  }
  const hw = raw.headWidth * scale * 1.15
  out.head_width = +Math.min(0.13 * height * 1.25, Math.max(0.13 * height * 0.75, Number.isFinite(hw) ? hw : 0.13 * height)).toFixed(3)
  return out
}

/** Median color of a small patch (0..1 RGB) around a point in picture coordinates (0..1). */
export function sampleColor(img, x, y, radius = 0.012) {
  const r = Math.max(1, Math.round(radius * Math.min(img.width, img.height)))
  const cx = Math.round(x * img.width)
  const cy = Math.round(y * img.height)
  const R = [], G = [], B = []
  for (let yy = cy - r; yy <= cy + r; yy++) {
    for (let xx = cx - r; xx <= cx + r; xx++) {
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue
      const o = (yy * img.width + xx) * 4
      R.push(img.data[o]); G.push(img.data[o + 1]); B.push(img.data[o + 2])
    }
  }
  if (!R.length) return null
  return [median(R) / 255, median(G) / 255, median(B) / 255].map((v) => +v.toFixed(3))
}

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const close = (a, b, tol = 0.12) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol * Math.sqrt(3)
export const toHex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
export const fromHex = (h) => [1, 3, 5].map((k) => +(parseInt(h.slice(k, k + 2), 16) / 255).toFixed(3))

/**
 * Colors of skin, hair, shirt, pants and shoes at the right spots on the body, and whether the
 * sleeves and legs are short (bare forearms / shins the same color as the face).
 */
export function sampleOutfit(img, frame) {
  const i = frame.i
  const p = (k) => i[k]
  const at = (pt, radius) => sampleColor(img, pt[0], pt[1], radius)
  const seen = (...ks) => ks.every((k) => vis(p(k)) >= 0.5)
  const nose = p(K.nose)
  const eyes = mid(p(K.eyeL), p(K.eyeR))
  const ears = mid(p(K.earL), p(K.earR))
  const shoulders = mid(p(K.shL), p(K.shR))
  const hips = mid(p(K.hipL), p(K.hipR))
  // skin: cheek area, between the nose and the eyes
  const skin = at(lerp2(nose, eyes, 0.2), 0.008)
  // hair: above the head, as far above the ears as the ears are above the shoulders, x 0.7
  const up = [ears[0] - shoulders[0], ears[1] - shoulders[1]]
  const hair = seen(K.earL, K.earR) ? at([ears[0] + up[0] * 0.75, ears[1] + up[1] * 0.75], 0.008) : at([eyes[0], eyes[1] - (shoulders[1] - eyes[1]) * 0.55], 0.008)
  // below the chest, but not lower than the bottom of the picture
  const shirtPt = lerp2(shoulders, hips, 0.35)
  const shirt = at([shirtPt[0], Math.min(shirtPt[1], 0.97)], 0.02)
  const upperArm = seen(K.shL, K.elL) ? at(lerp2(p(K.shL), p(K.elL), 0.55), 0.008) : null
  const forearm = seen(K.elL, K.wrL) ? at(lerp2(p(K.elL), p(K.wrL), 0.5), 0.008) : null
  const legs = showsLegs(frame)
  const hipsSeen = Math.min(vis(p(K.hipL)), vis(p(K.hipR))) >= 0.5
  const thigh = hipsSeen && vis(p(K.knL)) >= 0.5 ? at(lerp2(p(K.hipL), p(K.knL), 0.45), 0.012) : null
  const shinC = legs ? at(lerp2(p(K.knL), p(K.anL), 0.5), 0.008) : null
  const shoes = legs ? at(lerp2(p(K.heelL), p(K.toeL), 0.5), 0.006) || at(p(K.anL), 0.006) : null
  const shortSleeves = close(forearm, skin)
  const sleeveless = shortSleeves && close(upperArm, skin)
  const shorts = close(shinC, skin) && !close(thigh, skin)
  return {
    skin: skin || [0.85, 0.65, 0.52],
    hair: hair || [0.25, 0.18, 0.12],
    shirt: shirt || [0.3, 0.4, 0.6],
    pants: thigh || [0.2, 0.22, 0.3],
    shoes: shoes || [0.15, 0.15, 0.15],
    sleeves: sleeveless ? 'none' : shortSleeves ? 'short' : 'long',
    legs: shorts ? 'shorts' : 'long',
    seen: { legs } // false: the legs weren't in the picture, so pants and shoes are guesses
  }
}

/** Square box around the face in pixels (for the face photo), or null when it isn't visible. */
export function faceBox(frame, width, height) {
  const i = frame.i
  if (Math.min(vis(i[K.nose]), vis(i[K.earL]), vis(i[K.earR])) < 0.5) return null
  const earsPx = Math.abs(i[K.earL][0] - i[K.earR][0]) * width
  const size = Math.round(earsPx * 1.35)
  const cx = i[K.nose][0] * width
  const cy = (i[K.nose][1] * height + mid(i[K.eyeL], i[K.eyeR])[1] * height) / 2 - size * 0.02
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), size }
}
