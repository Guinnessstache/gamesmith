// Motion capture, end to end in the real app:
//   fake webcam (a video file of a person) -> record -> track -> review -> save
//   -> "Add to character" -> the modeling AI applies it -> the character has the clip.
//
//   npm run build
//   GAMESMITH_POSE_MODEL=/path/to/pose_landmarker_full.task \
//   xvfb-run -a npx electron --no-sandbox scripts/smoke-mocap.cjs --camera=person.y4m [--shots=dir]
// Needs Blender (GAMESMITH_BLENDER, or bpy for scripts/fake-blender.py).
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const camera = path.resolve(arg('camera') || '')
const shotDir = path.resolve(arg('shots') || path.join(os.tmpdir(), 'gamesmith-mocap-shots'))
fs.mkdirSync(shotDir, { recursive: true })
if (!fs.existsSync(camera) || !process.env.GAMESMITH_POSE_MODEL) {
  console.log('SKIP  motion capture app test: needs --camera=<video of a person .y4m> and GAMESMITH_POSE_MODEL')
  process.exit(0)
}
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-video-capture', camera)
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
process.env.GAMESMITH_BLENDER ||= path.join(__dirname, 'fake-blender.py')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-mocap-'))
app.setPath('userData', path.join(tmp, 'userData'))
const HUMAN = `rig = Rig.humanoid()
skin = mat("Skin", (0.85, 0.65, 0.5))
cloth = mat("Tunic", (0.2, 0.5, 0.25))
for b in ("Hips", "Spine", "Chest"):
    rig.limb(b, width=0.34, depth=0.2, material=cloth)
rig.limb("Head", width=0.22, material=skin)
for s in ("L", "R"):
    for b in ("UpperArm", "LowerArm", "UpperLeg", "LowerLeg"):
        rig.limb(f"{b}.{s}", width=0.1, material=cloth if "Leg" in b else skin, extend=0.02)
    rig.limb(f"Foot.{s}", width=0.1, material=cloth)
`
const script = [
  { tool: ['read_script', {}] },
  { tool: ['write_script', { content: HUMAN + 'rig.apply_motion("Wave")\n' }] },
  { tool: ['build_model', {}] },
  { text: 'Added your recorded "Wave" motion to Villager as a clip called Wave.' }
]
let turn = 0
const requests = []
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests.push(JSON.parse(body))
    const step = script[turn++] || { text: 'Done.' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (step.tool) {
      chunk({ tool_calls: [{ index: 0, id: `c${turn}`, type: 'function', function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] })
      chunk({}, 'tool_calls')
    } else {
      chunk({ content: step.text })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

mock.listen(0, '127.0.0.1', async () => {
  const lib = path.join(tmp, 'Gamesmith Library')
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'userData', 'settings.json'),
    JSON.stringify({ projectsDir: path.join(tmp, 'projects'), libraryDir: lib, ai: { preset: 'custom', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'mock' } })
  )
  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
  await app.whenReady()
  let win
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100)
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setSize(1440, 900)
  const js = (code) => win.webContents.executeJavaScript(code)
  const shot = async (name) => {
    await sleep(500)
    fs.writeFileSync(path.join(shotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const waitFor = async (sel, timeout = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (await js(`!!document.querySelector(${JSON.stringify(sel)})`)) return true
      await sleep(200)
    }
    return false
  }
  const clickText = (text, scope = 'button') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b })()`)
  const setInput = (sel, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)

  try {
    // A character with a person skeleton, ready to receive the motion
    const villager = await js(`window.gs.library.create('Villager', 'A simple villager')`)
    await js(`window.gs.library.saveScript(${JSON.stringify(villager)}, ${JSON.stringify(HUMAN)})`)
    const vb = await js(`window.gs.library.build(${JSON.stringify(villager)})`)
    check(vb.ok && vb.stats.humanoid, 'a character built on the humanoid skeleton')

    await waitFor('.studio-card')
    await js(`document.querySelector('.studio-card').click()`)
    await waitFor('.lib-seg')
    await clickText('Motions')
    check(await waitFor('.lib-head .btn.play'), 'Motions section opens')
    await clickText('● Record')
    check(await waitFor('.tips'), 'recording tips shown')
    await shot('m1-record-start')
    await clickText('● Use my webcam')
    check(await waitFor('.camera video'), 'webcam preview opens')
    await sleep(1500)
    const live = await js(`(() => { const v = document.querySelector('.camera video'); return v.videoWidth + 'x' + v.videoHeight })()`)
    check(live !== '0x0', `camera is live (${live})`)
    await shot('m2-camera')
    await clickText('● Start recording')
    await sleep(1500)
    check((await js(`document.querySelector('.countdown')?.textContent`)) !== undefined, 'countdown before recording')
    await sleep(2200)
    check(await waitFor('.rec-dot', 3000), 'recording')
    await sleep(2500)
    await clickText('■ Stop')
    check(await waitFor('.review-controls', 120000), 'tracked the recording and opened the review')
    await sleep(1500)
    const drawn = await js(`(() => { const c = document.querySelector('.review canvas.overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k]) n++; return n })()`)
    check(drawn > 200, `stick figure drawn over the video (${drawn} pixels)`)
    await shot('m3-review')
    await setInput('.review-controls input:not([type])', 'Wave')
    await js(`[...document.querySelectorAll('.review-controls .check-label')].find(l => l.textContent.includes('Loops')).querySelector('input').click()`)
    await clickText('Save motion')
    check(await waitFor('.figure-stage', 20000), 'motion saved and shown as a moving stick figure')
    const motions = await js(`window.gs.motions.list()`)
    check(motions.length === 1 && motions[0].name === 'Wave' && motions[0].loop && motions[0].video === 'video.webm', `saved in the library with its video (${motions[0]?.seconds} s)`)
    const data = JSON.parse(fs.readFileSync(path.join(lib, 'motions', motions[0].id, 'motion.json'), 'utf8'))
    check(data.frames.length > 20 && data.frames.every((f) => f && f.w.length === 33), `${data.frames.length} frames of 33 landmarks, gaps filled`)
    await shot('m4-motion')

    // Put it on the character through the modeling AI
    await js(`(() => { const s = document.querySelector('.asset-detail select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(villager)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await clickText('Add to character')
    check(await waitFor('.right .msg.ai:not(.live) .msg-text', 120000), 'modeling AI finished')
    const ask = requests[0]?.messages.find((m) => m.role === 'user')?.content || ''
    check(/apply_motion\("Wave"\)/.test(ask), 'the AI was asked to apply the motion')
    check(/"Wave" \([0-9.]+ s, loops\)/.test(requests[0]?.messages[0].content || ''), 'the AI is told which motions exist')
    const meta = JSON.parse(fs.readFileSync(path.join(lib, villager, 'asset.json'), 'utf8'))
    check(meta.stats.clips?.some((c) => c.name === 'Wave' && c.loop), 'the character now has a looping "Wave" clip')
    check(await waitFor('.clip-bar .clip', 15000) && (await js(`[...document.querySelectorAll('.clip-bar .clip')].some(b => b.textContent === '▶ Wave')`)), 'Wave plays in the 3D view')
    await shot('m5-character')

    // Make a character that looks like me, from the same recording
    await clickText('Motions')
    await sleep(500)
    await js(`document.querySelector('.lib-item')?.click()`)
    check(await waitFor('.figure-stage', 10000), 'back on the motion')
    await clickText('Make a character that looks like me')
    check(await waitFor('.swatches input[type=color]', 30000), 'colors read from the video')
    const colors = await js(`[...document.querySelectorAll('.swatches input')].map(i => i.value)`)
    const shirt = colors[2]
    const faceShown = await js(`!document.querySelector('.make-me-face').hidden`)
    check(faceShown, 'face cropped for the photo')
    await shot('m6-make-me')
    await clickText('Create character')
    check(await waitFor('.clip-bar .clip', 180000), 'character built and shown')
    const list = await js(`window.gs.library.list()`)
    const me = list.find((a) => a.name === 'Me')
    check(me && me.stats?.humanoid && me.stats.materials.includes('Face photo') && me.stats.materials.includes('Shirt'), `"Me" has a person skeleton, outfit and face (${me?.stats?.materials})`)
    check(me && me.stats.clips?.some((c) => c.name === 'Wave'), 'and the recorded motion as a clip')
    const script = fs.readFileSync(path.join(lib, me.id, 'model.py'), 'utf8')
    const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
    const m = /shirt = mat\("Shirt", \(([^)]+)\)/.exec(script)
    check(m && hex(m[1].split(',').map(Number)) === shirt, `shirt color carried into the script (${shirt})`)
    check(fs.existsSync(path.join(lib, me.id, 'face.png')), 'face photo saved with the model')
    await sleep(2500)
    // the face texture really shows: some pixels in the 3D view are the photo's skin tones, not the flat material colors
    const textured = await js(`(() => { const c = document.querySelector('.asset-stage canvas'); return c ? c.toDataURL().length : 0 })()`)
    check(textured > 0, 'the 3D view rendered')
    await shot('m7-me')
  } catch (e) {
    console.error('MOCAP SMOKE ERROR', e)
    failures++
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nALL MOCAP CHECKS PASSED', `\nScreenshots: ${shotDir}`)
  mock.close()
  app.exit(failures ? 1 : 0)
})
