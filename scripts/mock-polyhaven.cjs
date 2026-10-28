// Mock of the Poly Haven API + CDN, shaped like real responses (checked
// against api.polyhaven.com/files/barrel_03, rock_wall_10 and an HDRI).
const http = require('node:http')
const zlib = require('node:zlib')

// 1x1 PNG / tiny JPEG-ish bytes are fine: the browser only needs valid images for thumbnails.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function gltfFor(id) {
  // A valid single-triangle glTF that references a .bin and a texture, like Poly Haven's.
  const positions = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => positions.writeFloatLE(v, i * 4))
  return {
    bin: positions,
    gltf: JSON.stringify({
      asset: { version: '2.0', generator: 'mock' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: id }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: `textures/${id}_diff_1k.png` }],
      buffers: [{ uri: `${id}.bin`, byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }]
    })
  }
}

const LIB = {
  models: {
    barrel_03: { name: 'Barrel 03', tags: ['barrel', 'wood', 'container'], category: 'Props/Containers/Barrels', download_count: 9000, authors: { 'Kirill Sannikov': 'All' } },
    wooden_crate_01: { name: 'Wooden Crate 01', tags: ['crate', 'box', 'wood'], category: 'Props/Containers/Crates', download_count: 7000, authors: { 'Jorge Camacho': 'All' } },
    rock_moss_set_01: { name: 'Rock Moss Set 01', tags: ['rock', 'stone', 'moss', 'nature'], category: 'Nature/Rocks', download_count: 6000, authors: { 'Rob Tuytel': 'All' } }
  },
  textures: {
    rock_wall_10: { name: 'Rock Wall 10', tags: ['rock', 'wall', 'stone'], category: 'Rock/Walls', download_count: 5000, authors: { 'Rob Tuytel': 'All' } },
    grass_path_2: { name: 'Grass Path 2', tags: ['grass', 'ground', 'path'], category: 'Ground/Grass', download_count: 8000, authors: { 'Rob Tuytel': 'All' } }
  },
  hdris: {
    kloofendal_48d_partly_cloudy_puresky: { name: 'Kloofendal 48d Partly Cloudy (Pure Sky)', tags: ['sky', 'clouds', 'day'], category: 'Pure Skies', download_count: 20000, authors: { 'Greg Zaal': 'All' } }
  }
}

function startMockPolyHaven() {
  const state = { requests: [] }
  let base
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, ua: req.headers['user-agent'] })
    const url = new URL(req.url, 'http://x')
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/assets') {
      const type = url.searchParams.get('type') || url.searchParams.get('t')
      const out = {}
      for (const [id, a] of Object.entries(LIB[type] || {})) out[id] = { ...a, type: { hdris: 0, textures: 1, models: 2 }[type], thumbnail_url: `${base}/cdn/thumbs/${id}.png` }
      return json(200, out)
    }
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q')
      const type = url.searchParams.get('t')
      const hits = Object.entries(LIB[type] || {}).filter(([id, a]) => (id + a.tags.join(' ')).includes(q.split(' ')[0])).map(([slug]) => ({ slug, score: 0.6 }))
      return json(200, { query: q, type, total: hits.length, results: hits })
    }
    const files = url.pathname.match(/^\/files\/(.+)$/)
    if (files) {
      const id = decodeURIComponent(files[1])
      if (LIB.models[id]) {
        return json(200, {
          Diffuse: { '1k': { jpg: { url: `${base}/dl/${id}_diff_1k.jpg`, size: 70 } } },
          gltf: {
            '1k': { gltf: { url: `${base}/dl/${id}_1k.gltf`, size: 900, include: {
              [`${id}.bin`]: { url: `${base}/dl/${id}.bin`, size: 36 },
              [`textures/${id}_diff_1k.png`]: { url: `${base}/dl/${id}_diff_1k.png`, size: 70 }
            } } },
            '2k': { gltf: { url: `${base}/dl/${id}_2k.gltf`, size: 900, include: {} } }
          }
        })
      }
      if (LIB.textures[id]) {
        const map = (n) => ({ '1k': { jpg: { url: `${base}/dl/${id}_${n}_1k.jpg`, size: 70 }, png: { url: `${base}/dl/${id}_${n}_1k.png`, size: 70 } } })
        return json(200, { Diffuse: map('diff'), nor_dx: map('nor_dx'), nor_gl: map('nor_gl'), Rough: map('rough'), AO: map('ao'), arm: map('arm'), Displacement: map('disp'), gltf: {}, blend: {}, mtlx: {} })
      }
      if (LIB.hdris[id]) return json(200, { tonemapped: { url: `${base}/dl/${id}.jpg` }, hdri: { '1k': { hdr: { url: `${base}/dl/${id}_1k.hdr`, size: 64 }, exr: { url: `${base}/dl/${id}_1k.exr`, size: 99 } } } })
      return json(404, { error: 'not found' })
    }
    if (url.pathname.startsWith('/info/')) {
      const id = decodeURIComponent(url.pathname.slice(6))
      for (const t of Object.keys(LIB)) if (LIB[t][id]) return json(200, LIB[t][id])
      return json(404, {})
    }
    if (url.pathname.startsWith('/dl/')) {
      const f = url.pathname.slice(4)
      const m = f.match(/^(.+)_1k\.gltf$/)
      if (m) {
        res.writeHead(200, { 'Content-Type': 'model/gltf+json' })
        return res.end(gltfFor(m[1]).gltf)
      }
      if (f.endsWith('.bin')) return res.end(gltfFor('x').bin)
      if (f.endsWith('.hdr')) return res.end(Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\x80\x80\x80\x80'))
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(PNG)
    }
    if (url.pathname.startsWith('/cdn/thumbs/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(PNG)
    }
    json(404, { error: `no mock for ${req.url}` })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve({ server, base, state })
    })
  )
}

// ---- Poly Pizza mock (shape from a third-party description of API v1.1) ----
const PP = [
  { ID: 'CarRed1', Title: 'Red Sports Car', Creator: { Username: 'Quaternius', PURL: 'https://poly.pizza/u/Quaternius' }, Licence: 'CC0 1.0', Tags: ['car', 'vehicle', 'sports'], TriangleCount: 1840, Animated: false },
  { ID: 'BikeBMX2', Title: 'BMX Bike', Creator: { Username: 'Kenney', PURL: 'https://poly.pizza/u/Kenney' }, Licence: 'CC0 1.0', Tags: ['bike', 'bicycle', 'vehicle'], TriangleCount: 960, Animated: false },
  { ID: 'TruckX3', Title: 'Delivery Truck', Creator: { Username: 'Jarlan Perez', PURL: 'https://poly.pizza/u/JarlanPerez' }, Licence: 'Creative Commons Attribution', Tags: ['truck', 'car', 'vehicle'], TriangleCount: 2400, Animated: false },
  { ID: 'KnightA4', Title: 'Knight', Creator: { Username: 'Quaternius', PURL: 'https://poly.pizza/u/Quaternius' }, Licence: 'CC0 1.0', Tags: ['character', 'knight'], TriangleCount: 3100, Animated: true }
]
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(96, 1)])

function startMockPolyPizza(validKey = 'pp_testkey') {
  const state = { requests: [] }
  let base
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push({ url: req.url, key: req.headers['x-auth-token'], method: req.method })
    if (url.pathname.startsWith('/cdn/')) {
      if (url.pathname.endsWith('.glb')) {
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': GLB.length })
        return res.end(req.method === 'HEAD' ? undefined : GLB)
      }
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(PNG)
    }
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers['x-auth-token'] !== validKey) return json(403, { error: 'invalid key' })
    const withUrls = (m) => ({ ...m, Thumbnail: `${base}/cdn/${m.ID}.jpg`, Download: `${base}/cdn/${m.ID}.glb` })
    const limit = Number(url.searchParams.get('limit') || 12)
    if (url.pathname === '/v1/popular') return json(200, { cursor: null, results: PP.slice(0, limit).map(withUrls) })
    const s = url.pathname.match(/^\/v1\/search\/(.+)$/)
    if (s) {
      const q = decodeURIComponent(s[1]).toLowerCase()
      return json(200, { cursor: null, results: PP.filter((m) => (m.Title + m.Tags.join(' ')).toLowerCase().includes(q)).slice(0, limit).map(withUrls) })
    }
    const m = url.pathname.match(/^\/v1\/model\/(.+)$/)
    if (m) {
      const hit = PP.find((x) => x.ID === m[1])
      return hit ? json(200, withUrls(hit)) : json(404, {})
    }
    json(404, { error: 'no mock' })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve({ server, base, api: `${base}/v1`, state })
    })
  )
}

module.exports = { startMockPolyHaven, startMockPolyPizza }
