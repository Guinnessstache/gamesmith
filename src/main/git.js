// Local version history using isomorphic-git (pure JS, no git install needed).
// Every AI run is bracketed by commits, so any change can be rolled back from
// the History panel. GitHub sync builds on this same repo later.
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import git from 'isomorphic-git'

export const AUTHOR = { name: 'Gamesmith', email: 'gamesmith@localhost' }

export async function init(dir) {
  await git.init({ fs, dir, defaultBranch: 'main' })
}

export async function ensureRepo(dir) {
  if (!fs.existsSync(join(dir, '.git'))) {
    await init(dir)
    await commitAll(dir, 'Started tracking history')
  }
}

/** Stage everything (adds, edits, deletes) and commit. Returns the oid or null if nothing changed. */
export async function commitAll(dir, message, author = AUTHOR) {
  // isomorphic-git decides a file is unchanged when its size and whole-second
  // timestamps match the index ("racy git"). A same-size edit made within ~1s
  // of the last commit would be missed, so re-hash any recently touched file.
  let indexTime = 0
  try {
    indexTime = fs.statSync(join(dir, '.git', 'index')).mtimeMs
  } catch {
    /* no index yet */
  }
  if (indexTime) {
    for (const [filepath, , workdir] of await git.statusMatrix({ fs, dir })) {
      if (workdir === 0) continue
      try {
        if (fs.statSync(join(dir, filepath)).mtimeMs >= indexTime - 2000) await git.add({ fs, dir, filepath })
      } catch {
        /* vanished */
      }
    }
  }
  const matrix = await git.statusMatrix({ fs, dir })
  let changed = 0
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue
    if (workdir === 0) {
      if (head === 1 || stage !== 0) await git.remove({ fs, dir, filepath })
    } else {
      await git.add({ fs, dir, filepath })
    }
    changed++
  }
  let hasHead = true
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    hasHead = false
  }
  if (!changed && hasHead) return null
  return git.commit({ fs, dir, message, author: author || AUTHOR })
}

export async function log(dir, depth = 100) {
  try {
    const commits = await git.log({ fs, dir, depth })
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message.trim(),
      time: c.commit.author.timestamp * 1000
    }))
  } catch {
    return []
  }
}

/** Make the working folder match a past commit, then record that as a new commit (history is never lost). */
export async function restore(dir, oid) {
  await commitAll(dir, 'Snapshot before restore')
  const target = new Set(await git.listFiles({ fs, dir, ref: oid }))
  const current = (await git.statusMatrix({ fs, dir })).filter((r) => r[2] !== 0).map((r) => r[0])

  for (const f of current) {
    if (!target.has(f)) fs.rmSync(join(dir, f), { force: true })
  }
  for (const f of target) {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: f })
    fs.mkdirSync(dirname(join(dir, f)), { recursive: true })
    fs.writeFileSync(join(dir, f), Buffer.from(blob))
  }
  const short = oid.slice(0, 7)
  const { commit } = await git.readCommit({ fs, dir, oid })
  return commitAll(dir, `Restored to ${short}: ${commit.message.trim().split('\n')[0]}`)
}

export async function isDirty(dir) {
  const matrix = await git.statusMatrix({ fs, dir })
  return matrix.some(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))
}
