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
fs.writeFileSync(join(tmp, 'joints.py'), 'rig = Rig.humanoid(height=1.7)\nhx, hy, hz = rig.joints["Hips"]\n')
const jb = await blender.run({ blender: exe, runner, script: join(tmp, 'joints.py'), outGlb: join(tmp, 'joints.glb'), outPng: '-' })
ok(!jb.ok && /Hint: rig\.joints\["Bone"\] is a pair of points \(head, tail\)/.test(jb.error), 'unpacking rig.joints as x, y, z gets a hint with the fix')

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
    const parsed = JSON.parse(body)
    if (parsed.stream === false && JSON.stringify(parsed.messages).includes('image_url')) {
      // "can you see images?" check: this mock model can't
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: 'I cannot see images.' } }] }))
    }
    requests.push(parsed)
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
ok(requests[0].messages[0].content.includes('Treasure Chest') && requests[0].tools.length === 7 && ['find_textures', 'find_parts', 'add_kit'].every((n) => requests[0].tools.some((t) => t.function.name === n)), 'modeling AI gets the asset brief and 7 tools (including texture and kit part search, and adding kits)')
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
{
  // deleting a model deletes its chat: a new model with the same name starts fresh
  const old = await library.create('Chat check', '')
  library.saveChat(old.id, [{ role: 'user', content: 'old request' }])
  await library.remove(old.id)
  const again = await library.create('Chat check', '')
  ok(again.id === old.id && library.loadChat(again.id).length === 0, 'a new model never inherits a deleted model\'s chat')
  await library.remove(again.id)
}

ok(!requests.some((r) => JSON.stringify(r.messages).includes('image_url')) && !fs.existsSync(join(tmp, 'Gamesmith Library', 'treasure-chest', 'views.png')), 'a model that cannot see images gets no renders')

// A model that can see: it's shown four views after each build, and the reference images
{
  const seeSteps = [
    { tool: { name: 'write_script', args: { content: 'bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))\nassign(bpy.context.object, mat("Red", (0.8, 0.1, 0.1)))\n' } } },
    { tool: { name: 'build_model', args: {} } },
    { tool: { name: 'edit_script', args: { old_text: 'size=1,', new_text: 'size=0.8,' } } },
    { tool: { name: 'build_model', args: {} } },
    { tool: { name: 'build_model', args: {} } },
    { tool: { name: 'build_model', args: {} } },
    { text: 'A red block.' }
  ]
  let n = 0
  const seen = []
  let probes = 0
  const srv2 = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.stream === false) {
        probes++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ message: { content: 'Red.' } }] }))
      }
      seen.push(parsed)
      const step = seeSteps[n++] || { text: 'Done.' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (step.tool) {
        chunk({ tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ content: step.text })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  const blk = await library.create('Red block', '')
  // a reference picture (a tiny PNG is enough here)
  const refPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
  library.addReference(blk.id, refPng, 'image/png')
  ok(library.listReferences(blk.id).length === 1 && fs.readFileSync(join(library.dir(), '.gitignore'), 'utf8').includes('*/references/'), 'reference image saved (kept out of the GitHub backup)')
  const seeEvents = []
  const sr = await runModelAgent({
    id: blk.id,
    ai: { baseUrl: `http://127.0.0.1:${srv2.address().port}/v1`, model: 'mock-vision', maxSteps: 12, autoFixRounds: 1 },
    userText: 'A red block',
    emit: (e) => seeEvents.push(e),
    build: (opts) => library.build(blk.id, { blenderPath: exe, runner, commitMessage: false, ...opts })
  })
  srv2.close()
  const images = (r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image_url') : []))
  ok(probes === 1 && sr.build?.ok, 'checked once whether the model can see')
  ok(images(seen[0]).length === 1 && /Reference image/.test(JSON.stringify(seen[0].messages.at(-1))), 'the reference image goes with the request')
  ok(/SEE your work/.test(seen[0].messages[0].content), 'the instructions tell it that it will see its renders')
  const afterBuild = seen[2].messages.at(-1)
  ok(Array.isArray(afterBuild.content) && afterBuild.content[1].image_url.url.startsWith('data:image/png;base64,') && /four|front/.test(afterBuild.content[0].text), 'after a build it is shown the four views')
  ok(!seen.some((r) => r.messages.some((m) => 'gsRender' in m)), 'no Gamesmith-only fields are sent to the model server')
  ok(images(seen[4]).length === 2 && /earlier render/.test(JSON.stringify(seen[4].messages)), 'only the newest render is kept (plus the reference)')
  const looks = seeEvents.filter((e) => e.type === 'tool_end' && e.name === 'look_at_render').length
  ok(looks === 3 && images(seen[6]).length === 2 && /last look/.test(JSON.stringify(seen[6].messages)), `at most 3 looks per request (${looks})`)
  const png = fs.readFileSync(join(library.dir(), blk.id, 'views.png'))
  ok(png.readUInt32BE(16) === 640 && png.readUInt32BE(20) === 640, 'the four views are one 640 x 640 picture')
}

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

// ---- stylized characters: character() ----
{
  const code = `rig = character(build="hero", hair="short", beard="stubble", shirt=(0.88, 0.84, 0.74), vest=(0.45, 0.3, 0.18),
                pants=(0.28, 0.38, 0.6), boots=True, shoes=(0.4, 0.24, 0.12), belt=(0.3, 0.18, 0.1), hat="cowboy", name="Cowboy")
assert rig.is_humanoid and set(rig.parts) >= {"body", "head", "eyes", "hair", "beard", "hat", "buckle"}
body = rig.parts["body"]
assert body.modifiers[0].type == "ARMATURE" and len(body.vertex_groups) >= 15, "the body bends with the skeleton"
assert {p.material_index for p in body.data.polygons} == set(range(len(body.data.materials))), "every clothing color is used"
with rig.clip("Wave", seconds=1.0):
    rig.pose("UpperArm.R", at=0.0, rotate=(0, 0, 0))
    rig.pose("UpperArm.R", at=0.5, rotate=(0, -150, 0))
    rig.pose("UpperArm.R", at=1.0, rotate=(0, 0, 0))
kid = character(build="kid", height=1.3, body="female", hair="ponytail", sleeves="short", legs="shorts", hat="cap", name="Kid")
# a part resized and attached right away keeps its size (it used to snap back to a 1 m cube)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.2, 1.0))
plate = bpy.context.object
plate.name = "ChestPlate"
plate.scale = (0.34, 0.2, 0.2)
rig.attach(plate, "Chest")
bpy.context.view_layer.update()
assert abs(plate.dimensions.x - 0.34) < 0.01 and abs(plate.matrix_world.to_scale().x - 0.34) < 0.01, plate.matrix_world.to_scale()
kid.obj.location.x = 1.2
`
  const ch = await library.create('Cowboy', '')
  library.writeScript(ch.id, code)
  const cb = await library.build(ch.id, { blenderPath: exe, runner, commitMessage: false })
  ok(cb.ok, `stylized characters build${cb.ok ? '' : ': ' + cb.error + ' ' + (cb.where || '')}`)
  ok(cb.ok && cb.stats.humanoid && cb.stats.min_z > -0.01 && cb.stats.size_m.height > 1.75 && cb.stats.size_m.height < 2.0, `standing on the ground, about 1.8 m plus the hat (${cb.stats?.size_m?.height} m)`)
  ok(cb.ok && cb.stats.triangles > 15000 && cb.stats.triangles < 70000, `smooth but game-sized (${cb.stats?.triangles} triangles for two characters)`)
  ok(cb.ok && ['Cowboy Shirt', 'Cowboy Vest', 'Cowboy Boots', 'Cowboy Hat', 'Kid Shirt'].every((m) => cb.stats.materials.includes(m)), 'each character gets its own clothing colors')
  const glb = library.files(ch.id)['model.glb']
  const gj = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
  ok(gj.skins?.length >= 2 && gj.skins[0].joints.length === 17 && gj.meshes.some((m) => m.primitives.some((p) => p.attributes.JOINTS_0 && p.attributes.WEIGHTS_0)), 'the .glb carries the skeleton and skin weights')
  ok(cb.ok && cb.stats.clips?.some((c) => c.name === 'Wave'), 'clips play on it')
}

// ---- kits: model packs imported for the modeling AI ----
{
  const kitsMod = await import('../src/main/kits.js')
  const { zipSync } = await import('fflate')
  const kitRoot = join(tmp, 'kits')
  kitsMod.configure(() => kitRoot)
  kitsMod.setRunnerPath(runner)
  // two models for the pack: a crate, and a rigged swinging sign with an animation
  const mk = async (code) => {
    const f = join(tmp, `kitsrc-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(f)
    fs.writeFileSync(join(f, 'm.py'), code)
    const r = await blender.run({ blender: exe, runner, script: join(f, 'm.py'), outGlb: join(f, 'm.glb'), outPng: '-' })
    assert.ok(r.ok, r.error)
    return fs.readFileSync(join(f, 'm.glb'))
  }
  const crate = await mk('bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))\nassign(bpy.context.object, mat("Wood", (0.5, 0.3, 0.1)))\n')
  const sign = await mk(`rig = Rig(name="Sign")
rig.bone("Post", (0, 0, 0), (0, 0, 1.5))
rig.bone("Board", (0, 0, 1.5), (0, 0, 1.0), parent="Post")
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.25))
b = bpy.context.object
b.scale = (0.6, 0.05, 0.4)
rig.attach(b, "Board")
bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=1.5, location=(0, 0.1, 0.75))
rig.attach(bpy.context.object, "Post")
with rig.clip("Swing", seconds=1.0):
    rig.pose("Board", at=0.0, rotate=(0, 0, 0))
    rig.pose("Board", at=0.5, rotate=(20, 0, 0))
    rig.pose("Board", at=1.0, rotate=(0, 0, 0))
`)
  const zipPath = join(tmp, 'kenney_test-kit.zip')
  fs.writeFileSync(
    zipPath,
    zipSync({
      'Test Kit/License.txt': new TextEncoder().encode('Test Kit by Kenney\nLicense: (Creative Commons Zero, CC0)\n'),
      'Test Kit/Models/GLB format/crate-small.glb': crate,
      'Test Kit/Models/GLB format/sign-swinging.glb': sign,
      'Test Kit/Models/FBX format/crate-small.fbx': new TextEncoder().encode('not really an fbx: should be skipped, GLB is preferred'),
      'Test Kit/Previews/crate-small.png': new Uint8Array([1, 2, 3])
    })
  )
  const steps = []
  const kit = await kitsMod.importKit(zipPath, { blenderPath: exe, onProgress: (p) => steps.push(p) })
  ok(kit.parts.length === 2 && kit.format === '.glb' && !kit.failed.length, `pack imported: GLB chosen over FBX, ${kit.parts.length} parts`)
  ok(kit.source === 'Kenney' && kit.license === 'CC0' && kit.id === 'test-kit', `source and license recognized (${kit.source}, ${kit.license}, id ${kit.id})`)
  const signPart = kit.parts.find((p) => p.name === 'sign-swinging')
  ok(signPart?.rigged && signPart.animations.includes('Swing') && Math.abs(kit.parts.find((p) => p.name === 'crate-small').size[2] - 1) < 0.01, 'parts measured; the rigged one lists its animation')
  ok(fs.existsSync(join(kitRoot, 'test-kit', 'thumbs', 'crate-small.png')) && !fs.existsSync(join(kitRoot, 'test-kit', 'source')), 'thumbnails made, unpacked source cleaned up')
  ok(steps.some((p) => p.phase === 'Converting' && p.done === 2 && p.total === 2), 'progress reported while converting')
  ok(kitsMod.findParts('crates')[0]?.part === 'crate-small' && /test-kit\/crate-small: 1 x 1 x 1 m/.test(kitsMod.formatPart(kitsMod.findParts('crate')[0])), 'parts found by name (plural too)')

  const uses = await library.create('Kit test', '')
  library.writeScript(uses.id, `for i in range(3):
    part("test-kit/crate-small", location=(i * 1.2, 0, 0), rotation=(0, 0, i * 15))
s = part("sign-swinging", location=(0, 2, 0), scale=0.5)
assert s.type == "ARMATURE"
try:
    part("test-kit/no-such-thing")
    raise SystemExit("expected an error")
except ValueError as e:
    assert "find_parts" in str(e)
`)
  const kb = await library.build(uses.id, { blenderPath: exe, runner, commitMessage: false, kitsDir: kitRoot })
  ok(kb.ok, `a model built from kit parts${kb.ok ? '' : ': ' + kb.error + ' ' + (kb.where || '')}`)
  ok(kb.ok && kb.stats.objects === 5 && kb.stats.clips?.some((c) => c.name === 'Swing') && Math.abs(kb.stats.size_m.width - 3.583) < 0.02, `parts placed and the animation kept (${kb.stats?.objects} objects, ${kb.stats?.size_m?.width} m wide, clips ${JSON.stringify(kb.stats?.clips)})`)
  ok(fs.readFileSync(join(library.dir(), '.gitignore'), 'utf8').includes('kits/'), 'kits stay out of the GitHub backup')
  kitsMod.removeKit('test-kit')
  ok(kitsMod.listKits().length === 0, 'kit removed')
  await library.remove(uses.id)

  // ---- the built-in catalog: one click downloads a pack (no manual downloads) ----
  const real = JSON.parse(fs.readFileSync(join(root, 'resources', 'kits', 'catalog.json'), 'utf8'))
  ok(
    real.packs.length >= 30 &&
      /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(real.base) &&
      real.packs.every((p) => p.license === 'CC0' && p.files.length && p.files.every((f) => /\.glb$/i.test(f.f) && /^[0-9a-f]{40}$/.test(f.sha))) &&
      new Set(real.packs.map((p) => p.id)).size === real.packs.length,
    `built-in catalog: ${real.packs.length} CC0 packs, ${real.packs.reduce((n, p) => n + p.files.length, 0)} models, pinned to one commit, every file hashed`
  )
  const crypto = await import('node:crypto')
  const sha = (b) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
  const served = { 'Crate Small.glb': crate, 'Sign_Swinging.glb': sign }
  const hits = {}
  let damage = false
  const files = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop())
    hits[name] = (hits[name] || 0) + 1
    if (name === 'Crate Small.glb' && hits[name] === 1) return res.writeHead(503).end() // a hiccup: retried
    if (!served[name]) return res.writeHead(404).end()
    res.writeHead(200).end(damage ? Buffer.from('garbage') : served[name])
  })
  await new Promise((r) => files.listen(0, '127.0.0.1', r))
  const catFile = join(tmp, 'catalog.json')
  fs.writeFileSync(
    catFile,
    JSON.stringify({
      base: 'https://example.invalid/',
      credit: 'Test models, CC0.',
      packs: [
        { id: 'props', name: 'Test Props', about: 'Crates and signs', source: 'Quaternius', url: 'https://quaternius.com', license: 'CC0', dir: 'props_pack', files: Object.entries(served).map(([f, b]) => ({ f, sha: sha(b) })) },
        { id: 'trees', name: 'Test Trees', about: 'Trees and rocks', source: 'Quaternius', url: '', license: 'CC0', dir: 'trees', files: [{ f: 'Tree.glb', sha: '0'.repeat(40) }] }
      ]
    })
  )
  kitsMod.setCatalogPath(catFile)
  process.env.GAMESMITH_KIT_BASE = `http://127.0.0.1:${files.address().port}/`
  ok(kitsMod.catalog().packs.every((p) => !p.installed) && kitsMod.catalog().packs[0].sample.includes('Crate Small'), 'catalog lists the packs, none installed yet')
  ok(kitsMod.suggestPacks('wooden crate')[0]?.id === 'props' && !kitsMod.suggestPacks('spaceship').length, 'the AI is pointed at packs that have what it looked for')

  const failing = await kitsMod.installKit('trees', { blenderPath: exe }).then(() => null, (e) => e)
  ok(/Couldn't download Test Trees/.test(failing?.message) && !fs.existsSync(join(kitRoot, 'trees')), 'a failed download says so and leaves nothing behind')
  damage = true
  const damaged = await kitsMod.installKit('props', { blenderPath: exe }).then(() => null, (e) => e)
  ok(/damaged/.test(damaged?.message) && !fs.existsSync(join(kitRoot, 'props')), 'a damaged download is caught by its hash')
  damage = false
  const ac = new AbortController()
  ac.abort()
  const cancelled = await kitsMod.installKit('props', { blenderPath: exe, signal: ac.signal }).then(() => null, (e) => e)
  ok(cancelled?.message === 'Cancelled' && !fs.existsSync(join(kitRoot, 'props')), 'adding a kit can be cancelled')

  // the modeling AI looks for parts, finds none, adds the kit itself and uses it
  const agentSteps = [
    { tool: { name: 'find_parts', args: { query: 'crate' } } },
    { tool: { name: 'add_kit', args: { kit: 'props' } } },
    { tool: { name: 'find_parts', args: { query: 'crate' } } },
    { tool: { name: 'write_script', args: { content: 'part("props/crate-small", location=(0, 0, 0))\npart("props/crate-small", location=(1.1, 0, 0))\n' } } },
    { tool: { name: 'build_model', args: {} } },
    { text: 'Two crates from the Test Props kit.' }
  ]
  let at = 0
  const seen = []
  const ai = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.stream === false) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'no' } }] }))
      seen.push(parsed)
      const step = agentSteps[at++] || { text: 'Done.' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (step.tool) {
        chunk({ tool_calls: [{ index: 0, id: `c${at}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ content: step.text })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((r) => ai.listen(0, '127.0.0.1', r))
  const crates = await library.create('Crates', '')
  const statuses = []
  const ar = await runModelAgent({
    id: crates.id,
    ai: { baseUrl: `http://127.0.0.1:${ai.address().port}/v1`, model: 'mock', maxSteps: 12, autoFixRounds: 2, vision: 'off' },
    userText: 'Two crates',
    emit: (e) => e.type === 'status' && statuses.push(e.text),
    build: () => library.build(crates.id, { blenderPath: exe, runner, commitMessage: false, kitsDir: kitRoot }),
    findParts: (q) => kitsMod.findParts(q),
    addKit: (id, status) => kitsMod.installKit(id, { blenderPath: exe, onProgress: (ev) => status(`${ev.phase}: ${ev.done} of ${ev.total}`) })
  })
  ai.close()
  files.close()
  const toolText = (i) => seen[i].messages.at(-1).content
  ok(seen[0].messages[0].content.includes('props: Test Props') && /add_kit/.test(toolText(1)) && /props: Test Props/.test(toolText(1)), 'with nothing installed, find_parts points the AI at the matching free kit')
  ok(/Installed Test Props as kit "props" \(2 parts\)/.test(toolText(2)) && statuses.some((t) => /Downloading: 2 of 2/.test(t)), 'the AI added the kit itself, with progress shown')
  ok(/props\/crate-small/.test(toolText(3)) && ar.build?.ok && ar.build.stats.objects === 2, `then found and used its parts (${ar.build?.stats?.objects} objects)`)
  const k2 = kitsMod.readKit('props')
  ok(k2.catalogId === 'props' && k2.source === 'Quaternius' && k2.license === 'CC0' && kitsMod.catalog().packs[0].installed === 'props' && hits['Crate Small.glb'] >= 2, 'installed kit is marked in the catalog (and the flaky download was retried)')
  const again = await kitsMod.installKit('props', { blenderPath: exe })
  ok(again.id === 'props' && kitsMod.listKits().length === 1, 'adding an installed kit again does nothing')
  kitsMod.removeKit('props')
  await library.remove(crates.id)
  delete process.env.GAMESMITH_KIT_BASE
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
