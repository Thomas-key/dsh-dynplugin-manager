// dsh-dynplugin-manager — minimal loader-channel support (loader-channel branch).
//
// Community npm plugins (shape: package.json with main/exports, code that uses
// real `import` statements) CANNOT be loaded through the runner channel — the
// dynamicCordisRunner vm sandbox forbids module loading. They belong to the
// loader channel: the package must be installed in the profile's node_modules
// and mounted via an insert row in cordis.patch.yml.
//
// This module implements ONLY the insert-row writer + profile detection. The
// live application needs no HMR code of our own: the official patch watcher
// (dsh-app-boot watchUserPatches) watches cordis.patch.yml and re-applies the
// patch stack via hmr.registerConfig — verified empirically (2026-08-14) that
// writing an insert row mounts the plugin WITHOUT a restart.
//
// YAML traps handled here (same ones web-plugin-manager's patch.ts handles):
//   - a bare `[]` empty-array document line must be dropped before appending
//     any row, or the file becomes a two-document YAML and fails to start;
//   - package names starting with `@` must be single-quoted (`@` is a YAML
//     reserved indicator);
//   - after removing the last managed block, a comments-only file parses as
//     null and HMR reload fails — restore the official `[]` template.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const MANAGED_START = '# dsh-dynplugin-manager:managed:start'
export const MANAGED_END = '# dsh-dynplugin-manager:managed:end'

const EMPTY_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
].join('\n') + '\n'

/** DSH home dir, honoring DSH_HOME like dsh-app-boot does. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** The profile this bundle is running under, from process.argv. */
export function currentProfile() {
  const argv = process.argv || []
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--profile') return argv[i + 1]
  }
  // `dsh web` is the alias of `dsh --profile web`.
  if (argv.some((a) => a === 'web')) return 'web'
  return process.env.DSH_PROFILE || 'web'
}

export function profileDir(profile) {
  return join(dshHome(), 'profiles', profile)
}

export function patchPath(profile) {
  return join(profileDir(profile), 'cordis.patch.yml')
}

/** Entry ids must be safe so they cannot break the YAML block structure. */
export function assertSafeEntryId(id) {
  if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.length > 120) {
    throw new Error(`unsafe entry id: ${JSON.stringify(id)}`)
  }
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Read the patch file, or null when absent/unreadable. */
function readPatch(profile) {
  try {
    return readFileSync(patchPath(profile), 'utf8')
  } catch {
    return null
  }
}

/** Whether the patch already contains a managed block for rowId. */
function hasManagedBlock(content, rowId) {
  if (content === null) return false
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimEnd() !== MANAGED_START) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].trimEnd()
      if (line === MANAGED_END) break
      const m = /^-\s*insert:/.test(line) ? null : /id:\s*(.+?)\s*$/.exec(line)
      if (m !== null && m[1] === rowId) return true
    }
  }
  return false
}

/**
 * Write (or refresh) the managed insert block for one package into the
 * profile's cordis.patch.yml. Atomic write (tmp + rename). Returns the new
 * file content, or null when the block already existed unchanged.
 */
export function writeInsertRow(profile, rowId, pkgName) {
  assertSafeEntryId(rowId)
  if (typeof pkgName !== 'string' || pkgName.length === 0 || pkgName.length > 200) {
    throw new Error(`unsafe package name: ${JSON.stringify(pkgName)}`)
  }
  const current = readPatch(profile)
  if (hasManagedBlock(current ?? '', rowId)) return null // already mounted

  // Strip every managed block targeting rowId, then append the fresh one.
  const kept = (current ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '[]' && line.trim() !== '')
  const out = []
  let i = 0
  while (i < kept.length) {
    const line = kept[i]
    if (line.trimEnd() === MANAGED_START) {
      let j = i + 1
      while (j < kept.length && kept[j].trimEnd() !== MANAGED_END) j += 1
      if (j >= kept.length) { out.push(line); i += 1; continue } // unterminated: keep
      const blockLines = kept.slice(i + 1, j)
      const hitsRow = blockLines.some((l) => /id:\s*([^\s]+)/.exec(l)?.[1] === rowId)
      if (!hitsRow) out.push(...kept.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  const block = [
    MANAGED_START,
    '- insert:',
    `    - id: ${rowId}`,
    `      name: ${yamlQuote(pkgName)}`,
    MANAGED_END,
  ]
  const next = [...out, ...block].join('\n') + '\n'

  const target = patchPath(profile)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, target)
  return next
}

/** Remove the managed insert block for rowId. Returns true when removed. */
export function removeInsertRow(profile, rowId) {
  const current = readPatch(profile)
  if (current === null) return false
  const lines = current.split('\n')
  const out = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trimEnd() === MANAGED_START) {
      let j = i + 1
      while (j < lines.length && lines[j].trimEnd() !== MANAGED_END) j += 1
      if (j >= lines.length) { out.push(line); i += 1; continue }
      const hitsRow = lines.slice(i + 1, j).some((l) => /id:\s*([^\s]+)/.exec(l)?.[1] === rowId)
      if (hitsRow) { removed = true; i = j + 1; continue }
      out.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  const significant = out.filter((l) => l.trim() !== '[]' && l.trim() !== '')
  const text = significant.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  const hasRow = text.split('\n').some((l) => /^- id:/.test(l) || /^- insert:/.test(l) || /^insert:/.test(l))
  const next = hasRow ? text : EMPTY_TEMPLATE
  if (!removed) return false
  const target = patchPath(profile)
  const tmp = target + '.tmp'
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, target)
  return true
}

/** Whether a package is resolvable from the profile's node_modules (installed). */
export function isInstalled(profile, pkgName) {
  const roots = [join(profileDir(profile), 'node_modules'), join(dshHome(), 'profiles', 'node_modules')]
  for (const root of roots) {
    try {
      if (existsSync(join(root, pkgName))) return true
      if (pkgName.startsWith('@') && pkgName.includes('/')) {
        const [scope, name] = pkgName.split('/')
        if (existsSync(join(root, scope, name))) return true
      }
    } catch { /* keep probing */ }
  }
  return false
}

/**
 * Best-effort detection of whether plugin code needs the loader channel.
 * The runner sandbox evaluates code as the BODY of an async function, so:
 *   - `import` / `require`  → no module system in the sandbox
 *   - `export` (ANY form)   → syntax error inside a function body
 *   - `from 'x'`            → ESM re-export
 * A self-contained (runner-ready) file has none of these tokens and ends in
 * a plain `return { apply }`. `require(` may appear mid-line
 * (`const x = require(...)`), hence no line anchor. Coarse sniff: false
 * positives just route the user to the loader channel, which is harmless.
 */
export function needsLoaderChannel(code) {
  if (typeof code !== 'string') return false
  return /^\s*(import[\s(]|export\b)|^\s*from\s+['"]|require\s*\(/m.test(code)
}
