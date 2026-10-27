// Starter 3D game: roll a ball around a floor and collect spinning gems.
// Available imports: 'three' and 'three/addons/...' (see index.html import map).
// Models: put .glb files in /assets and load them with GLTFLoader from
// 'three/addons/loaders/GLTFLoader.js'.
import * as THREE from 'three'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1b2333)
scene.fog = new THREE.Fog(0x1b2333, 30, 70)

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200)

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202030, 1.2))
const sun = new THREE.DirectionalLight(0xffffff, 2)
sun.position.set(10, 20, 8)
sun.castShadow = true
sun.shadow.camera.left = sun.shadow.camera.bottom = -30
sun.shadow.camera.right = sun.shadow.camera.top = 30
scene.add(sun)

const ARENA = 24
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
  new THREE.MeshStandardMaterial({ color: 0x3a4a6b })
)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)
scene.add(new THREE.GridHelper(ARENA * 2, 24, 0x5a6c90, 0x2c3a55))

const player = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 16),
  new THREE.MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.3 })
)
player.position.y = 1
player.castShadow = true
scene.add(player)

const gems = []
const gemGeo = new THREE.OctahedronGeometry(0.6)
const gemMat = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x664400 })
function spawnGem() {
  const gem = new THREE.Mesh(gemGeo, gemMat)
  gem.position.set((Math.random() - 0.5) * ARENA * 1.6, 1, (Math.random() - 0.5) * ARENA * 1.6)
  gem.castShadow = true
  scene.add(gem)
  gems.push(gem)
}
for (let i = 0; i < 8; i++) spawnGem()

const keys = {}
addEventListener('keydown', (e) => (keys[e.code] = true))
addEventListener('keyup', (e) => (keys[e.code] = false))

let score = 0
const hud = document.getElementById('hud')
const velocity = new THREE.Vector3()
const timer = new THREE.Timer()

function tick() {
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.05)

  const input = new THREE.Vector3(
    (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0),
    0,
    (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0)
  )
  if (input.lengthSq() > 0) input.normalize()
  velocity.addScaledVector(input, 30 * dt)
  velocity.multiplyScalar(1 - 2.5 * dt)
  player.position.addScaledVector(velocity, dt)
  player.position.x = THREE.MathUtils.clamp(player.position.x, -ARENA + 1, ARENA - 1)
  player.position.z = THREE.MathUtils.clamp(player.position.z, -ARENA + 1, ARENA - 1)
  player.rotation.x += velocity.z * dt
  player.rotation.z -= velocity.x * dt

  for (let i = gems.length - 1; i >= 0; i--) {
    const gem = gems[i]
    gem.rotation.y += 2 * dt
    if (gem.position.distanceTo(player.position) < 1.6) {
      scene.remove(gem)
      gems.splice(i, 1)
      score += 10
      hud.textContent = `Score: ${score}`
      spawnGem()
    }
  }

  camera.position.lerp(new THREE.Vector3(player.position.x, 14, player.position.z + 16), 0.08)
  camera.lookAt(player.position)
  renderer.render(scene, camera)
}
renderer.setAnimationLoop(tick)

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})
