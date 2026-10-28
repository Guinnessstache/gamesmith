// Clean-up for tracked motions. Pure functions (no DOM), so they're unit-tested in Node.
//
// A frame is { w, i } or null:
//   w: 33 world landmarks [x, y, z, visibility] in meters, origin between the hips,
//      x to the image's right, y down, z away from the camera (MediaPipe convention)
//   i: 33 image landmarks [x, y, visibility], 0..1 across and down the video

export const LM = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28 }

// MediaPipe's left/right landmark pairs (left first).
const PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
  [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]
]

// Lines of the stick figure, for drawing.
export const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [7, 0], [0, 8]
]

const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q)
  if (!a.length) return NaN
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
const lerp = (a, b, t) => a + (b - a) * t
const lerpPoints = (A, B, t) => A.map((p, k) => p.map((v, c) => lerp(v, B[k][c], t)))

/** A video filmed with a front camera that saves mirrored: swap left and right. */
export function mirrorFrames(frames) {
  return frames.map((f) => {
    if (!f) return f
    const w = f.w.map((p) => [-p[0], p[1], p[2], p[3]])
    const i = f.i.map((p) => [1 - p[0], p[1], p[2]])
    for (const [a, b] of PAIRS) {
      ;[w[a], w[b]] = [w[b], w[a]]
      ;[i[a], i[b]] = [i[b], i[a]]
    }
    return { ...f, w, i }
  })
}

/**
 * The tracker still guesses where body parts outside the picture are (e.g. legs in a waist-up
 * video). Those guesses are unreliable, so mark them as not seen.
 */
export function markOffscreen(frames, margin = 0.02) {
  return frames.map((f) => {
    if (!f) return f
    const out = f.i.map(([x, y]) => x < -margin || x > 1 + margin || y < -margin || y > 1 + margin)
    if (!out.some(Boolean)) return f
    return {
      ...f,
      w: f.w.map((p, k) => (out[k] ? [p[0], p[1], p[2], 0] : p)),
      i: f.i.map((p, k) => (out[k] ? [p[0], p[1], 0] : p))
    }
  })
}

/** Frames where nobody was found get filled in from their neighbours. */
export function fillGaps(frames) {
  const idx = frames.map((f, k) => (f ? k : -1)).filter((k) => k >= 0)
  if (!idx.length) return frames.map(() => null)
  return frames.map((f, k) => {
    if (f) return f
    const prev = [...idx].reverse().find((j) => j < k)
    const next = idx.find((j) => j > k)
    if (prev === undefined) return frames[next]
    if (next === undefined) return frames[prev]
    const t = (k - prev) / (next - prev)
    return { w: lerpPoints(frames[prev].w, frames[next].w, t), i: lerpPoints(frames[prev].i, frames[next].i, t), filled: true }
  })
}

/** Moving average over `window` frames (odd number), weighting each point by how sure the tracker was. */
export function smooth(frames, window = 5) {
  if (window <= 1) return frames
  const half = window >> 1
  return frames.map((f, k) => {
    if (!f) return f
    const near = frames.slice(Math.max(0, k - half), k + half + 1).filter(Boolean)
    const avg = (key, dims, visIndex) =>
      f[key].map((_, p) => {
        let wsum = 0
        const acc = new Array(dims).fill(0)
        for (const g of near) {
          const wt = Math.max(0.05, g[key][p][visIndex] ?? 1)
          wsum += wt
          for (let c = 0; c < dims; c++) acc[c] += g[key][p][c] * wt
        }
        return [...acc.map((v) => v / wsum), f[key][p][visIndex]]
      })
    return { ...f, w: avg('w', 3, 3), i: avg('i', 2, 2) }
  })
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const seen = (p, min = 0.5) => (p[3] ?? p[2] ?? 1) >= min

/** Hip-to-ankle length of the person in meters (median over frames), used to scale motion to the character. */
export function legLength(frames) {
  const lens = []
  for (const f of frames) {
    if (!f) continue
    for (const [h, k, a] of [[LM.hipL, LM.knL, LM.anL], [LM.hipR, LM.knR, LM.anR]]) {
      if (seen(f.w[h]) && seen(f.w[k]) && seen(f.w[a])) lens.push(dist(f.w[h], f.w[k]) + dist(f.w[k], f.w[a]))
    }
  }
  const m = median(lens)
  return Number.isFinite(m) ? m : 0.85
}

/**
 * How far the hips rise (jump) or drop (crouch) in meters, per frame. World landmarks are
 * centred on the hips, so this comes from where the hips are in the picture, turned into meters
 * using the person's leg length in the picture. Needs a camera that doesn't move.
 */
export function computeLift(frames) {
  const ratios = []
  const hipY = frames.map((f) => (f ? (f.i[LM.hipL][1] + f.i[LM.hipR][1]) / 2 : NaN))
  for (const f of frames) {
    if (!f || !seen(f.i[LM.anL]) || !seen(f.i[LM.anR])) continue
    const imgLeg = (f.i[LM.anL][1] + f.i[LM.anR][1]) / 2 - (f.i[LM.hipL][1] + f.i[LM.hipR][1]) / 2
    const worldLeg = (f.w[LM.anL][1] + f.w[LM.anR][1]) / 2 - (f.w[LM.hipL][1] + f.w[LM.hipR][1]) / 2
    if (imgLeg > 0.05 && worldLeg > 0.2) ratios.push(worldLeg / imgLeg)
  }
  const perUnit = median(ratios)
  const ref = median(hipY)
  if (!Number.isFinite(perUnit) || !Number.isFinite(ref)) return frames.map(() => 0)
  return hipY.map((y) => (Number.isFinite(y) ? (ref - y) * perUnit : 0))
}

/** Blend the last `seconds` into the first frame so the clip loops without a jump. */
export function loopBlend(frames, fps, seconds = 0.25) {
  const n = Math.min(frames.length - 1, Math.max(1, Math.round(seconds * fps)))
  const first = frames[0]
  if (!first) return frames
  return frames.map((f, k) => {
    const into = k - (frames.length - 1 - n)
    if (!f || into <= 0) return f
    const t = into / n
    return { ...f, w: lerpPoints(f.w, first.w, t), i: lerpPoints(f.i, first.i, t), lift: lerp(f.lift || 0, first.lift || 0, t) }
  })
}

/**
 * Raw tracker output -> a saved motion's frames.
 * opts: { fps, start, end (seconds), mirror, smoothing (frames), loop }
 */
export function processMotion(raw, { fps = 24, start = 0, end = Infinity, mirror = false, smoothing = 5, loop = false } = {}) {
  const found = raw.filter(Boolean).length
  const a = Math.max(0, Math.floor(start * fps))
  const b = Math.min(raw.length, Math.floor(end * fps) + 1)
  let frames = markOffscreen(raw.slice(a, b))
  if (mirror) frames = mirrorFrames(frames)
  frames = fillGaps(frames)
  if (!frames.some(Boolean)) return { frames: [], found, legLength: 0.85 }
  frames = smooth(frames, smoothing)
  const lift = computeLift(frames)
  frames = frames.map((f, k) => ({ w: f.w, i: f.i, lift: lift[k] }))
  if (loop) frames = loopBlend(frames, fps)
  return { frames, found, legLength: legLength(frames) }
}
