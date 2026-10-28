import { BONES } from './process.js'

/** Draw the tracked stick figure for one frame (image landmarks) onto a 2D canvas. */
export function drawSkeleton(ctx, frame, width, height, { color = '#b69cff', joint = '#ffffff', box = null } = {}) {
  if (!frame?.i) return
  const map = box ? ([x, y]) => [box.x + ((x - box.minX) / box.span) * box.size, box.y + ((y - box.minY) / box.span) * box.size] : ([x, y]) => [x * width, y * height]
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(2, width / 160)
  ctx.strokeStyle = color
  for (const [a, b] of BONES) {
    const pa = frame.i[a]
    const pb = frame.i[b]
    if ((pa[2] ?? 1) < 0.3 || (pb[2] ?? 1) < 0.3) continue
    const [ax, ay] = map(pa)
    const [bx, by] = map(pb)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }
  ctx.fillStyle = joint
  for (const k of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = frame.i[k]
    if ((p[2] ?? 1) < 0.3) continue
    const [x, y] = map(p)
    ctx.beginPath()
    ctx.arc(x, y, Math.max(2.5, width / 120), 0, Math.PI * 2)
    ctx.fill()
  }
}
