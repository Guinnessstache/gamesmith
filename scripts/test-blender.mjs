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
ok(requests[0].messages[0].content.includes('Treasure Chest') && requests[0].tools.length === 5 && requests[0].tools.some((t) => t.function.name === 'find_textures'), 'modeling AI gets the asset brief and 5 tools (including texture search)')
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

// ---- recorded motions: retargeting accuracy, and saving motions in the library ----
{
  const motions = library.motionsRoot()
  fs.mkdirSync(motions, { recursive: true })
  const rt = await blender.run({ blender: exe, runner, script: join(root, 'scripts/fixtures/mocap-roundtrip.py'), outGlb: join(tmp, 'rt.glb'), outPng: '-', motionsDir: motions })
  const resFile = join(motions, 'roundtrip-result.json')
  const res = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : { error: rt.error }
  fs.rmSync(resFile, { force: true })
  ok(rt.ok && res.worst_deg <= 3, `a posed skeleton turned into landmarks and back matches within ${res.worst_deg} degrees on every bone`)
  ok(Math.abs(res.lift - 0.1) < 0.01, 'hip lift (jumps, crouches) carried over')
  ok(rt.stats?.humanoid === true, 'build reports a person-shaped skeleton')
  fs.rmSync(join(motions, 'roundtrip'), { recursive: true, force: true })

  const frames = Array.from({ length: 10 }, (_, k) => ({ w: Array.from({ length: 33 }, () => [0.1 * k, -0.5, 0.01, 0.9]), i: Array.from({ length: 33 }, () => [0.5, 0.5, 0.9]), lift: 0 }))
  const saved = await library.saveMotion({ name: 'Wave', fps: 24, loop: true, legLength: 0.82, frames }, { bytes: new Uint8Array([1, 2, 3]), ext: 'webm' })
  ok(saved.name === 'Wave' && saved.frames === 10 && saved.video === 'video.webm', 'motion saved with its video')
  await assert.rejects(library.saveMotion({ name: 'wave', fps: 24, frames }), /already have a motion/)
  ok(library.listMotions().length === 1 && library.list().every((a) => a.id !== 'motions'), 'motions listed separately from models')
  const files = await (await import('isomorphic-git')).default.listFiles({ fs, dir: library.dir() })
  ok(files.includes('motions/wave/motion.json') && !files.some((f) => f.startsWith('motions/wave/video')), 'the motion is versioned (and backed up), the video of you stays on this computer')

  // "Make a character that looks like me": generated script with your measurements, colors and face
  const zlib = await import('node:zlib')
  const png = (w, h, rgb) => {
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
    const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
    const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])))
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
  const body = { height: 1.75, shoulders: 0.42, hips: 0.2, upper_arm: 0.29, forearm: 0.25, thigh: 0.43, shin: 0.41, head_width: 0.22 }
  const person = { name: 'Me', from: 'Wave', body, colors: { skin: [0.8, 0.6, 0.5], hair: [0.2, 0.1, 0.05], shirt: [0.1, 0.5, 0.2], pants: [0.1, 0.1, 0.4], shoes: [0.9, 0.9, 0.9] }, sleeves: 'short', legs: 'shorts', hairStyle: 'short', face: true, motion: saved.id }
  const meId = (await library.createPerson(person, png(8, 8, [200, 150, 120]))).id
  ok(fs.existsSync(join(library.dir(), meId, 'face.png')) && /photo\("Face photo", asset_file\("face.png"\)\)/.test(library.readScript(meId)), 'character saved with your face photo and an editable script')
  const me = await library.build(meId, { blenderPath: exe, runner })
  ok(me.ok && me.stats.humanoid, `your character builds on a person-shaped skeleton${me.ok ? '' : ': ' + me.error}`)
  ok(me.ok && ['Skin', 'Hair', 'Shirt', 'Pants', 'Shoes', 'Face photo'].every((m) => me.stats.materials.includes(m)), `outfit colors and the face photo are materials (${me.stats?.materials})`)
  ok(me.ok && (me.stats.clips || []).some((c) => c.name === 'Wave'), 'the motion you recorded comes with it')
  const meBytes = library.files(meId)['model.glb']
  const meJson = JSON.parse(meBytes.subarray(20, 20 + meBytes.readUInt32LE(12)).toString('utf8')) // the .glb's JSON chunk
  ok(meJson.images?.length === 1 && meJson.images[0].bufferView !== undefined, 'the face photo is packed inside the .glb')
  const plain = await library.createPerson({ ...person, name: 'Plain', face: false, hairStyle: 'none', sleeves: 'long', legs: 'long', motion: '' }, null)
  const pb = await library.build(plain.id, { blenderPath: exe, runner })
  ok(pb.ok && Math.abs(pb.stats.size_m.height - 1.75) < 0.08 && pb.stats.min_z > -0.02, `it's as tall as you (${pb.stats?.size_m?.height} m, feet at ${pb.stats?.min_z})`)
  ok(pb.ok && !pb.stats.materials.includes('Face photo') && !pb.stats.clips?.length, 'without a face photo or motion it still builds')

  await library.removeMotion(saved.id)
  ok(library.listMotions().length === 0, 'motion removed')
}

// ---- detailed models: smooth(), Poly Haven textures, terrain() ----
{
  const { createRequire } = await import('node:module')
  const { startMockPolyHaven } = createRequire(import.meta.url)('./mock-polyhaven.cjs')
  const ph = await startMockPolyHaven()
  const savedApi = process.env.GAMESMITH_POLYHAVEN_API
  process.env.GAMESMITH_POLYHAVEN_API = ph.base
  assets.configure({ cache: join(tmp, 'asset-cache') })

  ok(
    assets.texturesInScript('assign(r, texture("rock_wall_10", tile=1))\n# texture("in_a_comment")\nt = terrain(style="hills", ground="rock_wall_10", rock=None, snow="snow_02")').sort().join() ===
      ['coast_sand_01', 'rock_wall_10', 'snow_02'].join(),
    'texture ids found in a script (terrain defaults included, None and comments skipped)'
  )
  const code = `bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5, location=(0, 0, 0.5))
r = bpy.context.object
r.name = "Boulder"
before = len(r.data.polygons)
smooth(r, level=3, noise=0.08, seed=4, max_tris=3000)
assign(r, texture("rock_wall_10", tile=1.0))
assert len(r.data.uv_layers) == 1, "textured objects get UVs"
bpy.ops.mesh.primitive_cube_add(size=0.4, location=(1.5, 0, 0.2))
assign(smooth(bpy.context.object, level=2, bevel=0.05), texture("no_such_texture_xyz"))
t = terrain(size=40, height=6, style="mountains", detail=48, ground="rock_wall_10", rock=None, water=1.0)
t.location.x = 30
bpy.ops.mesh.primitive_cube_add(size=1)
marker = bpy.context.object
marker.name = "Marker"
marker.location = (30, 0, ground(t, 30, 0) + 0.5)
assert abs(marker.location.z - 0.5 - ground(t, 30, 0)) < 1e-6 and ground(t, 30, 0) >= 0
`
  const rock = await library.create('Detail test', '')
  library.writeScript(rock.id, code)
  const rb = await library.build(rock.id, {
    blenderPath: exe,
    runner,
    commitMessage: false,
    texturesDir: assets.texturesDir(),
    beforeRun: (script) => assets.ensureTextures(assets.texturesInScript(script))
  })
  ok(rb.ok, `smooth, textures and terrain build${rb.ok ? '' : ': ' + rb.error + ' ' + (rb.where || '')}`)
  ok(rb.ok && fs.existsSync(join(assets.texturesDir(), 'rock_wall_10', 'color.jpg')) && fs.existsSync(join(assets.texturesDir(), 'rock_wall_10', 'normal.jpg')), 'texture maps downloaded once into the cache')
  ok(rb.ok && rb.stats.missingTextures?.some((m) => m.id === 'no_such_texture_xyz') && rb.stats.fallback_textures?.includes('no_such_texture_xyz'), 'an unknown texture falls back to a plain color and is reported')
  ok(rb.ok && /couldn't be downloaded/.test(formatBuild(rb)), 'the modeling AI is told about it')
  ok(rb.ok && rb.stats.triangles > 6000 && rb.stats.triangles < 3000 + 2500 + 48 * 48 * 2 + 20, `smoothing adds detail but respects max_tris (${rb.stats?.triangles} triangles in all)`)
  ok(rb.ok && rb.stats.materials.includes('rock_wall_10 4m') && rb.stats.materials.includes('Water'), `terrain textured, with water (${rb.stats?.materials})`)
  const glb = library.files(rock.id)['model.glb']
  const gj = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
  const rm = gj.materials.find((m) => m.name === 'rock_wall_10 1m')
  ok(rm?.pbrMetallicRoughness?.baseColorTexture && rm.normalTexture && rm.pbrMetallicRoughness.metallicRoughnessTexture, 'color, normal and roughness maps are in the .glb')
  ok(gj.images.every((i) => i.mimeType === 'image/jpeg'), 'textures packed as JPEG to keep models small')
  ok(gj.materials.find((m) => m.name === 'Water')?.alphaMode === 'BLEND', 'water is see-through')
  const again = (await assets.ensureTextures(['rock_wall_10'])).length === 0 && ph.state.requests.filter((r) => r.url.includes('/files/rock_wall_10')).length === 1
  ok(again, 'already downloaded textures are not fetched again')

  const styles = ['hills', 'mountains', 'islands', 'valley', 'plains', 'dunes']
  const land = await library.create('Lands', '')
  library.writeScript(land.id, styles.map((st, k) => `t${k} = terrain(size=20, height=5, style="${st}", detail=24, seed=${k + 1}, ground="rock_wall_10", rock=None)\nt${k}.location.x = ${k * 25}`).join('\n') + '\n')
  const lb = await library.build(land.id, { blenderPath: exe, runner, commitMessage: false, texturesDir: assets.texturesDir() })
  ok(lb.ok && lb.stats.objects === 6 && lb.stats.size_m.height === 5 && lb.stats.min_z === 0, `every terrain style builds 5 m tall from z = 0${lb.ok ? '' : ': ' + lb.error}`)

  process.env.GAMESMITH_POLYHAVEN_API = savedApi
  ph.server.close()
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
