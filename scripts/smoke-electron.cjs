// Full UI smoke test inside real Electron, with a scripted mock model.
// Creates a game, opens it, asks the AI for a change, and verifies that a
// runtime error the "model" introduces is caught by the real preview and
// fixed automatically. Saves screenshots along the way.
//   npm run build
//   xvfb-run -a npx electron --no-sandbox scripts/smoke-electron.cjs <screenshotDir>
const { app, BrowserWindow } = require('electron')
const FAKE_BLENDER = process.env.GAMESMITH_BLENDER || require('node:path').join(__dirname, 'fake-blender.py')
process.env.GAMESMITH_BLENDER = '/no/blender/here' // start without Blender to see the setup screen
// A local update server that offers version 9.9.9 (the updater test covers checksums and errors)
const updateBytes = require('node:crypto').randomBytes(50000)
const updateSha = require('node:crypto').createHash('sha512').update(updateBytes).digest('base64')
const updates = require('node:http').createServer((req, res) => {
  if (/^\/latest(-[a-z]+)?\.yml/.test(req.url)) return res.end(`version: 9.9.9\nfiles:\n  - url: Gamesmith-Setup.exe\n    sha512: ${updateSha}\n    size: ${updateBytes.length}\npath: Gamesmith-Setup.exe\nsha512: ${updateSha}\nreleaseDate: '2026-10-28T12:00:00.000Z'\nreleaseNotes: 'Faster everything'\n`)
  if (req.url.startsWith('/Gamesmith-Setup.exe')) return res.end(updateBytes)
  res.writeHead(404).end()
})
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const shotDir = path.resolve(process.argv.find((a) => a.startsWith('--shots='))?.slice(8) || path.join(os.tmpdir(), 'gamesmith-shots'))
fs.mkdirSync(shotDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-smoke-'))
app.setPath('userData', path.join(tmp, 'userData'))
app.setName('Gamesmith')

// ---------- scripted mock model ----------
const script = [
  { tool: { name: 'read_file', args: { path: 'src/scenes/GameScene.js' } } },
  {
    tool: {
      name: 'edit_file',
      args: { path: 'src/scenes/GameScene.js', old_text: '    this.score = 0\n', new_text: '    this.score = 0\n    this.enemies.spawnWave()\n' }
    }
  },
  { text: 'I added a wave of enemies.' },
  {
    tool: {
      name: 'edit_file',
      args: { path: 'src/scenes/GameScene.js', old_text: '    this.enemies.spawnWave()\n', new_text: '' }
    }
  },
  {
    tool: {
      name: 'edit_file',
      args: { path: 'src/scenes/GameScene.js', old_text: "g.fillStyle(0x4cc9f0).fillRoundedRect(0, 0, 32, 40, 6)", new_text: "g.fillStyle(0xff5d8f).fillRoundedRect(0, 0, 32, 40, 6)" }
    }
  },
  { tool: { name: 'check_game', args: {} } },
  { text: 'Fixed the crash (the enemy group did not exist yet) and made the player pink. Press the arrow keys to try it.' },
  // Second request (3D game): the AI finds and downloads assets itself.
  { tool: { name: 'search_assets', args: { query: 'crate', type: 'models' } } },
  { tool: { name: 'add_asset', args: { id: 'wooden_crate_01', type: 'models' } } },
  { tool: { name: 'add_asset', args: { id: 'kloofendal_48d_partly_cloudy_puresky', type: 'hdris' } } },
  { text: 'Added a wooden crate and a cloudy sky.' },
  // Third request: the modeling AI in the Blender tab (slow first reply, to test leaving and coming back).
  {
    delay: 4000,
    tool: {
      name: 'write_script',
      args: {
        content:
          'bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.25))\nbody = bpy.context.object\nbody.name = "Body"\nbody.scale = (0.8, 0.5, 0.5)\nassign(body, mat("Wood", (0.45, 0.28, 0.14), roughness=0.8))\n' +
          'bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.25, depth=0.8, location=(0, 0, 0.5), rotation=(0, math.radians(90), 0))\nlid = bpy.context.object\nlid.name = "Lid"\nassign(shade_smooth(lid), mat("Gold", (0.85, 0.65, 0.2), roughness=0.3, metallic=1.0))\n'
      }
    }
  },
  { tool: { name: 'build_model', args: {} } },
  { text: 'A wooden chest with a rounded gold lid, 0.8 m wide.' }
]
let turn = 0
const requests = []
const mock = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'qwen-coder-mock:32b' }] }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    requests.push(JSON.parse(body))
    const step = script[turn++] || { text: 'Done.' }
    if (step.delay) await new Promise((r) => setTimeout(r, step.delay))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (step.tool) {
      chunk({ reasoning_content: `I should call ${step.tool.name}.` })
      chunk({ tool_calls: [{ index: 0, id: `c${turn}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] })
      chunk({}, 'tool_calls')
    } else {
      for (const w of step.text.split(/(?<= )/)) {
        chunk({ content: w })
        await new Promise((r) => setTimeout(r, 15))
      }
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
  await new Promise((r) => updates.listen(0, '127.0.0.1', r))
  process.env.GAMESMITH_UPDATE_URL = `http://127.0.0.1:${updates.address().port}`
  process.env.GAMESMITH_APP_VERSION = '0.8.0'
  process.env.GAMESMITH_UPDATE_DELAY_MS = '1500'
  const port = mock.address().port
  const services = await require('./mock-services.cjs').startMockServices(path.join(tmp, 'remote'))
  process.env.GAMESMITH_GITHUB_API = `http://127.0.0.1:${services.port}/api`
  process.env.GAMESMITH_RENDER_API = `http://127.0.0.1:${services.port}/render`
  process.env.GAMESMITH_GITHUB_WEB = `http://127.0.0.1:${services.port}/web`
  const polyhaven = await require('./mock-polyhaven.cjs').startMockPolyHaven()
  process.env.GAMESMITH_POLYHAVEN_API = polyhaven.base
  if (process.env.SC_REPO) {
    // A real game with its own server, served by the test git server for "import from GitHub"
    require('node:child_process').execFileSync('git', ['clone', '-q', '--bare', process.env.SC_REPO, path.join(tmp, 'remote', 'shattered-crown.git')])
    process.env.GAMESMITH_CLONE_URL_OVERRIDE = `http://127.0.0.1:${services.port}/git/{name}.git`
  }
  const polypizza = await require('./mock-polyhaven.cjs').startMockPolyPizza()
  process.env.GAMESMITH_POLYPIZZA_API = polypizza.api
  const projectsDir = path.join(tmp, 'projects')
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'userData', 'settings.json'),
    JSON.stringify({ projectsDir, libraryDir: path.join(tmp, 'Gamesmith Library'), ai: { preset: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen-coder-mock:32b', host: 'Mac-Studio.local', port: 11434 }, github: { clientId: 'Ov23-test' } })
  )

  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
  await app.whenReady()
  let win
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100)
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.setSize(1500, 920)
  const js = (code) => win.webContents.executeJavaScript(code)
  const shot = async (name) => {
    await sleep(400)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(shotDir, `${name}.png`), img.toPNG())
  }
  const openGame = async (name) => {
    const sel = `[...document.querySelectorAll('.project-card')].find(b => b.textContent.includes(${JSON.stringify(name)}))`
    for (let i = 0; i < 100; i++) {
      if (await js(`!!${sel}`)) return js(`${sel}.click()`)
      await sleep(100)
    }
    throw new Error(`game card "${name}" never appeared`)
  }
  const waitFor = async (selector, timeout = 20000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) return true
      await sleep(200)
    }
    return false
  }

  try {
    await waitFor('.project-card.new')
    check(await waitFor('.update-notice', 15000), 'update notice appears when a new version is out')
    const noticeText = await js(`document.querySelector('.update-notice').innerText`)
    check(/Gamesmith 9\.9\.9 is available/.test(noticeText) && /You have 0\.8\.0/.test(noticeText), 'notice names the new and current versions')
    await js(`[...document.querySelectorAll('.update-notice button')].find(b => b.textContent === "What's new").click()`)
    await sleep(200)
    check(/Faster everything/.test(await js(`document.querySelector('.update-notes')?.textContent || ''`)), "What's new shows the release notes")
    await shot('0-update-available')
    await js(`[...document.querySelectorAll('.update-notice button')].find(b => b.textContent === 'Update now').click()`)
    check(await waitFor('.update-notice .btn.play', 15000) && /Restart to update/.test(await js(`document.querySelector('.update-notice').innerText`)), 'downloads, then offers Restart to update')
    await shot('0b-update-ready')
    await shot('1-home-empty')

    // New-game dialog
    await js(`document.querySelector('.project-card.new').click()`)
    await waitFor('.modal')
    await shot('2-new-game-dialog')
    await js(`window.gs.projects.create({ name: 'Space Goats', templateId: 'phaser-2d' })`)
    await js(`window.gs.projects.create({ name: 'Marble Run', templateId: 'three-3d' })`)
    await js(`document.querySelector('.modal-actions .btn.ghost').click()`)
    win.webContents.reload()
    await waitFor('.project-card:not(.new)')
    await shot('3-home-with-games')

    // My 3D models before Blender is set up
    await js(`document.querySelector('.studio-card').click()`)
    check(await waitFor('.blender-setup', 10000), 'setup screen shown when Blender is missing')
    const setupW = await js(`document.querySelector('.blender-setup').getBoundingClientRect().width`)
    const centerW = await js(`document.querySelector('.studio-page .center').getBoundingClientRect().width`)
    check(setupW >= 500 && centerW > 900, `setup screen uses the full center area (${Math.round(centerW)} px wide)`)
    await shot('3b-blender-setup')
    process.env.GAMESMITH_BLENDER = FAKE_BLENDER
    await js(`[...document.querySelectorAll('.blender-setup button')].find(b => b.textContent === 'Check again').click()`)
    check(await waitFor('.lib-head', 20000), '"Check again" finds Blender once it is installed')
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')

    // Open the 3D game first to check it renders
    await openGame('Marble Run')
    check(await waitFor('.workspace iframe'), 'workspace opens with preview')
    await sleep(3500)
    await shot('4-workspace-3d')
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')

    // Open the 2D game and ask the AI for a change
    await openGame('Space Goats')
    await waitFor('.workspace iframe')
    await sleep(3000)
    await shot('5-workspace-2d')

    await js(`document.querySelector('.suggestion').click()`)
    await sleep(1200)
    await shot('6-ai-working')
    const done = await waitFor('.msg.ai:not(.live) .msg-text', 60000)
    check(done, 'AI run finished')
    await sleep(800)
    await shot('7-ai-done')

    const dir = path.join(projectsDir, 'space-goats')
    const scene = fs.readFileSync(path.join(dir, 'src/scenes/GameScene.js'), 'utf8')
    check(scene.includes('0xff5d8f') && !scene.includes('spawnWave'), 'final file has the fix and the color change')
    const fixPrompt = requests.map((r) => r.messages.at(-1)).find((m) => m.role === 'user' && /I ran the game and it has problems/.test(m.content))
    check(!!fixPrompt && /spawnWave|undefined/.test(fixPrompt.content), 'real preview caught the runtime error and fed it back to the model')
    if (fixPrompt) console.log('      error sent to model:', fixPrompt.content.split('\n').slice(1, 3).join(' | ').slice(0, 220))
    const chatText = await js(`document.querySelector('.chat-scroll').innerText`)
    check(/Game runs without errors/.test(chatText), 'final check badge shows the game runs clean')

    // Editor tab
    await js(`[...document.querySelectorAll('.file-chip')][0].click()`)
    check(await waitFor('.monaco-editor', 15000), 'Monaco editor opens the changed file')
    await sleep(1200)
    await shot('8-editor')

    // History panel
    await js(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'History').click()`)
    await waitFor('.history-list li')
    const commits = await js(`document.querySelectorAll('.history-list li').length`)
    check(commits >= 2, `history shows ${commits} versions`)
    await js(`document.querySelector('.game-tab').click()`)
    await js(`document.querySelector('.console-toggle').click()`)
    await shot('9-history-and-console')

    // Settings
    await js(`document.querySelector('.ai-badge').click()`)
    await waitFor('.modal.wide')
    await js(`[...document.querySelectorAll('.modal .btn.ai')].find(b => b.textContent.includes('Test')).click()`)
    await sleep(1200)
    const msg = await js(`document.querySelector('.test-msg')?.textContent || ''`)
    check(/Connected\. 1 model/.test(msg), `settings connection test: "${msg}"`)
    await shot('10-settings')
    await js(`[...document.querySelectorAll('.modal .btn.ghost')].find(b => b.textContent === 'Cancel').click()`)

    // ---- Publish flow ----
    const setInput = (sel, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    const clickText = (text) => js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`)

    await clickText('Publish')
    await waitFor('.publish')
    await shot('11-publish-connect')
    await clickText('Sign in with GitHub')
    check(await waitFor('.device-code strong', 8000), 'device code shown')
    await sleep(1500)
    const code = await js(`document.querySelector('.device-code strong')?.textContent`)
    check(code === 'ABCD-1234', `device code stays on screen while waiting (${code})`)
    await shot('11b-device-code')
    check(await waitFor('.publish .pub-row, .publish input:not([type])', 15000), 'GitHub device sign-in completed')
    await shot('12-publish-create-repo')
    await clickText('Create and upload')
    check(await waitFor('.repo-link', 30000), 'repo created and first upload done')
    const bare = path.join(tmp, 'remote', 'Space-Goats.git')
    const remoteFiles = require('node:child_process').execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).toString()
    check(remoteFiles.includes('src/scenes/GameScene.js') && remoteFiles.includes('lib/phaser/phaser.min.js'), 'game files are on the (mock) GitHub repo')

    services.state.staleOnce = new Set(['src/scenes/GameScene.js']) // first live request gets a stale 404
    await clickText('Publish on GitHub Pages')
    check(await waitFor('.site a', 15000), 'GitHub Pages site link shown')
    await shot('13-publish-pages-updating')

    await setInput('.host input[type=password]', 'rnd_testkey')
    await js(`[...document.querySelectorAll('.host button')].find(b => b.textContent === 'Connect').click()`)
    await sleep(800)
    await clickText('Publish on Render')
    const renderShown = await (async () => {
      for (let i = 0; i < 50; i++) {
        if ((await js(`document.querySelectorAll('.site a').length`)) >= 2) return true
        await sleep(200)
      }
      return false
    })()
    check(renderShown, 'Render site link shown')
    check(services.state.render?.serviceDetails?.publishPath === './', 'Render static site created with publishPath ./')
    // Pages: a stale 404 right after saving is shown as "still going live" and rechecked automatically
    const pagesPending = await (async () => {
      for (let i = 0; i < 60; i++) {
        const t = await js(`[...document.querySelectorAll('.site .muted.small')].map(e => e.textContent).find(t => /still going live/.test(t)) || ''`)
        if (t) return t
        await sleep(250)
      }
      return ''
    })()
    check(/1 new or changed file not there yet/.test(pagesPending), 'a file missing right after saving is reported as still deploying, not as a problem')
    check(!(await js(`!!document.querySelector('.verify-fail')`)), 'no error box while the new version is still going live')
    await shot('14a-verify-pending')
    const allLive = await (async () => {
      for (let i = 0; i < 160; i++) {
        const n = await js(`[...document.querySelectorAll('.site-state')].filter(e => e.textContent === 'Live').length`)
        if (n === 2) return true
        await sleep(250)
      }
      return false
    })()
    check(allLive, 'both hosts turn Live on their own once every file loads')
    const allLoad = await js(`[...document.querySelectorAll('.site .muted.small')].map(e => e.textContent).filter(t => /^All [0-9]+ files load[.]$/.test(t)).length`)
    check(allLoad === 2, 'each host reports all files load')
    await shot('14-publish-live')

    // Quick save from the top bar after an edit
    await js(`[...document.querySelectorAll('.publish-head .btn')][0].click()`)
    fs.appendFileSync(path.join(projectsDir, 'space-goats', 'GAME_DESIGN.md'), '\n- Added from the smoke test\n')
    await sleep(1500)
    await clickText('Save to GitHub')
    check(await waitFor('.save-msg.ok', 20000), 'top-bar Save to GitHub works')
    const remoteDoc = require('node:child_process').execFileSync('git', ['--git-dir', bare, 'show', 'main:GAME_DESIGN.md']).toString()
    check(remoteDoc.includes('Added from the smoke test'), 'edit reached GitHub')
    const remoteAuthor = require('node:child_process').execFileSync('git', ['--git-dir', bare, 'log', '-1', '--format=%an', 'main']).toString().trim()
    check(remoteAuthor === 'Jason Thistle', `manual save is authored by the GitHub account (${remoteAuthor})`)
    await shot('15-workspace-published')

    // ---- Asset browser (3D game) ----
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')
    await openGame('Marble Run')
    await waitFor('.workspace iframe')
    await js(`document.querySelector('.assets-tab').click()`)
    check(await waitFor('.asset-card', 10000), 'asset browser lists Poly Haven models')
    await setInput('.asset-search', 'barrel')
    await sleep(900)
    const names = await js(`[...document.querySelectorAll('.asset-name')].map(e => e.textContent)`)
    check(names.length === 1 && names[0] === 'Barrel 03', `search narrows results (${names.join(', ')})`)
    await js(`document.querySelector('.asset-card').click()`)
    check(await waitFor('.asset-detail .btn.play:not([disabled])', 10000), 'asset detail shows size and Add button')
    const addLabel = await js(`document.querySelector('.asset-detail .btn.play').textContent`)
    check(/Add to game \(\d+ KB\)/.test(addLabel), `download size shown before adding ("${addLabel}")`)
    await shot('16-asset-detail')
    await js(`document.querySelector('.asset-detail .btn.play').click()`)
    check(await waitFor('.asset-detail .installed', 15000), 'asset added to the game')
    const marble = path.join(projectsDir, 'marble-run')
    check(fs.existsSync(path.join(marble, 'assets/models/barrel_03/barrel_03.gltf')) && fs.existsSync(path.join(marble, 'assets/models/barrel_03/barrel_03.bin')), 'model + .bin on disk')
    check(/Barrel 03/.test(fs.readFileSync(path.join(marble, 'assets/CREDITS.md'), 'utf8')), 'credits file updated')
    const footer = await js(`document.querySelector('.assets-foot a')?.textContent`)
    check(footer === 'Powered by Poly Haven', 'Poly Haven credit visible')
    await js(`[...document.querySelectorAll('.seg.inline button')].find(b => b.textContent.startsWith('In this game')).click()`)
    await waitFor('.mine-list li')
    await shot('17-assets-in-game')

    // Poly Pizza: empty Poly Haven search points there; key form; low-poly search; CC-BY credit
    await js(`[...document.querySelectorAll('.seg.inline button')].find(b => b.textContent === 'Models').click()`)
    await waitFor('.asset-search')
    await setInput('.asset-search', 'bike')
    check(await waitFor('.empty-hint', 8000), 'empty Poly Haven search suggests low-poly library')
    await shot('17b-empty-hint')
    await js(`document.querySelector('.empty-hint .btn').click()`)
    check(await waitFor('.pp-key', 5000), 'Poly Pizza asks for a key')
    await setInput('.pp-key input', 'pp_badkey')
    await js(`document.querySelector('.pp-key .btn.play').click()`)
    check(await waitFor('.pp-key .notice.error', 8000), 'bad Poly Pizza key rejected with a message')
    await setInput('.pp-key input', 'pp_testkey')
    await js(`document.querySelector('.pp-key .btn.play').click()`)
    check(await waitFor('.asset-card', 10000), 'Poly Pizza popular models shown after connecting')
    await setInput('.asset-search', 'car')
    await sleep(900)
    const ppNames = await js(`[...document.querySelectorAll('.asset-name')].map(e => e.textContent)`)
    check(ppNames.join(',') === 'Red Sports Car,Delivery Truck', `low-poly search finds vehicles (${ppNames.join(', ')})`)
    const badges = await js(`[...document.querySelectorAll('.asset-card .lic')].map(e => e.textContent)`)
    check(badges.join(',') === 'CC0,Credit', `license badges shown (${badges.join(', ')})`)
    await js(`[...document.querySelectorAll('.asset-card')][1].click()`)
    await waitFor('.asset-detail .btn.play:not([disabled])', 10000)
    const detailText = await js(`document.querySelector('.asset-detail').innerText`)
    check(/CC-BY/.test(detailText) && /credit required/.test(detailText), 'detail explains the credit requirement')
    await shot('17c-polypizza')
    await js(`document.querySelector('.asset-detail .btn.play').click()`)
    check(await waitFor('.asset-detail .installed', 15000), 'low-poly model added')
    check(fs.existsSync(path.join(marble, 'assets/models/delivery-truck-TruckX3/delivery-truck.glb')), 'truck .glb on disk')
    check(/Jarlan Perez/.test(fs.readFileSync(path.join(marble, 'assets/CREDITS.md'), 'utf8')), 'CC-BY creator credited')
    await js(`document.querySelector('.ai-badge').click()`)
    await waitFor('.modal.wide')
    await sleep(600) // connection status loads asynchronously
    const settingsText = await js(`document.querySelector('.modal.wide').innerText`)
    if (!/Poly Pizza is connected/.test(settingsText)) console.log('SETTINGS TEXT:', settingsText.slice(0, 1500))
    check(/Asset libraries/.test(settingsText) && /Poly Pizza is connected/.test(settingsText), 'Settings shows Poly Pizza connected')
    await js(`[...document.querySelectorAll('.modal .btn.ghost')].find(b => b.textContent === 'Cancel').click()`)
    await js(`[...document.querySelectorAll('.seg.inline button')].find(b => b.textContent.startsWith('In this game')).click()`)
    await waitFor('.mine-list li')

    // "Ask AI to use it" drops a started request into the chat box
    await js(`[...document.querySelectorAll('.mine-list li')].find(li => li.textContent.includes('Barrel 03')).querySelector('.btn.ai').click()`)
    await sleep(400)
    const draftText = await js(`document.querySelector('.chat-input textarea').value`)
    check(draftText.startsWith('Use the Barrel 03 (assets/models/barrel_03/barrel_03.gltf)'), 'chat box pre-filled from asset')

    // The AI searches and downloads assets on its own
    await js(`(() => { const t = document.querySelector('.chat-input textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Add some crates and a nice sky'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await sleep(200)
    await js(`document.querySelector('.chat-input .btn.ai').click()`)
    check(await waitFor('.msg.ai:not(.live) .msg-text', 60000), 'AI asset request finished')
    check(fs.existsSync(path.join(marble, 'assets/models/wooden_crate_01/wooden_crate_01.gltf')), 'AI downloaded the crate model')
    check(fs.existsSync(path.join(marble, 'assets/skies/kloofendal_48d_partly_cloudy_puresky_1k.hdr')), 'AI downloaded the sky')
    const toolResult = requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
    check(/HDRLoader/.test(toolResult) && /GLTFLoader/.test(toolResult), 'AI was told exactly how to load each asset')
    const fixPrompts3d = requests.slice(-4).filter((r) => /I ran the game and it has problems/.test(r.messages.at(-1).content)).length
    check(fixPrompts3d === 0, 'no auto-fix rounds wasted on a missing GPU')
    const chat3d = await js(`document.querySelector('.chat-scroll').innerText`)
    check(/3D graphics \(WebGL\) couldn't start on this computer/.test(chat3d), 'user told it is a graphics problem, not a game bug')
    check(/Added assets: Wooden Crate 01, Kloofendal 48d Partly Cloudy \(Pure Sky\)/.test(chat3d), 'reply lists added assets by name')
    const sysPrompt = requests.at(-1).messages[0].content
    check(/Barrel 03 \[models\] assets\/models\/barrel_03\/barrel_03\.gltf/.test(sysPrompt), 'system prompt lists assets already in the game')
    const apiCalls = polyhaven.state.requests.filter((r) => !r.url.startsWith('/cdn/'))
    check(apiCalls.length > 5 && apiCalls.every((r) => /^Gamesmith\//.test(r.ua || '')), `all ${apiCalls.length} Poly Haven API/download requests sent the Gamesmith User-Agent`)
    await js(`document.querySelector('.game-tab').click()`)
    await shot('18-ai-added-assets')
    const errs = await js(`(() => { document.querySelector('.console-toggle').click(); return new Promise(r => setTimeout(() => r([...document.querySelectorAll('.log.error')].map(e => e.textContent.slice(0, 160))), 300)) })()`)
    if (process.env.SHOW_ERRORS) console.log('PREVIEW ERRORS:\n  ' + errs.join('\n  '))

    // ---- Blender tab: make a model with AI, add it to the game, back it up ----
    await js(`document.querySelector('.blender-tab').click()`)
    check(await waitFor('.lib-head', 15000), 'Blender tab opens (Blender found)')
    const libDir = path.join(tmp, 'Gamesmith Library')
    await shot('22-blender-empty')
    await js(`document.querySelector('.lib-head .btn.play').click()`)
    await waitFor('.modal input')
    await setInput('.modal input', 'Treasure Chest')
    await setInput('.modal textarea', 'A wooden treasure chest with a gold lid')
    await js(`document.querySelector('.modal .btn.play').click()`)
    check(await waitFor('.lib-item.on', 10000), 'new library asset created and selected')
    await sleep(500)
    const modelChatHead = await js(`document.querySelector('.right > .chat h2')?.textContent`)
    check(modelChatHead === 'Model with AI', 'right panel switches to the modeling chat')
    // The description from the New model dialog goes to the AI without retyping it.
    // Leave the tab while it works and come back: the progress must still be there.
    check(await waitFor('.right > .chat .msg.ai.live', 5000), 'AI starts on the new model by itself')
    await js(`document.querySelector('.game-tab').click()`)
    await sleep(600)
    await js(`document.querySelector('.blender-tab').click()`)
    check(await waitFor('.right > .chat .msg.ai.live .status', 3000), 'coming back to the tab shows the AI still working')
    check(await js(`!!document.querySelector('.right > .chat .btn.stop')`), 'Stop button available after coming back')
    check(await waitFor('.right > .chat .msg.ai:not(.live) .msg-text', 120000), 'modeling AI finished')
    const modelReq = requests.at(-1)
    check(modelReq.messages.find((m) => m.role === 'user')?.content === 'A wooden treasure chest with a gold lid', 'the description typed in New model was sent to the AI automatically')
    check(modelReq.tools.map((t) => t.function.name).join(',') === 'read_script,write_script,edit_script,build_model', 'modeling AI has the Blender tools')
    check(fs.existsSync(path.join(libDir, 'treasure-chest', 'model.glb')) && fs.existsSync(path.join(libDir, 'treasure-chest', 'preview.png')), 'Blender built model.glb and preview.png')
    check(await waitFor('.asset-detail .stats', 10000), 'measurements shown')
    const statsText = await js(`document.querySelector('.asset-detail .stats').innerText`)
    check(/0\.8 × 0\.5 m/.test(statsText) && /Gold/.test(statsText), `size and materials shown (${statsText.replace(/\n/g, ' ')})`)
    const viewerOk = await waitFor('.viewer canvas, .viewer.fallback img', 10000)
    check(viewerOk, 'model shows in the 3D view (or the rendered image without WebGL)')
    await sleep(1200)
    await shot('23-blender-model')
    await js(`[...document.querySelectorAll('.asset-view .seg button')].find(b => b.textContent === 'Render').click()`)
    await sleep(500)
    await shot('24-blender-render')
    await js(`[...document.querySelectorAll('.asset-view .seg button')].find(b => b.textContent.startsWith('Script')).click()`)
    check(await waitFor('.asset-stage .monaco-editor', 15000), 'script opens in the code editor')
    await shot('25-blender-script')
    await js(`[...document.querySelectorAll('.asset-detail .btn.play')].find(b => b.textContent.startsWith('Add to')).click()`)
    await sleep(1500)
    check(fs.existsSync(path.join(marble, 'assets/models/treasure-chest/treasure-chest.glb')), 'Add to Marble Run copied the model into the game')
    check(/My library/.test(fs.readFileSync(path.join(marble, 'assets/ASSETS.json'), 'utf8')), 'game manifest records it as from my library')
    await js(`document.querySelector('.lib-foot .btn').click()`)
    const backedUp = await (async () => {
      for (let i = 0; i < 100; i++) {
        const t = await js(`document.querySelector('.lib-foot')?.innerText || ''`)
        if (/Saved to Guinnessstache\/gamesmith-assets/.test(t)) return true
        await sleep(200)
      }
      return false
    })()
    check(backedUp, 'library backed up to a gamesmith-assets repo')
    const remoteLib = require('node:child_process').execFileSync('git', ['--git-dir', path.join(tmp, 'remote', 'gamesmith-assets.git'), 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })
    check(/treasure-chest\/model\.glb/.test(remoteLib) && /treasure-chest\/model\.py/.test(remoteLib) && !/\.gamesmith/.test(remoteLib), 'GitHub has the model, script and preview (not chats)')
    await shot('26-blender-backed-up')
    // An animated model: clip buttons appear and switch clips
    const knightId = await js(`window.gs.library.create('Knight', '')`)
    await js(`window.gs.library.saveScript(${JSON.stringify('KNIGHT')}, ${JSON.stringify('')})`.replace('"KNIGHT"', JSON.stringify(knightId)).replace('""', JSON.stringify(fs.readFileSync(path.join(__dirname, 'showcase', 'knight.py'), 'utf8'))))
    const kb = await js(`window.gs.library.build(${JSON.stringify(knightId)})`)
    check(kb.ok && kb.stats.clips?.length === 3, 'animated model builds with 3 clips')
    await sleep(800)
    await js(`[...document.querySelectorAll('.lib-item')].find(b => b.textContent.includes('Knight')).click()`)
    await sleep(500)
    await js(`[...document.querySelectorAll('.asset-view .seg button')].find(b => b.textContent === '3D view').click()`)
    check(await waitFor('.clip-bar .clip', 10000), 'animation buttons shown under the 3D view')
    const clipsShown = await js(`[...document.querySelectorAll('.clip-bar .clip')].map(b => b.textContent)`)
    check(clipsShown.join('|') === 'Rest pose|▶ Attack|▶ Idle|▶ Walk', `clips listed (${clipsShown.join(', ')})`)
    check((await js(`document.querySelector('.clip.on')?.textContent`)) === '▶ Idle', 'first looping clip plays by itself')
    await js(`[...document.querySelectorAll('.clip-bar .clip')].find(b => b.textContent === '▶ Walk').click()`)
    await sleep(300)
    check((await js(`document.querySelector('.clip.on')?.textContent`)) === '▶ Walk', 'clicking a clip plays it')
    check(/Animations/.test(await js(`document.querySelector('.asset-detail .stats').innerText`)), 'details list the animations')
    check(/3 animations/.test(await js(`[...document.querySelectorAll('.lib-item')].find(b => b.textContent.includes('Knight')).textContent`)), 'library shows the animation count')
    await shot('26b-blender-animations')
    await js(`document.querySelector('.game-tab').click()`)
    const gameChatVisible = await js(`!document.querySelector('.chat-slot').hidden`)
    check(gameChatVisible, 'game chat comes back on the Game tab')

    // The library on its own, from the home screen
    await js(`document.querySelector('.back').click()`)
    await waitFor('.studio-card')
    await js(`document.querySelector('.studio-card').click()`)
    check(await waitFor('.lib-item', 10000), 'My 3D models opens from the home screen')
    await shot('27-studio-page')
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')

    // ---- Start a new game from a single HTML file ----
    const imported = await js(`window.gs.projects.importHtml(${JSON.stringify(path.join(__dirname, 'fixtures', 'one-file-game.html'))})`)
    check(imported?.name === 'Dot Dodger' && imported.splitInto?.join(',') === 'style.css,game.js', 'one-file HTML game imported and split')
    win.webContents.reload()
    await waitFor('.project-card:not(.new)')
    await openGame('Dot Dodger')
    check(await waitFor('.workspace iframe', 20000), 'imported HTML game opens')
    await sleep(2500)
    const dotSrc = await js(`document.querySelector('.stage iframe').src`)
    const [dotHtml, dotJs] = await Promise.all([fetch(dotSrc).then((r) => r.text()), fetch(new URL('game.js', dotSrc)).then((r) => r.status)])
    check(/src="game.js"/.test(dotHtml) && dotJs === 200, 'preview serves the split game')
    await js(`document.querySelector('.console-toggle').click()`)
    await sleep(500)
    const dotErrors = await js(`[...document.querySelectorAll('.log.error')].map(e => e.textContent)`)
    check(dotErrors.every((t) => /logo\.png/.test(t)), `game runs; only the missing image is reported (${dotErrors.length} error lines)`)
    await shot('28-html-import')
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')

    // ---- Bring in an existing game with its own server ----
    if (process.env.SC_REPO) {
      await js(`document.querySelector('.back')?.click()`)
      await waitFor('.project-card.import')
      await js(`document.querySelector('.project-card.import').click()`)
      await waitFor('.repo-pick li, .modal.wide')
      await sleep(600)
      const listed = await js(`[...document.querySelectorAll('.repo-row strong')].map(e => e.textContent)`)
      await shot('19-import-dialog')
      await setInput('.modal.wide input', 'Guinnessstache/shattered-crown')
      await js(`[...document.querySelectorAll('.modal.wide .btn.play')].find(b => b.textContent === 'Import').click()`)
      check(await waitFor('.workspace iframe', 60000), 'imported game opens in the workspace')
      const title = await js(`document.querySelector('.ws-name').textContent + ' | ' + document.querySelector('.ws-title .muted').textContent`)
      check(title === 'Shattered Crown | Three.js, own server', `detected as a Three.js game with its own server (${title})`)
      const running = await (async () => {
        for (let i = 0; i < 240; i++) {
          const t = await js(`document.querySelector('.server-chip')?.textContent || ''`)
          if (/Server running/.test(t)) return true
          if (/Server stopped/.test(t)) return false
          await sleep(500)
        }
        return false
      })()
      check(running, 'Gamesmith installed packages and started the game server')
      await sleep(2500)
      const frameSrc = await js(`document.querySelector('.stage iframe').src`)
      const fr = await fetch(frameSrc)
      const framePage = fr.status + ' ' + (await fr.text()).includes('importmap')
      check(framePage === '200 true', 'preview shows the game served by its own server')
      await js(`document.querySelector('.console-toggle').click()`)
      await sleep(400)
      const serverLines = await js(`[...document.querySelectorAll('.log.server')].map(e => e.textContent).join('\\n')`)
      check(/Saves: .*db\.json/.test(serverLines), 'server output shows in the console')
      await shot('20-imported-server-game')
      await js(`document.querySelector('.btn.play').click()`) // Publish
      await waitFor('.publish')
      await sleep(800)
      const pubText = await js(`document.querySelector('.publish').innerText`)
      check(/Saved on GitHub/.test(pubText) && /Guinnessstache\/shattered-crown/.test(pubText), 'imported repo already linked for Save to GitHub')
      check(/Not available for this game/.test(pubText), 'GitHub Pages correctly unavailable for a server game')
      await shot('21-imported-publish')
      await js(`document.querySelector('.publish-head .btn').click()`)
      await js(`document.querySelector('.back').click()`)
      await waitFor('.project-card:not(.new)')
      const cards = await js(`[...document.querySelectorAll('.project-card .project-sub')].map(e => e.textContent).join(' / ')`)
      check(/with its own server/.test(cards), 'home screen lists the imported game')
    }
  } catch (e) {
    console.error('SMOKE ERROR', e)
    failures++
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nALL SMOKE CHECKS PASSED', `\nScreenshots: ${shotDir}`)
  mock.close()
  app.exit(failures ? 1 : 0)
})
