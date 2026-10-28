// Screenshots for the website (docs/img). Runs the real app with a scripted model
// standing in for the AI, real Blender (or bpy), and software WebGL so 3D renders.
//   npm run build
//   xvfb-run -a npx electron --no-sandbox scripts/showcase-shots.cjs --out=docs/img
// Needs "127.0.0.1 mac-studio.local" in /etc/hosts so the AI badge reads like a real setup.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
process.env.GAMESMITH_BLENDER ||= path.join(__dirname, 'fake-blender.py')

const outDir = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || 'docs/img')
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-show-'))
app.setPath('userData', path.join(tmp, 'userData'))
const showcase = (f) => fs.readFileSync(path.join(__dirname, 'showcase', f), 'utf8')

// ---------- scripted model ----------
const DOUBLE_JUMP_OLD = '    if (jump && this.player.body.blocked.down) this.player.setVelocityY(-520)'
const DOUBLE_JUMP_NEW = `    // Double jump: one extra jump in the air
    const pressed = jump && !this.jumpHeld
    this.jumpHeld = jump
    if (this.player.body.blocked.down) this.airJumps = 1
    if (pressed && this.player.body.blocked.down) this.player.setVelocityY(-520)
    else if (pressed && this.airJumps > 0) {
      this.airJumps--
      this.player.setVelocityY(-460)
    }`
const OBSTACLES_ANCHOR = 'for (let i = 0; i < 8; i++) spawnGem()\n'
const OBSTACLES = `
// Obstacles: pillars that bump the ball away
const obstacles = []
const pillarMat = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.45 })
for (let i = 0; i < 7; i++) {
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 3, 24), pillarMat)
  const a = (i / 7) * Math.PI * 2
  pillar.position.set(Math.cos(a) * 11, 1.5, Math.sin(a) * 11)
  pillar.castShadow = true
  scene.add(pillar)
  obstacles.push(pillar)
}
`
const BUMP_ANCHOR = '  camera.position.lerp('
const BUMP = `  for (const pillar of obstacles) {
    const dx = player.position.x - pillar.position.x
    const dz = player.position.z - pillar.position.z
    const d = Math.hypot(dx, dz)
    if (d > 0 && d < 2.2) {
      velocity.x = (dx / d) * 18
      velocity.z = (dz / d) * 18
    }
  }
`
const script = [
  // 2D: double jump
  { tool: ['read_file', { path: 'src/scenes/GameScene.js' }] },
  { tool: ['edit_file', { path: 'src/scenes/GameScene.js', old_text: DOUBLE_JUMP_OLD, new_text: DOUBLE_JUMP_NEW }] },
  { tool: ['check_game', {}] },
  { text: 'Added a double jump: press jump again in mid-air for a second, slightly lower jump. It resets when you land. The change is in src/scenes/GameScene.js.' },
  // 3D: obstacles
  { tool: ['read_file', { path: 'src/main.js' }] },
  { tool: ['edit_file', { path: 'src/main.js', old_text: OBSTACLES_ANCHOR, new_text: OBSTACLES_ANCHOR + OBSTACLES }] },
  { tool: ['edit_file', { path: 'src/main.js', old_text: BUMP_ANCHOR, new_text: BUMP + BUMP_ANCHOR }] },
  { tool: ['check_game', {}] },
  { text: 'Added seven red pillars in a ring around the arena. Rolling into one bounces the ball away, so you have to steer around them to reach the gems. All in src/main.js.' },
  // Blender: treasure chest
  { tool: ['write_script', { content: showcase('chest.py') }] },
  { tool: ['build_model', {}] },
  { text: 'Made a wooden treasure chest with a rounded dark-oak lid, gold bands and a gold lock: 0.9 m wide and 0.8 m tall, 344 triangles, so it is light enough to place lots of them.' }
]
let turn = 0
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }] }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const step = script[turn++] || { text: 'Done.' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    await new Promise((r) => setTimeout(r, 300))
    if (step.tool) {
      chunk({ tool_calls: [{ index: 0, id: `c${turn}`, type: 'function', function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] })
      chunk({}, 'tool_calls')
    } else {
      for (const w of step.text.split(/(?<= )/)) chunk({ content: w })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mock.listen(0, '127.0.0.1', async () => {
  const port = mock.address().port
  const services = await require('./mock-services.cjs').startMockServices(path.join(tmp, 'remote'))
  process.env.GAMESMITH_GITHUB_API = `http://127.0.0.1:${services.port}/api`
  process.env.GAMESMITH_RENDER_API = `http://127.0.0.1:${services.port}/render`
  process.env.GAMESMITH_GITHUB_WEB = `http://127.0.0.1:${services.port}/web`
  const projectsDir = path.join(tmp, 'Gamesmith Projects')
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'userData', 'settings.json'),
    JSON.stringify({
      projectsDir,
      libraryDir: path.join(tmp, 'Gamesmith Library'),
      ai: { preset: 'ollama', baseUrl: `http://mac-studio.local:${port}/v1`, model: 'qwen3-coder:30b', host: 'mac-studio.local', port }
    })
  )

  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
  await app.whenReady()
  let win
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100)
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setSize(1440, 900)
  const js = (code) => win.webContents.executeJavaScript(code)
  const shot = async (name, wait = 600) => {
    await sleep(wait)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG())
    console.log('shot', name)
  }
  const waitFor = async (sel, timeout = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (await js(`!!document.querySelector(${JSON.stringify(sel)})`)) return true
      await sleep(200)
    }
    throw new Error(`timed out waiting for ${sel}`)
  }
  const setInput = (sel, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const openGame = async (name) => {
    await waitFor('.project-card:not(.new)')
    await js(`[...document.querySelectorAll('.project-card')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`)
    await waitFor('.workspace iframe')
  }
  const askGameAI = async (text) => {
    await setInput('.chat-slot .chat-input textarea', text)
    await js(`document.querySelector('.chat-slot .chat-input .btn.ai').click()`)
    await waitFor('.chat-slot .msg.ai:not(.live) .msg-text', 60000)
  }

  try {
    // Games and a few library models to make the app look lived-in.
    await js(`window.gs.projects.create({ name: 'Space Goats', templateId: 'phaser-2d' })`)
    await js(`window.gs.projects.create({ name: 'Marble Run', templateId: 'three-3d' })`)
    await js(`window.gs.projects.importHtml(${JSON.stringify(path.join(__dirname, 'fixtures', 'one-file-game.html'))})`)
    for (const [name, file] of [['Crystal cluster', 'crystal.py'], ['Pine tree', 'pine.py'], ['Iron lantern', 'lantern.py']]) {
      const id = await js(`window.gs.library.create(${JSON.stringify(name)}, '')`)
      await js(`window.gs.library.saveScript(${JSON.stringify(id)}, ${JSON.stringify(showcase(file))})`)
      const r = await js(`window.gs.library.build(${JSON.stringify(id)})`)
      if (!r.ok) throw new Error(`${name}: ${r.error}`)
    }
    win.webContents.reload()
    await waitFor('.project-card:not(.new)')
    // Show the folder as it reads on Windows rather than this test machine's temp path.
    await js(`document.querySelector('.home-main > p.muted.small').textContent = ${JSON.stringify(String.raw`Games are saved in C:\Users\you\Documents\Gamesmith Projects`.replace(/\\\\/g, '\\'))}`)
    await shot('home')

    // 2D game + AI
    await openGame('Space Goats')
    await askGameAI('Give the player a double jump')
    await sleep(1500)
    await shot('build-2d')

    // Publish (Space Goats): sign in, create the repo, Pages + Render
    await js(`window.gs.github.signInToken('ghp_testtoken')`)
    await js(`window.gs.publish.createRepo({ name: 'Space Goats', isPrivate: false })`)
    await js(`window.gs.publish.enablePages()`)
    await js(`window.gs.render.setKey('rnd_testkey')`)
    await js(`window.gs.publish.createRender('tea-1')`)
    await js(`[...document.querySelectorAll('.btn.play')].find(b => b.textContent === 'Publish').click()`)
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      const n = await js(`[...document.querySelectorAll('.site-state')].filter(e => e.textContent === 'Live').length`)
      if (n === 2) break
      await sleep(500)
    }
    // The test hosts run on this machine; show the addresses as they look for a real account.
    await js(`(() => {
      const [pages, render] = [...document.querySelectorAll('.site a')]
      pages.textContent = 'https://you.github.io/Space-Goats/'
      render.textContent = 'https://space-goats.onrender.com'
      document.querySelector('.repo-link').textContent = 'you/Space-Goats'
    })()`)
    await shot('publish')
    await js(`document.querySelector('.publish-head .btn').click()`)
    await js(`document.querySelector('.back').click()`)

    // 3D game + AI
    await openGame('Marble Run')
    await askGameAI('Add obstacles that bump the ball away')
    await sleep(3500)
    await shot('build-3d')

    // Blender tab: new model from a description
    await js(`document.querySelector('.blender-tab').click()`)
    await waitFor('.lib-head .btn.play')
    await js(`document.querySelector('.lib-head .btn.play').click()`)
    await waitFor('.modal input')
    await setInput('.modal input', 'Treasure chest')
    await setInput('.modal textarea', 'A wooden treasure chest with gold trim')
    await js(`document.querySelector('.modal .btn.play').click()`)
    await waitFor('.right > .chat .msg.ai:not(.live) .msg-text', 120000)
    await waitFor('.viewer canvas', 20000)
    await shot('blender', 2500)
    await js(`[...document.querySelectorAll('.asset-view .seg button')].find(b => b.textContent.startsWith('Script')).click()`)
    await waitFor('.asset-stage .monaco-editor', 15000)
    await shot('blender-script', 1500)

  } catch (e) {
    console.error('SHOWCASE ERROR', e)
    app.exit(1)
    return
  }
  console.log('Screenshots in', outDir)
  mock.close()
  app.exit(0)
})
