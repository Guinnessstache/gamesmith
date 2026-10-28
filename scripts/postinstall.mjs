// Runs after `npm install`.
// 1. Electron 45+ no longer downloads its binary during install, but
//    electron-vite needs it to exist up front ("Error: Electron uninstall").
// 2. Copy the game engines into resources/vendor.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules', 'electron')

function electronReady() {
  const pathFile = join(electronDir, 'path.txt')
  if (!existsSync(pathFile)) return false
  return existsSync(join(electronDir, 'dist', readFileSync(pathFile, 'utf8').trim()))
}

if (existsSync(join(electronDir, 'install.js')) && !electronReady()) {
  console.log('[postinstall] downloading the Electron runtime…')
  const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit', cwd: electronDir })
  if (r.status !== 0 || !electronReady()) {
    console.error('[postinstall] Electron download failed. Run: node node_modules/electron/install.js')
    process.exit(1)
  }
}

const v = spawnSync(process.execPath, [join(root, 'scripts', 'vendor.mjs')], { stdio: 'inherit' })
process.exit(v.status ?? 0)
