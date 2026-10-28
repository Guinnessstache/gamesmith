// Copies the game engine libraries out of node_modules into resources/vendor.
// New game projects get their own copy, so games run offline and deploy as
// plain static files: no npm, no bundler, nothing for the user to install.
import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'vendor')

function pkgDir(name) {
  return join(root, 'node_modules', name)
}
const version = (name) => JSON.parse(readFileSync(join(pkgDir(name), 'package.json'), 'utf8')).version

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
}

if (!existsSync(join(root, 'node_modules', 'phaser'))) {
  console.log('[vendor] phaser/three not installed yet, skipping')
  process.exit(0)
}

const phaser = pkgDir('phaser')
const three = pkgDir('three')

copy(join(phaser, 'dist', 'phaser.min.js'), join(out, 'phaser', 'phaser.min.js'))
copy(join(phaser, 'LICENSE.md'), join(out, 'phaser', 'LICENSE.md'))

copy(join(three, 'build', 'three.module.js'), join(out, 'three', 'three.module.js'))
copy(join(three, 'build', 'three.core.js'), join(out, 'three', 'three.core.js'))
copy(join(three, 'LICENSE'), join(out, 'three', 'LICENSE'))
for (const f of [
  'controls/OrbitControls.js',
  'controls/PointerLockControls.js',
  'loaders/GLTFLoader.js',
  'loaders/HDRLoader.js',
  'utils/BufferGeometryUtils.js',
  'utils/SkeletonUtils.js'
]) {
  copy(join(three, 'examples', 'jsm', f), join(out, 'three', 'addons', f))
}

const versions = {
  phaser: version('phaser'),
  three: version('three')
}
writeFileSync(join(out, 'versions.json'), JSON.stringify(versions, null, 2))
console.log('[vendor] copied', versions)
