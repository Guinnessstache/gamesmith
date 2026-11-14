// The realistic people pack: the installer (against a local server), and, when a real pack is
// available, real human() builds through Blender.
//   node scripts/test-humans.mjs
// Real builds run when GAMESMITH_HUMANS_DIR points at an installed pack (the folder Gamesmith keeps
// under its data folder, e.g. %APPDATA%\Gamesmith\humans) and Blender (or scripts/fake-blender.py) is found.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import * as humans from '../src/main/humans.js'
import * as blender from '../src/main/blender.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`)
  if (!c) failed++
}

// ---------- which scripts need the pack ----------
ok(humans.usedBy('rig = human(body="female")'), 'a script calling human() needs the pack')
ok(humans.usedBy('people = [human (name="A"), character()]'), 'human() inside a list is found')
ok(!humans.usedBy('rig = character()\n# human() would be nicer'), 'a comment mentioning human() does not count')
ok(!humans.usedBy('def superhuman(x): pass\nsuperhuman(1)\nrig.human(2)'), 'other names ending in human do not count')

// ---------- installer ----------
const big = crypto.randomBytes(300000) // doesn't compress: stored across several network chunks
const mpfbZip = zipSync({
  'mpfb2-abc/README.md': strToU8('not part of the add-on'),
  'mpfb2-abc/src/mpfb/__init__.py': strToU8('# add-on'),
  'mpfb2-abc/src/mpfb/data/rigs/standard/rig.game_engine.json': strToU8('{}'),
  'mpfb2-abc/test/test.py': strToU8('x')
})
const assetsZip = zipSync({
  'skins/young_caucasian_male/young_caucasian_male.mhmat': strToU8('name skin'),
  'hair/short02/short02.mhclo': strToU8('name hair'),
  'hair/short02/short02_diffuse.png': big,
  '../evil.txt': strToU8('zip slip'),
  'clothes/': new Uint8Array(0)
})
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const hits = []
const server = http.createServer((req, res) => {
  hits.push(req.url)
  if (req.url === '/mpfb.zip') return res.end(Buffer.from(mpfbZip))
  if (req.url === '/assets.zip') return res.end(Buffer.from(assetsZip))
  if (req.url === '/damaged.zip') return res.end(Buffer.from(assetsZip.slice(0, assetsZip.length - 7)))
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const sources = (assetUrls, assetSha = sha(assetsZip)) => ({
  mpfb: { ...humans.SOURCES.mpfb, version: 'test-1', urls: [`${base}/mpfb.zip`], approxMB: 1 },
  assets: { ...humans.SOURCES.assets, version: assetSha, sha256: assetSha, urls: assetUrls.map((u) => base + u), approxMB: 1 }
})

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'gs-humans-'))
humans.configure(join(tmp, 'humans'))
const ext = humans.extensionsDir()
ok(!humans.status().installed, 'nothing installed at first')

let err = await humans.ensure({ sources: sources(['/missing.zip', '/damaged.zip']) }).catch((e) => e)
ok(err instanceof Error && /Couldn't download skins, hair and clothes/.test(err.message) && /HTTP 404/.test(err.message) && /checksum/.test(err.message), 'a missing file and a damaged file are both reported')
ok(!fs.existsSync(ext) && !fs.existsSync(join(tmp, 'humans', 'extensions.new')), 'a failed download leaves nothing half-installed')

const events = []
const good = sources(['/missing.zip', '/assets.zip'])
const [a, b] = await Promise.all([humans.ensure({ sources: good, onProgress: (e) => events.push(e) }), humans.ensure({ sources: good })])
ok(a.installed && b.installed && hits.filter((h) => h === '/mpfb.zip').length === 2, 'two builds asking at once share one download')
ok(hits.includes('/missing.zip') && hits.includes('/assets.zip'), 'the second mirror is used when the first fails')
ok(fs.readFileSync(join(ext, 'user_default', 'mpfb', '__init__.py'), 'utf8') === '# add-on', 'the add-on lands in the private extensions folder')
ok(!fs.existsSync(join(ext, 'user_default', 'mpfb', 'README.md')) && !fs.existsSync(join(ext, 'user_default', 'test')), 'the rest of the repository is left out')
const data = join(ext, '.user', 'user_default', 'mpfb', 'data')
ok(fs.existsSync(join(data, 'skins', 'young_caucasian_male', 'young_caucasian_male.mhmat')), 'skins land where the add-on looks for them')
ok(fs.readFileSync(join(data, 'hair', 'short02', 'short02_diffuse.png')).equals(big), 'a large file unpacks byte for byte')
ok(!fs.existsSync(join(ext, '.user', 'user_default', 'mpfb', 'evil.txt')) && !fs.existsSync(join(tmp, 'evil.txt')), 'paths that try to escape the folder are skipped')
ok(events.some((e) => e.phase === 'Downloading' && e.unit === 'MB') && events.some((e) => e.phase === 'Unpacking'), 'progress is reported while downloading and unpacking')
ok(/first time only/.test(humans.progressText({ phase: 'Downloading', done: 3, total: 328 })), 'the chat line says the download is a one-off')
ok(humans.status(good).installed, 'the pack reads as installed')
const before = hits.length
await humans.ensure({ sources: good })
ok(hits.length === before, 'an installed pack is not downloaded again')
ok(!humans.status().installed, 'a pack from an older version of the sources counts as not installed')
server.close()

// ---------- real builds ----------
const realDir = process.env.GAMESMITH_HUMANS_DIR
const found = blender.find(tmp)
if (!realDir || !fs.existsSync(join(realDir, 'extensions', 'user_default', 'mpfb')) || !found.found) {
  console.log('skip real human() builds (set GAMESMITH_HUMANS_DIR to an installed pack, with Blender available)')
} else {
  const runner = join(root, 'resources', 'blender', 'runner.py')
  const build = async (code, name) => {
    const script = join(tmp, `${name}.py`)
    fs.writeFileSync(script, code)
    return blender.run({ blender: found.path, runner, script, outGlb: join(tmp, `${name}.glb`), outPng: '-', outViews: join(tmp, `${name}-views.png`) })
  }
  blender.setExtensionsDir(join(tmp, 'no-such-folder'))
  let r = await build('rig = human()', 'missing')
  ok(!r.ok && /realistic people pack/.test(r.error) && /character\(\)/.test(r.error), 'without the pack, the error points to character()')

  blender.setExtensionsDir(join(realDir, 'extensions'))
  r = await build('rig = human(name="Sam")\nprint(sorted(rig.parts))', 'plain')
  ok(r.ok, `human() builds${r.ok ? '' : ': ' + r.error}`)
  if (r.ok) {
    ok(r.stats.humanoid === true, 'it stands on the standard skeleton')
    ok(r.stats.triangles > 15000 && r.stats.triangles < 60000, `a sensible triangle count (${r.stats.triangles})`)
    ok(r.stats.size_m.height > 1.5 && r.stats.size_m.height < 2.0 && Math.abs(r.stats.min_z) < 0.03, `a natural height, standing on the ground (${r.stats.size_m.height} m)`)
    ok(r.stats.size_m.width < 0.75, `arms are down at rest (${r.stats.size_m.width} m wide)`)
    ok(['Sam body', 'Sam hair', 'Sam outfit', 'Sam shoes', 'Sam eyes'].every((m) => r.stats.materials.includes(m)), 'parts and materials carry the character name')
    const glb = fs.readFileSync(join(tmp, 'plain.glb'))
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
    ok(json.materials.find((m) => m.name === 'Sam body')?.alphaMode === undefined, 'skin is solid (it hides the eyes and teeth behind it)')
    ok(json.materials.find((m) => m.name === 'Sam hair')?.alphaMode === 'MASK', 'hair is cut out, not blended')
    ok(json.images.every((i) => i.mimeType === 'image/webp'), 'textures keep their cut-outs (WebP, not JPEG)')
    const names = json.nodes.map((n) => n.name)
    ok(['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'UpperArm.L', 'LowerArm.R', 'Hand.R', 'UpperLeg.L', 'LowerLeg.R', 'Foot.L', 'Index1.R'].every((b) => names.includes(b)), 'bones use the standard names')
    ok(glb.length < 8e6, `the model stays small (${(glb.length / 1e6).toFixed(1)} MB)`)
  }

  r = await build(
    `rig = human(body="female", age="old", build="heavy", ethnicity="asian", height=1.6, hair="bob01", hair_color=(0.8, 0.8, 0.8), eyes="green", outfit="suit", hat="fedora01", name="Mae")
head, tail = rig.joints["Hand.R"]
bpy.ops.mesh.primitive_cube_add(size=0.1, location=tail)
rig.attach(bpy.context.object, "Hand.R")
with rig.clip("Wave", seconds=1.0):
    rig.pose("UpperArm.R", at=0.5, rotate=(0, -90, 0))
    rig.pose("Index1.R", at=0.5, rotate=(20, 0, 0))`,
    'options'
  )
  ok(r.ok, `options, gear and a clip build${r.ok ? '' : ': ' + r.error}`)
  if (r.ok) {
    ok(Math.abs(r.stats.size_m.height - 1.6) < 0.12, `height follows the request (${r.stats.size_m.height} m)`)
    ok(r.stats.clips?.[0]?.name === 'Wave', 'clips work on a human')
    ok(r.stats.materials.includes('Mae hat'), 'the hat is added')
    ok(fs.existsSync(join(tmp, 'options-views.png')), 'the review sheet renders')
  }

  r = await build('rig = human(hair="mohawk")', 'badhair')
  ok(!r.ok && /no hair style "mohawk"/.test(r.error) && /short02/.test(r.error), 'an unknown hair style lists the real ones')
  r = await build('rig = human(age="ancient")', 'badage')
  ok(!r.ok && /age must be one of/.test(r.error), 'an unknown age lists the choices')

  // A recorded motion (MediaPipe landmarks): standing, right arm raised.
  const LM = { nose: 0, ear_l: 7, ear_r: 8, sh_l: 11, sh_r: 12, el_l: 13, el_r: 14, wr_l: 15, wr_r: 16, idx_l: 19, idx_r: 20, hip_l: 23, hip_r: 24, kn_l: 25, kn_r: 26, an_l: 27, an_r: 28, heel_l: 29, heel_r: 30, toe_l: 31, toe_r: 32 }
  const pose = {
    nose: [0, -0.1, 1.65], ear_l: [0.08, 0, 1.65], ear_r: [-0.08, 0, 1.65], sh_l: [0.2, 0, 1.45], sh_r: [-0.2, 0, 1.45],
    el_l: [0.22, 0, 1.15], wr_l: [0.22, 0, 0.9], idx_l: [0.22, 0, 0.8], el_r: [-0.45, 0, 1.5], wr_r: [-0.5, 0, 1.8], idx_r: [-0.5, 0, 1.9],
    hip_l: [0.1, 0, 0.95], hip_r: [-0.1, 0, 0.95], kn_l: [0.1, 0, 0.5], kn_r: [-0.1, 0, 0.5], an_l: [0.1, 0, 0.08], an_r: [-0.1, 0, 0.08],
    heel_l: [0.1, 0.05, 0.03], heel_r: [-0.1, 0.05, 0.03], toe_l: [0.1, -0.15, 0.03], toe_r: [-0.1, -0.15, 0.03]
  }
  const frame = Array.from({ length: 33 }, () => [0, 0, 0, 0])
  for (const [k, [x, y, z]] of Object.entries(pose)) frame[LM[k]] = [x, -z, y, 1] // Blender (x, y, z) -> MediaPipe (x right, y down, z away)
  const motions = join(tmp, 'motions')
  fs.mkdirSync(join(motions, 'raise'), { recursive: true })
  fs.writeFileSync(join(motions, 'raise', 'motion.json'), JSON.stringify({ name: 'Raise', fps: 30, loop: false, legLength: 0.87, frames: Array.from({ length: 10 }, () => ({ w: frame, lift: 0 })) }))
  const script = join(tmp, 'motion.py')
  fs.writeFileSync(
    script,
    `rig = human()
rig.apply_motion("Raise")
import bpy
arm = rig.obj
arm.animation_data.action = bpy.data.actions["Raise"]
bpy.context.scene.frame_set(5)
bpy.context.view_layer.update()
hand = (arm.matrix_world @ arm.pose.bones["Hand.R"].head).z
other = (arm.matrix_world @ arm.pose.bones["Hand.L"].head).z
head = (arm.matrix_world @ arm.pose.bones["Head"].head).z
arm.animation_data.action = None
if not (hand > head and other < head - 0.4):
    raise RuntimeError(f"raised hand at {hand:.2f}, other hand at {other:.2f}, head at {head:.2f}")`
  )
  r = await blender.run({ blender: found.path, runner, script, outGlb: join(tmp, 'motion.glb'), outPng: '-', motionsDir: motions })
  ok(r.ok && r.stats.clips?.length === 1, `a recorded motion plays on a human, raised hand above the head${r.ok ? '' : ': ' + r.error}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nAll realistic people checks passed')
process.exit(failed ? 1 : 0)
