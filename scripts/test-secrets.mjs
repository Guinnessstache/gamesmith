// Secret store: async encryption, migration from the old sync format, key rotation.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows needs file:// URLs for dynamic import of absolute paths.
const fileHref = (...parts) => pathToFileURL(join(...parts)).href
const { createSecretStore } = await import(fileHref(root, 'src/main/secretStore.js'))
const tmp = mkdtempSync(join(tmpdir(), 'gs-secrets-'))
const enc = (t) => 'enc:' + Buffer.from('K1:' + t).toString('base64')
let rotate = false
const crypto = {
  available: async () => true,
  encrypt: async (t) => Buffer.from('K1:' + t),
  decrypt: async (b) => {
    const s = b.toString()
    if (!s.startsWith('K1:')) throw new Error('bad key')
    return { result: s.slice(3), shouldReEncrypt: rotate }
  }
}
try {
  const file = join(tmp, 'github.json')

  // 1. File written by the old synchronous API ("enc:" + base64) is still readable.
  writeFileSync(file, JSON.stringify({ token: enc('ghp_old'), account: { login: 'jt' } }))
  let st = createSecretStore({ file, fields: ['token'], ...crypto })
  await st.load()
  assert.equal(st.get().token, 'ghp_old', 'reads legacy encrypted value')
  assert.equal(st.get().account.login, 'jt')

  // 2. set() encrypts secret fields only.
  await st.set({ token: 'ghp_new', account: { login: 'jt' } })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.token, enc('ghp_new'))
  assert.deepEqual(raw.account, { login: 'jt' })

  // 3. Plaintext saved while encryption was unavailable gets encrypted once it is.
  writeFileSync(file, JSON.stringify({ token: 'plain-token' }))
  st = createSecretStore({ file, fields: ['token'], ...crypto })
  await st.load()
  assert.equal(st.get().token, 'plain-token')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, enc('plain-token'), 'plaintext upgraded to encrypted')

  // 4. Key rotation: shouldReEncrypt triggers a rewrite.
  rotate = true
  writeFileSync(file, JSON.stringify({ token: enc('t1'), extra: 1 }))
  const before = readFileSync(file, 'utf8')
  st = createSecretStore({ file, fields: ['token'], ...crypto })
  await st.load()
  assert.notEqual(readFileSync(file, 'utf8'), before, 'rewritten after rotation')
  rotate = false

  // 5. Unreadable value (e.g. copied from another PC) = signed out, no crash.
  writeFileSync(file, JSON.stringify({ token: 'enc:' + Buffer.from('OTHER:zzz').toString('base64') }))
  st = createSecretStore({ file, fields: ['token'], ...crypto })
  await st.load()
  assert.equal(st.get().token, undefined)

  // 6. No encryption available (some Linux setups): stored as plaintext, still works.
  const f2 = join(tmp, 'render.json')
  st = createSecretStore({ file: f2, fields: ['key'] })
  await st.load()
  await st.set({ key: 'rnd_1' })
  assert.equal(JSON.parse(readFileSync(f2, 'utf8')).key, 'rnd_1')

  // 7. Missing file = empty store.
  st = createSecretStore({ file: join(tmp, 'nope.json'), fields: ['key'], ...crypto })
  await st.load()
  assert.deepEqual(st.get(), {})

  console.log('PASS  secrets: legacy format readable, secret-only encryption, plaintext upgrade, key rotation, unreadable = signed out, no-encryption fallback')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
