import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * Spin-around view of a .glb (bytes from the main process), with a 1 m grid so
 * the size reads at a glance. Falls back to the rendered preview image when the
 * computer can't start WebGL.
 */
export default function ModelViewer({ glb, fallback, wireframe = false }) {
  const host = useRef(null)
  const ctx = useRef(null)
  const [noGl, setNoGl] = useState(false)
  const [loadErr, setLoadErr] = useState('')

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
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#161c27')
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500)
    camera.position.set(2.2, 1.6, 2.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.5, 0)

    scene.add(new THREE.HemisphereLight('#dfe9ff', '#3a3226', 1.6))
    const sun = new THREE.DirectionalLight('#ffffff', 2.4)
    sun.position.set(3, 5, 2)
    scene.add(sun)
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
    const loop = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    loop()
    ctx.current = { scene, camera, controls, model: null }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      ctx.current = null
    }
  }, [])

  // Swap in the model whenever new bytes arrive.
  useEffect(() => {
    const c = ctx.current
    if (!c) return
    if (c.model) {
      c.scene.remove(c.model)
      c.model.traverse((o) => {
        o.geometry?.dispose()
        ;[].concat(o.material || []).forEach((m) => m.dispose())
      })
      c.model = null
    }
    setLoadErr('')
    if (!glb) return
    const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb)
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    new GLTFLoader().parse(
      buf,
      '',
      (gltf) => {
        if (!ctx.current) return
        const model = gltf.scene
        ctx.current.scene.add(model)
        ctx.current.model = model
        // Frame it, keeping the camera direction.
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const radius = Math.max(size.length() / 2, 0.1)
        const dir = c.camera.position.clone().sub(c.controls.target).normalize()
        const dist = radius / Math.sin(THREE.MathUtils.degToRad(c.camera.fov / 2)) * 1.15
        c.controls.target.copy(center)
        c.camera.position.copy(center).addScaledVector(dir, dist)
        c.camera.near = dist / 100
        c.camera.far = dist * 100
        c.camera.updateProjectionMatrix()
      },
      (e) => setLoadErr(e?.message || String(e))
    )
  }, [glb])

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
