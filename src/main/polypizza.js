// Poly Pizza (poly.pizza): 10,000+ free low-poly models, CC0 or CC-BY.
// Needs a free API key (poly.pizza/settings/api), sent as X-Auth-Token.
//
// The official API docs weren't reachable when this was written, so the
// response parsing below accepts a few spellings of each field rather than
// trusting one exact shape.

const API = () => process.env.GAMESMITH_POLYPIZZA_API || 'https://api.poly.pizza/v1'
const UA = 'Gamesmith/0.3 (+https://github.com/Guinnessstache)'

let keyStore = { get: () => ({}), set: async () => {} }
export function configureKeyStore(secretStore) {
  keyStore = secretStore
}
export function getKey() {
  return keyStore.get().key || null
}
export function hasKey() {
  return !!getKey()
}
async function saveKey(key) {
  await keyStore.set(key ? { key: key.trim() } : {})
}

async function api(path, key = getKey()) {
  if (!key) throw new Error('Add your free Poly Pizza API key first (poly.pizza/settings/api).')
  let res
  try {
    res = await fetch(API() + path, { headers: { 'X-Auth-Token': key, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  } catch (e) {
    throw new Error(`Couldn't reach Poly Pizza (${e.cause?.code || e.message}).`)
  }
  if (res.status === 401 || res.status === 403) throw new Error('Poly Pizza rejected the API key. Check it at poly.pizza/settings/api.')
  if (res.status === 429) throw new Error('Poly Pizza is rate-limiting requests. Wait a moment and try again.')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Poly Pizza: ${res.status} ${res.statusText}`)
  return res.json()
}

/** Check a key works, then save it. */
export async function setKey(key) {
  if (!key) return saveKey('')
  await api('/popular?limit=1', key.trim())
  await saveKey(key)
}

const pick = (o, ...names) => {
  for (const n of names) if (o?.[n] != null && o[n] !== '') return o[n]
  return undefined
}

function licenseLabel(raw) {
  const s = String(raw || '').trim()
  if (/cc0|public domain|cc-?zero/i.test(s)) return 'CC0'
  if (/\bby\b|attribution/i.test(s)) {
    const ver = s.match(/\d\.\d/)
    return `CC-BY${/\bsa\b|sharealike|share-alike/i.test(s) ? '-SA' : ''}${ver ? ` ${ver[0]}` : ''}`
  }
  return s || 'Unknown'
}

export function normalize(m) {
  const id = String(pick(m, 'ID', 'Id', 'id', 'PublicID') || '')
  const creator = pick(m, 'Creator', 'creator', 'Author', 'author') || {}
  const username = typeof creator === 'string' ? creator : pick(creator, 'Username', 'username', 'Name', 'name') || ''
  const license = licenseLabel(pick(m, 'Licence', 'License', 'licence', 'license'))
  return {
    id: `pp-${id}`,
    sourceId: id,
    source: 'polypizza',
    name: pick(m, 'Title', 'title', 'Name', 'name') || id,
    type: 'models',
    description: pick(m, 'Description', 'description') || '',
    category: pick(m, 'Category', 'category') || 'Low poly',
    tags: pick(m, 'Tags', 'tags') || [],
    authors: username ? [username] : [],
    creatorUrl: typeof creator === 'object' ? pick(creator, 'PURL', 'Url', 'url', 'Profile') || null : null,
    license,
    attributionRequired: license !== 'CC0',
    thumb: pick(m, 'Thumbnail', 'thumbnail', 'ThumbnailUrl', 'Preview') || '',
    download: pick(m, 'Download', 'download', 'DownloadUrl', 'Glb', 'GLB') || null,
    tris: pick(m, 'TriangleCount', 'Tris', 'triangleCount') || null,
    animated: !!pick(m, 'Animated', 'animated'),
    downloads: 0
  }
}

const seen = new Map() // id -> normalized record from recent searches

function results(json) {
  const list = Array.isArray(json) ? json : pick(json, 'results', 'Results', 'models', 'data') || []
  return list.map(normalize).filter((m) => m.sourceId && m.download).map((m) => (seen.set(m.id, m), m))
}

/** Search (or the popular list when the query is empty). */
export async function search(query, limit = 48) {
  const q = String(query || '').trim().slice(0, 100)
  const n = Math.min(limit, 50)
  const json = q ? await api(`/search/${encodeURIComponent(q)}?limit=${n}`) : await api(`/popular?limit=${n}`)
  return json ? results(json) : []
}

export async function get(id) {
  if (seen.has(id)) return seen.get(id)
  const json = await api(`/model/${encodeURIComponent(id.replace(/^pp-/, ''))}`)
  if (!json) throw new Error(`Poly Pizza model ${id} not found`)
  const [m] = results([json])
  if (!m) throw new Error(`Poly Pizza model ${id} has no .glb download`)
  return m
}

/** Size of the .glb without downloading it (null if the CDN won't say). */
export async function size(m) {
  try {
    const res = await fetch(m.download, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
    const n = Number(res.headers.get('content-length'))
    return n > 0 ? n : null
  } catch {
    return null
  }
}
