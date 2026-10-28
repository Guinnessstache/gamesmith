// Asset library tests against a mock Poly Haven (shaped like the real API).
//   npm run test:assets
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows needs file:// URLs for dynamic import of absolute paths.
const fileHref = (...parts) => pathToFileURL(join(...parts)).href
const require = createRequire(import.meta.url)
const { startMockPolyHaven, startMockPolyPizza } = require('./mock-polyhaven.cjs')
const ph = await startMockPolyHaven()
process.env.GAMESMITH_POLYHAVEN_API = ph.base
const ppMock = await startMockPolyPizza()
process.env.GAMESMITH_POLYPIZZA_API = ppMock.api

const assets = await import(fileHref(root, 'src/main/assets.js'))
const { createProject } = await import(fileHref(root, 'src/main/projects.js'))
const tmp = mkdtempSync(join(tmpdir(), 'gs-assets-'))
try {
  assets.configure({ cache: join(tmp, 'cache') })
  const resourcesDir = join(root, 'resources')
  const proj = await createProject({ projectsDir: join(tmp, 'p'), resourcesDir, name: 'Marble', templateId: 'three-3d' })
  const dir = proj.dir

  // listing + search
  const models = await assets.listAssets('models')
  assert.equal(models[0].id, 'barrel_03', 'sorted by downloads')
  assert.ok(ph.state.requests.every((r) => r.ua === assets.USER_AGENT), 'every API request sends the Gamesmith User-Agent')
  assert.deepEqual((await assets.search('crate', 'models')).map((a) => a.id), ['wooden_crate_01'])
  assert.deepEqual((await assets.search('sky', 'hdris')).map((a) => a.id), ['kloofendal_48d_partly_cloudy_puresky'])
  const before = ph.state.requests.length
  await assets.listAssets('models')
  assert.equal(ph.state.requests.length, before, 'listing is cached')

  // model
  const plan = await assets.plan('barrel_03', 'models', '1k')
  assert.equal(plan.entry, 'assets/models/barrel_03/barrel_03.gltf')
  assert.equal(plan.totalBytes, 900 + 36 + 70)
  const barrel = await assets.addPolyHaven(dir, { id: 'barrel_03', type: 'models', resourcesDir })
  for (const f of barrel.files) assert.ok(existsSync(join(dir, f)), `${f} downloaded`)
  const gltf = JSON.parse(readFileSync(join(dir, barrel.entry), 'utf8'))
  assert.ok(existsSync(join(dir, 'assets/models/barrel_03', gltf.buffers[0].uri)), 'gltf .bin resolves relative to the gltf')
  assert.ok(existsSync(join(dir, 'assets/models/barrel_03', gltf.images[0].uri)), 'gltf texture resolves relative to the gltf')

  // texture: picks color/normal(gl)/roughness/ao, skips nor_dx/arm/disp
  const rock = await assets.addPolyHaven(dir, { id: 'rock_wall_10', type: 'textures', resourcesDir })
  assert.deepEqual(Object.keys(rock.maps).sort(), ['ao', 'color', 'normal', 'roughness'])
  assert.match(rock.maps.normal, /_normal\.jpg$/)
  assert.equal(rock.files.length, 4)

  // hdri: copies HDRLoader into older projects that lack it
  rmSync(join(dir, 'lib/three/addons/loaders/HDRLoader.js'), { force: true })
  const sky = await assets.addPolyHaven(dir, { id: 'kloofendal_48d_partly_cloudy_puresky', type: 'hdris', resourcesDir })
  assert.equal(sky.entry, 'assets/skies/kloofendal_48d_partly_cloudy_puresky_1k.hdr')
  assert.ok(existsSync(join(dir, 'lib/three/addons/loaders/HDRLoader.js')), 'HDRLoader added for skies')

  // zip pack: strips the shared top folder, detects CC0, ignores junk and zip-slip
  const zipPath = join(tmp, 'kenney_platformer-pack.zip')
  writeFileSync(
    zipPath,
    zipSync({
      'Platformer Pack/License.txt': strToU8('Creative Commons Zero, CC0 1.0. Kenney.nl'),
      'Platformer Pack/PNG/Players/player_idle.png': new Uint8Array([137, 80, 78, 71]),
      'Platformer Pack/PNG/Players/player_jump.png': new Uint8Array([137, 80, 78, 71]),
      'Platformer Pack/PNG/Tiles/grass.png': new Uint8Array([137, 80, 78, 71]),
      'Platformer Pack/Sounds/jump.ogg': new Uint8Array([79, 103, 103, 83]),
      'Platformer Pack/source.psd': new Uint8Array([1, 2, 3]),
      'Platformer Pack/.DS_Store': new Uint8Array([0]),
      '__MACOSX/Platformer Pack/._grass.png': new Uint8Array([0])
    })
  )
  const pack = assets.importZip(dir, zipPath)
  assert.equal(pack.license, 'CC0')
  assert.equal(pack.source, 'Kenney (kenney.nl)')
  assert.ok(existsSync(join(dir, 'assets/packs/kenney-platformer-pack/PNG/Players/player_idle.png')), 'top folder stripped')
  assert.ok(!pack.files.some((f) => /psd|DS_Store|MACOSX/.test(f)), 'unsupported and junk files skipped')
  const evil = join(tmp, 'evil.zip')
  writeFileSync(evil, zipSync({ '../../escape.png': new Uint8Array([1]), 'ok.png': new Uint8Array([1]) }))
  const ev = assets.importZip(dir, evil)
  assert.ok(!existsSync(join(dir, '..', 'escape.png')) && !existsSync(join(tmp, 'escape.png')), 'zip-slip blocked')
  assert.deepEqual(ev.files, ['assets/packs/evil/ok.png'])
  assets.removeAsset(dir, ev.id)

  // manifest, credits, AI catalog
  const m = assets.readManifest(dir)
  assert.deepEqual(m.assets.map((a) => a.id).sort(), ['barrel_03', 'kloofendal_48d_partly_cloudy_puresky', 'pack-kenney-platformer-pack', 'rock_wall_10'])
  const credits = readFileSync(join(dir, 'assets/CREDITS.md'), 'utf8')
  assert.match(credits, /Barrel 03\*\* by Kirill Sannikov, from \[Poly Haven\]/)
  const cat = assets.catalogForAI(dir, 'three-3d')
  assert.match(cat, /GLTFLoader/)
  assert.match(cat, /HDRLoader/)
  assert.match(cat, /PNG\/Players\/  2 images: player_idle\.png, player_jump\.png/)

  // remove
  assets.removeAsset(dir, 'barrel_03')
  assert.ok(!existsSync(join(dir, 'assets/models/barrel_03')), 'model folder removed')
  assert.ok(!assets.readManifest(dir).assets.some((a) => a.id === 'barrel_03'))

  // ---- Poly Pizza ----
  const pp = assets.polyPizza
  const { createSecretStore } = await import(fileHref(root, 'src/main/secretStore.js'))
  const ppStore = createSecretStore({ file: join(tmp, 'pp.json'), fields: ['key'], available: async () => true, encrypt: async (t) => Buffer.from('e' + t), decrypt: async (b) => ({ result: b.toString().slice(1) }) })
  await ppStore.load()
  pp.configureKeyStore(ppStore)
  await assert.rejects(() => assets.search('car', 'models', 12, 'polypizza'), /API key/)
  await assert.rejects(() => pp.setKey('wrong'), /rejected the API key/)
  assert.equal(pp.hasKey(), false, 'bad key not saved')
  await pp.setKey('pp_testkey')
  assert.equal(JSON.parse(readFileSync(join(tmp, 'pp.json'), 'utf8')).key, 'enc:' + Buffer.from('epp_testkey').toString('base64'), 'key encrypted at rest')
  const cars = await assets.search('car', 'models', 12, 'polypizza')
  assert.deepEqual(cars.map((c) => c.id), ['pp-CarRed1', 'pp-TruckX3'])
  assert.equal(cars[0].license, 'CC0')
  assert.equal(cars[1].license.includes('BY'), true, 'Attribution license recognized as BY')
  assert.equal(cars[1].attributionRequired, true)
  assert.equal((await assets.search('', 'models', 3, 'polypizza')).length, 3, 'empty query shows popular')
  const all = await assets.searchAllModels('car')
  assert.ok(all.some((a) => a.id.startsWith('pp-')), 'AI search includes Poly Pizza when a key is set')
  const p2 = await assets.plan('pp-TruckX3', 'models')
  assert.equal(p2.entry, 'assets/models/delivery-truck-TruckX3/delivery-truck.glb')
  assert.equal(p2.totalBytes, 100, 'size from HEAD request')
  const truck = await assets.addAsset(dir, { id: 'pp-TruckX3', type: 'models' })
  assert.ok(existsSync(join(dir, truck.entry)))
  const credits2 = readFileSync(join(dir, 'assets/CREDITS.md'), 'utf8')
  assert.match(credits2, /Delivery Truck\*\* by \[Jarlan Perez\]\(https:\/\/poly\.pizza\/u\/JarlanPerez\), from \[Poly Pizza\]\(https:\/\/poly\.pizza\/m\/TruckX3\)/)
  assert.match(credits2, /CC-BY assets require this credit/)
  assert.match(assets.catalogForAI(dir, 'three-3d'), /Low-poly model with arbitrary scale/)
  assert.ok(ppMock.state.requests.filter((r) => !r.url.startsWith('/cdn/')).every((r) => r.key), 'API calls send X-Auth-Token')
  // tolerant parsing of other field spellings
  const alt = pp.normalize({ id: 'x1', title: 'Boat', creator: 'Someone', license: 'CC-BY 4.0', download: 'https://x/y.glb', thumbnail: 'https://x/y.jpg', tags: ['boat'] })
  assert.deepEqual([alt.id, alt.name, alt.authors[0], alt.license, alt.download], ['pp-x1', 'Boat', 'Someone', 'CC-BY 4.0', 'https://x/y.glb'])

  console.log(`PASS  assets: Poly Haven list/search/cache, model+texture+sky downloads, zip packs (CC0 detect, junk + zip-slip filtered), credits, AI catalog, remove; Poly Pizza key check, search, CC-BY credits, tolerant parsing`)
} finally {
  ph.server.close()
  ppMock.server.close()
  rmSync(tmp, { recursive: true, force: true })
}
