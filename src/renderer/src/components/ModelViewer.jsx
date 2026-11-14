import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * Spin-around view of a .glb (bytes from the main process), with a 1 m grid so
 * the size reads at a glance. Falls back to the rendered preview image when the
 * computer can't start WebGL.
 */
export default function ModelViewer({ glb, fallback, wireframe = false, clip = null, clipLoops = true, replay = 0 }) {
  const host = useRef(null)
  const ctx = useRef(null)
  const [noGl, setNoGl] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [loadedTick, setLoadedTick] = useState(0)

  // Set up the scene once.
  useEffect(() => {
    const el = host.current
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setNoGl(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#161c27')
    // Soft studio reflections, so metal parts look like metal instead of black.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.8
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500)
    camera.position.set(2.2, 1.6, 2.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.5, 0)

    // Studio lighting: a warm key light that casts the shadow, a cool fill from the
    // other side, and a rim light from behind that outlines the shape.
    scene.add(new THREE.HemisphereLight('#dfe9ff', '#3a3226', 0.7))
    const sun = new THREE.DirectionalLight('#fff4e6', 2.6)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.radius = 5
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    scene.add(sun, sun.target)
    const fill = new THREE.DirectionalLight('#bcd2ff', 0.7)
    const rim = new THREE.DirectionalLight('#ffffff', 1.8)
    scene.add(fill, fill.target, rim, rim.target)
    // An invisible floor that only shows the model's shadow, so it stands on something.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.45 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    floor.visible = false
    scene.add(floor)
    // A faint pool of light on the ground under the model, so the shadow has something to show against.
    const glowCanvas = document.createElement('canvas')
    glowCanvas.width = glowCanvas.height = 256
    const g2 = glowCanvas.getContext('2d')
    const grad = g2.createRadialGradient(128, 128, 0, 128, 128, 128)
    grad.addColorStop(0, 'rgba(120, 140, 180, 0.38)')
    grad.addColorStop(1, 'rgba(120, 140, 180, 0)')
    g2.fillStyle = grad
    g2.fillRect(0, 0, 256, 256)
    const glowTex = new THREE.CanvasTexture(glowCanvas)
    glowTex.colorSpace = THREE.SRGBColorSpace
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, toneMapped: false }))
    glow.rotation.x = -Math.PI / 2
    glow.renderOrder = -1
    floor.add(glow)
    glow.rotation.x = 0
    glow.position.z = -0.001
    glow.scale.setScalar(0.5)
    // Aim the lights at the model and fit the shadow to its size.
    const lightModel = (center, radius, floorY) => {
      const place = (light, x, y, z) => {
        light.target.position.copy(center)
        light.position.set(center.x + x * radius, center.y + y * radius, center.z + z * radius)
      }
      place(sun, 0.9, 3.2, 1.5)
      place(fill, -2.4, 0.9, 1.2)
      place(rim, -1.2, 1.8, -2.6)
      const cam = sun.shadow.camera
      cam.left = cam.bottom = -radius * 1.6
      cam.right = cam.top = radius * 1.6
      cam.near = radius * 0.1
      cam.far = radius * 8
      cam.updateProjectionMatrix()
      floor.scale.setScalar(radius * 12)
      floor.position.set(center.x, floorY - 0.001, center.z)
      floor.visible = true
    }
    lightModel(new THREE.Vector3(0, 0.5, 0), 1, 0)
    floor.visible = false
    const grid = new THREE.GridHelper(10, 10, '#4b5870', '#2a3548') // 1 m squares
    scene.add(grid)

    const resize = () => {
      const w = el.clientWidth || 1
      const h = el.clientHeight || 1
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    let raf
    const clock = new THREE.Clock()
    const loop = () => {
      const dt = Math.min(clock.getDelta(), 0.1)
      ctx.current?.mixer?.update(dt)
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    loop()
    ctx.current = { scene, camera, controls, lightModel, floor, model: null, mixer: null, clips: [] }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      floor.geometry.dispose()
      floor.material.dispose()
      glow.geometry.dispose()
      glow.material.dispose()
      glowTex.dispose()
      scene.environment?.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      ctx.current = null
    }
  }, [])

  // Swap in the model whenever new bytes arrive.
  useEffect(() => {
    const c = ctx.current
    if (!c) return
    window.__gsViewerScene = c.scene
    if (c.model) {
      c.scene.remove(c.model)
      c.model.traverse((o) => {
        o.geometry?.dispose()
        ;[].concat(o.material || []).forEach((m) => m.dispose())
      })
      c.model = null
      c.floor.visible = false
      c.mixer?.stopAllAction()
      c.mixer = null
      c.clips = []
    }
    setLoadErr('')
    // Loading takes a moment. If a newer build arrives meanwhile, this one is dropped when it finishes,
    // or old builds would pile up in the scene.
    c.loadToken = (c.loadToken || 0) + 1
    const token = c.loadToken
    if (!glb) return
    const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb)
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    new GLTFLoader().parse(
      buf,
      '',
      (gltf) => {
        if (!ctx.current || ctx.current.loadToken !== token) {
          gltf.scene.traverse((o) => {
            o.geometry?.dispose()
            ;[].concat(o.material || []).forEach((m) => m.dispose())
          })
          return
        }
        const model = gltf.scene
        model.userData.gsModel = true // (tests count these: there must only ever be one)
        model.traverse((o) => {
          if (o.isMesh) o.castShadow = o.receiveShadow = true
        })
        ctx.current.scene.add(model)
        ctx.current.model = model
        ctx.current.clips = gltf.animations
        ctx.current.mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : null
        setLoadedTick((n) => n + 1)
        // Frame it, keeping the camera direction.
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const radius = Math.max(size.length() / 2, 0.1)
        ctx.current.lightModel(center, radius, box.min.y)
        const dir = c.camera.position.clone().sub(c.controls.target).normalize()
        // Fit both ways: a tall, narrow view needs the horizontal angle.
        const vHalf = THREE.MathUtils.degToRad(c.camera.fov / 2)
        const hHalf = Math.atan(Math.tan(vHalf) * c.camera.aspect)
        const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1
        c.controls.target.copy(center)
        c.camera.position.copy(center).addScaledVector(dir, dist)
        c.camera.near = dist / 100
        c.camera.far = dist * 100
        c.camera.updateProjectionMatrix()
      },
      (e) => {
        if (ctx.current?.loadToken === token) setLoadErr(e?.message || String(e))
      }
    )
  }, [glb])

  // Play the chosen clip (or show the rest pose).
  useEffect(() => {
    const c = ctx.current
    if (!c?.mixer) return
    c.mixer.stopAllAction()
    const found = clip && THREE.AnimationClip.findByName(c.clips, clip)
    if (!found) return
    const action = c.mixer.clipAction(found)
    action.reset()
    if (clipLoops) action.setLoop(THREE.LoopRepeat, Infinity)
    else {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    }
    action.play()
  }, [clip, clipLoops, loadedTick, replay])

  useEffect(() => {
    ctx.current?.model?.traverse((o) => {
      ;[].concat(o.material || []).forEach((m) => (m.wireframe = wireframe))
    })
  }, [wireframe, glb])

  if (noGl) {
    return (
      <div className="viewer fallback">
        {fallback ? <img src={fallback} alt="Rendered preview" /> : <span className="muted">3D view isn't available on this computer (WebGL couldn't start).</span>}
      </div>
    )
  }
  return (
    <div className="viewer" ref={host}>
      {loadErr && <div className="viewer-msg notice error">Couldn't show the model: {loadErr}</div>}
    </div>
  )
}
