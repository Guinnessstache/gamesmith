// Full UI smoke test inside real Electron, with a scripted mock model.
// Creates a game, opens it, asks the AI for a change, and verifies that a
// runtime error the "model" introduces is caught by the real preview and
// fixed automatically. Saves screenshots along the way.
//   npm run build
//   xvfb-run -a npx electron --no-sandbox scripts/smoke-electron.cjs <screenshotDir>
const { app, BrowserWindow } = require('electron')
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
  { text: 'Fixed the crash (the enemy group did not exist yet) and made the player pink. Press the arrow keys to try it.' }
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
  const port = mock.address().port
  const projectsDir = path.join(tmp, 'projects')
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'userData', 'settings.json'),
    JSON.stringify({ projectsDir, ai: { preset: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen-coder-mock:32b', host: 'Mac-Studio.local', port: 11434 } })
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

    // Open the 3D game first to check it renders
    await js(`[...document.querySelectorAll('.project-card')].find(b => b.textContent.includes('Marble Run')).click()`)
    check(await waitFor('.workspace iframe'), 'workspace opens with preview')
    await sleep(3500)
    await shot('4-workspace-3d')
    await js(`document.querySelector('.back').click()`)
    await waitFor('.project-card:not(.new)')

    // Open the 2D game and ask the AI for a change
    await js(`[...document.querySelectorAll('.project-card')].find(b => b.textContent.includes('Space Goats')).click()`)
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
  } catch (e) {
    console.error('SMOKE ERROR', e)
    failures++
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nALL SMOKE CHECKS PASSED', `\nScreenshots: ${shotDir}`)
  mock.close()
  app.exit(failures ? 1 : 0)
})
