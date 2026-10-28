// Small JSON file whose secret fields are encrypted at rest.
//
// Encryption is async (Electron's safeStorage.encryptStringAsync /
// decryptStringAsync), so secrets are decrypted once at startup with load()
// and then read synchronously from memory with get(). set() encrypts and
// writes. Values written by the older synchronous API (prefix "enc:") are
// still readable.
//
// Kept free of Electron imports so it can be tested in plain Node: the
// encrypt/decrypt functions are passed in.
import fs from 'node:fs'
import { dirname } from 'node:path'

const PREFIX = 'enc:'

/**
 * @param {object} o
 * @param {string} o.file              JSON file path
 * @param {string[]} o.fields          which top-level fields are secret
 * @param {() => Promise<boolean>} [o.available]   is encryption available
 * @param {(s: string) => Promise<Buffer>} [o.encrypt]
 * @param {(b: Buffer) => Promise<{ result: string, shouldReEncrypt?: boolean }>} [o.decrypt]
 */
export function createSecretStore({ file, fields, available = async () => false, encrypt, decrypt }) {
  let data = {}
  let canEncrypt = false

  async function seal(value) {
    if (!canEncrypt || typeof value !== 'string' || !value) return value
    return PREFIX + (await encrypt(value)).toString('base64')
  }

  async function write() {
    const out = {}
    for (const [k, v] of Object.entries(data)) out[k] = fields.includes(k) ? await seal(v) : v
    fs.mkdirSync(dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(out, null, 2))
  }

  return {
    async load() {
      try {
        canEncrypt = !!(await available())
      } catch {
        canEncrypt = false
      }
      let raw = {}
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        data = {}
        return
      }
      let rewrite = false
      data = { ...raw }
      for (const k of fields) {
        const v = raw[k]
        if (typeof v !== 'string' || !v.startsWith(PREFIX)) {
          if (typeof v === 'string' && v && canEncrypt) rewrite = true // plaintext from before encryption was available
          continue
        }
        try {
          const r = await decrypt(Buffer.from(v.slice(PREFIX.length), 'base64'))
          data[k] = r.result
          if (r.shouldReEncrypt) rewrite = true
        } catch {
          delete data[k] // unreadable (e.g. copied from another machine): treat as signed out
        }
      }
      if (rewrite) await write()
    },
    get() {
      return data
    },
    async set(next) {
      data = { ...next }
      await write()
    }
  }
}
