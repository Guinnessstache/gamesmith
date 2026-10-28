// Blender tab test: real Blender (or the bpy module through scripts/fake-blender.py),
// the asset library, the modeling AI loop with a scripted mock model, and adding a
// library model to a game.
//   GAMESMITH_BLENDER=/path/to/blender npm run test:blender
//   (defaults to scripts/fake-blender.py, which needs `pip install bpy`)
import http from 'node:http'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows needs file:// URLs for dynamic import of absolute paths.
const fileHref = (...parts) => pathToFileURL(join(...parts)).href
process.env.GAMESMITH_BLENDER ||= join(root, 'scripts', 'fake-blender.py')
process.env.GAMESMITH_POLYHAVEN_API = 'http://127.0.0.1:9' // offline: only the user's library answers
const blender = await import(fileHref(root, 'src/main/blender.js'))
const library = await import(fileHref(root, 'src/main/library.js'))
const { runModelAgent, formatBuild } = await import(fileHref(root, 'src/main/modelAgent.js'))
const assets = await import(fileHref(root, 'src/main/assets.js'))
const { createProject } = await import(fileHref(root, 'src/main/projects.js'))
const git = await import(fileHref(root, 'src/main/git.js'))
const runner = join(root, 'resources', 'blender', 'runner.py')

let passed = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  passed++
  console.log('  ✓', msg)
}

const tmp = fs.mkdtempSync(join(tmpdir(), 'gs-blender-'))
const userData = join(tmp, 'userdata')
fs.mkdirSync(userData)

// ---- finding Blender ----
const found = blender.find(userData)
ok(found.found, `found Blender ${found.version} at ${found.path}`)
const exe = found.path

// ---- a failing script reports the model.py line ----
fs.writeFileSync(join(tmp, 'bad.py'), 'x = 1\nbpy.ops.mesh.primitive_cube_add(size=1)\nundefined_thing()\n')
const bad = await blender.run({ blender: exe, runner, script: join(tmp, 'bad.py'), outGlb: join(tmp, 'bad.glb'), outPng: '-' })
ok(!bad.ok && /NameError/.test(bad.error) && /line 3/.test(bad.where), 'script error comes back with its line number')
ok(!fs.existsSync(join(tmp, 'bad.glb')), 'no model written for a failed build')

// ---- the library ----
library.configure(join(tmp, 'Gamesmith Library'))
const created = await library.create('Treasure Chest', 'A small wooden chest with gold trim')
ok(created.id === 'treasure-chest' && fs.existsSync(join(tmp, 'Gamesmith Library', 'treasure-chest', 'model.py')), 'asset created with a starter script')
const dup = await library.create('Treasure Chest')
ok(dup.id === 'treasure-chest-2', 'second asset with the same name gets its own folder')
await library.remove(dup.id)
ok(library.list().length === 1, 'asset removed')

// ---- modeling AI against a scripted mock model ----
const CHEST_BROKEN = `bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.25))
body = bpy.context.object
body.name = "Body"
body.scale = (0.8, 0.5, 0.5)
assign(body, mat("Wood", (0.45, 0.28, 0.14), roughness=0.8))
lid = bpy.context.objet  # typo the AI has to fix
`
const steps = [
  { tool: { name: 'write_script', args: { content: CHEST_BROKEN } } },
  { text: 'I made a chest.' }, // done without building: Gamesmith builds and finds the error
  { tool: { name: 'edit_script', args: { old_text: 'lid = bpy.context.objet  # typo the AI has to fix', new_text: 'bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.6))\nlid = bpy.context.object\nlid.name = "Lid"\nlid.scale = (0.82, 0.52, 0.2)\nassign(lid, mat("Gold", (0.85, 0.65, 0.2), roughness=0.3, metallic=1.0))' } } },
  { tool: { name: 'build_model', args: {} } },
  { text: 'A wooden chest with a gold lid, 0.82 m wide.' }
]
let turn = 0
const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests.push(JSON.parse(body))
    const step = steps[turn++] || { text: 'Done.' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (step.tool) {
      chunk({ tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] })
      chunk({}, 'tool_calls')
    } else {
      chunk({ content: step.text })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const events = []
const result = await runModelAgent({
  id: 'treasure-chest',
  ai: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock', maxSteps: 12, autoFixRounds: 3 },
  userText: 'Make a treasure chest',
  emit: (e) => events.push(e),
  build: () => library.build('treasure-chest', { blenderPath: exe, runner, commitMessage: false })
})
server.close()
ok(requests[0].messages[0].content.includes('Treasure Chest') && requests[0].tools.length === 4, 'modeling AI gets the asset brief and 4 tools')
const fixMsg = requests[2].messages.at(-1).content
ok(/failed/.test(fixMsg) && /AttributeError/.test(fixMsg) && /line 6/.test(fixMsg), 'automatic build found the error and sent it back with the line')
ok(result.build?.ok, 'second build succeeded')
const builds = events.filter((e) => e.type === 'build')
ok(builds.length === 2 && !builds[0].result.ok && builds[1].result.ok, 'UI got a build event for each build')
const stats = result.build.stats
ok(stats.objects === 2 && stats.size_m.width === 0.82 && stats.min_z === 0, `measured: ${stats.size_m.width} x ${stats.size_m.depth} x ${stats.size_m.height} m, ${stats.triangles} triangles`)
ok(/Build OK/.test(formatBuild(result.build)) && /Gold/.test(formatBuild(result.build)), 'build summary lists size and materials')
const f = library.files('treasure-chest')
ok(f['model.glb']?.subarray(0, 4).toString() === 'glTF', 'model.glb is a binary glTF')
ok(f['preview.png']?.subarray(1, 4).toString() === 'PNG', 'preview.png rendered')
ok(library.readMeta('treasure-chest').stats.triangles === stats.triangles, 'asset.json updated with measurements')
ok(!fs.readdirSync(join(tmp, 'Gamesmith Library', 'treasure-chest')).some((n) => n.includes('.tmp.')), 'no temporary files left')

// a broken edit later never replaces the last good model
const goodGlb = f['model.glb']
library.writeScript('treasure-chest', 'raise ValueError("oops")\n')
const failed = await library.build('treasure-chest', { blenderPath: exe, runner })
ok(!failed.ok && Buffer.compare(library.files('treasure-chest')['model.glb'], goodGlb) === 0, 'failed rebuild keeps the last good model')

await git.commitAll(library.dir(), 'test')
const history = await git.log(library.dir())
ok(history.length >= 3, `library has its own history (${history.length} versions)`)

// ---- using it in a game ----
ok(library.search('chest gold')[0]?.id === 'treasure-chest' && library.search('spaceship').length === 0, 'library search')
const found2 = await assets.searchAllModels('chest')
ok(found2[0]?.id === 'lib-treasure-chest' && found2[0].source === 'mine', "game AI's asset search includes the user's own models first")
const game = await createProject({ projectsDir: join(tmp, 'games'), resourcesDir: join(root, 'resources'), name: 'Chest Hunt', templateId: 'three-3d' })
const rec = await assets.addAsset(game.dir, { id: 'lib-treasure-chest', type: 'models' })
ok(fs.existsSync(join(game.dir, rec.entry)) && rec.entry === 'assets/models/treasure-chest/treasure-chest.glb', 'Add to game copies the model into the game')
const manifest = assets.readManifest(game.dir)
ok(manifest.assets.some((a) => a.id === 'lib-treasure-chest' && a.source === 'My library'), 'recorded in ASSETS.json as My library')
ok(/GLTFLoader/.test(assets.usageHint(rec, 'three-3d')) && /0\.82/.test(assets.usageHint(rec, 'three-3d')), 'game AI gets a usage hint with the real size')

// ---- animation: a rigged knight with three clips ----
{
  const knight = await library.create('Knight', 'Blocky knight with animations')
  library.writeScript(knight.id, fs.readFileSync(join(root, 'scripts/showcase/knight.py'), 'utf8'))
  const kb = await library.build(knight.id, { blenderPath: exe, runner })
  ok(kb.ok, 'animated knight builds')
  const names = (kb.stats.clips || []).map((c) => c.name).sort().join(',')
  ok(names === 'Attack,Idle,Walk' && kb.stats.clips.find((c) => c.name === 'Attack').loop === false, `clips reported with length and looping (${names})`)
  ok(/Animations: .*Walk \(0\.9 s, loops\)/.test(formatBuild(kb)) && /Attack \(0\.8 s, plays once\)/.test(formatBuild(kb)), 'modeling AI is told which clips exist')
  ok(kb.stats.min_z === 0, 'knight stands on the ground')

  // Play the clips the way a game would (Three.js AnimationMixer) and check the parts really move.
  const THREE = await import('three')
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const bytes = library.files(knight.id)['model.glb']
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', res, rej))
  ok(gltf.animations.map((a) => a.name).sort().join(',') === 'Attack,Idle,Walk', 'the .glb carries all three animations')
  const legTip = () => {
    gltf.scene.updateMatrixWorld(true)
    let leg
    gltf.scene.traverse((o) => o.isMesh && /^Leg\.?L/.test(o.name) && (leg = o))
    return new THREE.Box3().setFromObject(leg).getCenter(new THREE.Vector3())
  }
  const rest = legTip()
  const mixer = new THREE.AnimationMixer(gltf.scene)
  mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Walk')).play()
  mixer.update(0.01)
  const stride = legTip()
  ok(stride.z - rest.z > 0.1, `Walk swings the left leg forward (${(stride.z - rest.z).toFixed(2)} m toward the front)`)
  mixer.stopAllAction()

  const game = await createProject({ projectsDir: join(tmp, 'games2'), resourcesDir: join(root, 'resources'), name: 'Knight Game', templateId: 'three-3d' })
  const kr = await assets.addAsset(game.dir, { id: `lib-${knight.id}`, type: 'models' })
  const hint = assets.usageHint(kr, 'three-3d')
  ok(/AnimationMixer/.test(hint) && /"Walk"/.test(hint) && /LoopOnce/.test(hint), 'game AI is told the clip names and how to play them')
}

// ---- downloading portable Blender: blocked server, then a good mirror; checksum enforced ----
{
  const { execFileSync } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const pkg = join(tmp, 'pkg', 'blender-5.2.3-windows-x64')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(join(pkg, 'blender'), '#!/bin/sh\necho "Blender 5.2.3"\n')
  execFileSync('python3', ['-c', `import shutil; shutil.make_archive(${JSON.stringify(join(tmp, 'blender-5.2.3-windows-x64'))}, 'zip', ${JSON.stringify(join(tmp, 'pkg'))})`])
  const zip = fs.readFileSync(join(tmp, 'blender-5.2.3-windows-x64.zip'))
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/blocked/')) return res.writeHead(403).end('Forbidden')
    res.writeHead(200, { 'Content-Length': zip.length }).end(zip)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const saved = process.env.GAMESMITH_BLENDER
  delete process.env.GAMESMITH_BLENDER
  process.env.GAMESMITH_BLENDER_MIRROR = `${base}/blocked,${base}/good`
  process.env.GAMESMITH_BLENDER_SHA256 = '0'.repeat(64)
  const dl1 = join(tmp, 'dl1')
  await assert.rejects(blender.download(dl1), (e) => /HTTP 403/.test(e.message) && /didn't match/.test(e.message) && /I have Blender/.test(e.message))
  ok(!fs.existsSync(join(dl1, 'blender', 'blender-5.2.3-windows-x64.zip.part')), 'wrong checksum is rejected, the reason for each server is shown, nothing left behind')
  process.env.GAMESMITH_BLENDER_SHA256 = createHash('sha256').update(zip).digest('hex')
  const phases = []
  const got = await blender.download(join(tmp, 'dl2'), { onProgress: (p) => phases.push(p.phase) })
  ok(got.found && got.version === '5.2.3' && phases.includes('Unpacking'), 'blocked server skipped, mirror download verified, unpacked and found')
  process.env.GAMESMITH_BLENDER = saved
  delete process.env.GAMESMITH_BLENDER_MIRROR
  delete process.env.GAMESMITH_BLENDER_SHA256
  srv.close()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nBlender: ${passed} checks passed`)
