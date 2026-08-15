// dsh-dynplugin-manager — manage DSH dynamic plugins: scan directories,
// browse, and load via /dynload slash command. Host half.
//
// Scan spec (see README): a plugin is a first-level subdirectory of a
// user-added scan directory that contains package.json with `name`. Entry
// resolution priority: `dsh.dynamic.host` (our field, kept for compat) →
// `main` → `exports["."]` → `index.js` fallback; the resolved file must
// actually exist. Directories declaring `dsh.bundle` are bundle plugins and
// are skipped. Name collisions are disambiguated by prepending parent folder
// names level by level (joined with "/"), up to the drive root.
//
// Two load channels:
//   - runner channel: code is handed to dynamicCordisRunner as text; its vm
//     sandbox forbids module loading, so only self-contained plugins (no
//     import/require) work here — session-scoped.
//   - loader channel: community npm plugins (real imports) are mounted via a
//     managed insert row in the profile's cordis.patch.yml; the official
//     patch watcher applies it live (no restart, no HMR code) — persistent.
// Unified command: /dynload <name> auto-routes by channel; /dynunmount
// removes a loader mount.
//
// Scan-directory list persistence: a small JSON file under the DSH home
// (~/.dsh/dynplugin-manager.json), written atomically (tmp + rename) through
// a serialized write queue. Deliberately NOT the settings service — direct
// file storage keeps the read-modify-write flow simple and avoids the
// deep-freeze snapshot constraints of settings scopes.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, rmSync, cpSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { dshHome, currentProfile, writeInsertRow, removeInsertRow, hasManagedRow, isInstalled, resolvesFrom, needsLoaderChannel, extractImports } from './loader.js'

export const name = 'dynplugin-manager'

/** Hard dependencies: the runner must exist before this plugin activates. */
export const inject = ['dynamicCordisRunner', 'commands', 'webServer']

// ── scan-directory + failure store: JSON file, atomic writes, serialized ──
function storePath() {
  return join(homedir(), '.dsh', 'dynplugin-manager.json')
}

function loadStore() {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      dirs: Array.isArray(parsed.dirs)
        ? parsed.dirs.map((d) => ({
          path: String(d.path || '').trim(),
          alias: String(d.alias || '').trim(),
          order: Number(d.order) || 0,
        })).filter((d) => d.path)
        : [],
      failures: (parsed.failures !== null && typeof parsed.failures === 'object' && !Array.isArray(parsed.failures))
        ? parsed.failures
        : {},
    }
  } catch { /* absent or unreadable → empty state */ }
  return { dirs: [], failures: {} }
}

/** Read the current dirs; callers must treat the result as immutable. */
function readDirs() {
  return loadStore().dirs
}

/** Read persisted mount failures: { displayName: { message, at } }. */
function readFailures() {
  return loadStore().failures
}

let writeQueue = Promise.resolve()

/** Persist the whole store. Serialized; atomic via tmp file + rename. */
function writeStore(store) {
  const payload = {
    dirs: store.dirs.map((d) => ({ path: d.path, alias: d.alias || '', order: d.order })),
    failures: store.failures,
  }
  writeQueue = writeQueue.then(async () => {
    const target = storePath()
    const tmp = target + '.tmp'
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, target)
  })
  return writeQueue
}

/** Persist a full dirs array (keeps failures intact). */
function writeDirs(dirs) {
  return writeStore({ dirs, failures: readFailures() })
}

/** Persist the failure map (keeps dirs intact). */
function writeFailures(failures) {
  return writeStore({ dirs: readDirs(), failures })
}

/** Record one mount failure for a display name (keeps others). */
async function recordFailure(name, message) {
  const failures = { ...readFailures() }
  failures[name] = { message: String(message).slice(0, 600), at: Date.now() }
  await writeFailures(failures)
}

/** Clear the persisted failure for a display name, if any. */
async function clearFailure(name) {
  const failures = readFailures()
  if (!(name in failures)) return
  delete failures[name]
  await writeFailures(failures)
}

// ── scan: one level deep, package.json required ─────────────────────────
function readPackageJson(dir) {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Absolute path of a plugin's code-body file, or null. */
function codeBodyFile(pluginDir, pkg, half) {
  if (half !== 'host') return null // loader channel is host-only for now
  const declared = pkg?.dsh?.dynamic?.[half]
  if (typeof declared === 'string' && declared.length > 0) {
    const full = resolve(pluginDir, declared)
    try {
      if (statSync(full).isFile()) return full
    } catch { /* fall through to main inference */ }
  }
  // Node module resolution: exports["."] → main → index.js.
  const candidates = []
  const exp = pkg?.exports
  if (exp !== null && typeof exp === 'object' && !Array.isArray(exp)) {
    const dot = exp['.'] ?? exp['.']
    if (typeof dot === 'string') candidates.push(dot)
    else if (dot !== null && typeof dot === 'object') {
      const def = dot['default'] ?? dot['import'] ?? dot['require']
      if (typeof def === 'string') candidates.push(def)
    }
  }
  if (typeof pkg?.main === 'string' && pkg.main.length > 0) candidates.push(pkg.main)
  candidates.push('index.js')
  for (const candidate of candidates) {
    const full = resolve(pluginDir, candidate)
    try {
      if (statSync(full).isFile()) return full
    } catch { /* try next */ }
  }
  return null
}

/** Whether the package declares any runtime dependency (deps or peers). */
function hasDeclaredDeps(pkg) {
  const d = pkg?.dependencies
  const p = pkg?.peerDependencies
  return (d !== null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0) ||
    (p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0)
}

/** Whether the package declares itself a bundle plugin (skip those). */
function isBundlePlugin(pkg) {
  return pkg?.dsh?.bundle?.patch !== undefined
}

/**
 * Classify one scanned plugin: channel (runner/loader) + status.
 * The CODE SHAPE is the primary judge, package.json declarations assist:
 *   - entry uses import/export/require (needs the module system)
 *       → loader channel; with declared deps → ready, without → needs-deps
 *         (blocked until the user declares them in package.json)
 *   - entry is a function body (no import/export; e.g. web-access's
 *     `return { apply }` file) → runner channel REGARDLESS of declared deps
 *     — declared deps are then for subprocesses/external tooling (e.g.
 *     playwright-core for the browser bridge) and never enter the runner
 *     sandbox. Such a file cannot be loader-mounted anyway: a top-level
 *     `return` is a syntax error under ESM import.
 */
function classifyPlugin(pkg, hostFile) {
  if (!hostFile) return { status: 'no-entry', channel: null, entrySource: 'missing', imports: [] }
  const head = readFileSync(hostFile, 'utf8').slice(0, 8192)
  const usesImports = needsLoaderChannel(head)
  if (usesImports) {
    const imports = extractImports(head)
    // Imports that are only node: builtins / relative paths need no declared
    // deps — the loader channel hosts them with zero installs.
    const needDeclared = imports.length > 0 && !hasDeclaredDeps(pkg)
    return {
      status: needDeclared ? 'needs-deps' : 'ready',
      channel: 'loader',
      entrySource: typeof pkg?.dsh?.dynamic?.host === 'string' ? 'dsh.dynamic.host' : 'package.json main/exports',
      imports,
    }
  }
  return {
    status: 'ready',
    channel: 'runner',
    entrySource: typeof pkg?.dsh?.dynamic?.host === 'string' ? 'dsh.dynamic.host' : 'package.json main/exports',
    imports: [],
  }
}

/**
 * Build the display name for a plugin dir: package.json name, disambiguated
 * by prepending parent folder names (joined with "/") while the name is
 * already taken. Returns { name, disambiguated } or null when the name is
 * empty. If prefixes run out (drive root reached) the name stays as-is —
 * that means it is the same file as an existing entry.
 */
function buildName(pluginDir, pkg, taken) {
  const base = String(pkg.name || '').trim()
  if (!base) return null
  let name = base
  let prefix = []
  let cur = dirname(pluginDir)
  while (taken.has(name)) {
    if (cur === dirname(cur)) break // drive root
    prefix.unshift(basename(cur))
    cur = dirname(cur)
    name = [...prefix, base].join('/')
  }
  return { name, disambiguated: prefix.length > 0 }
}

/** Scan one scan directory; returns plugin entries. */
function scanDir(scanDir, taken) {
  const out = []
  let entries
  try {
    entries = readdirSync(scanDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const pluginDir = join(scanDir, entry.name)
    // Follow symlinks/junctions: pnpm link-installed plugins appear as
    // directory links whose Dirent.isDirectory() is false.
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = statSync(pluginDir).isDirectory() } catch { isDir = false }
    }
    if (!isDir) continue
    const pkg = readPackageJson(pluginDir)
    if (!pkg) continue
    const name = String(pkg.name || '').trim()
    if (!name) continue
    if (isBundlePlugin(pkg)) continue // bundle plugins are managed elsewhere
    const hostFile = codeBodyFile(pluginDir, pkg, 'host')
    const built = buildName(pluginDir, pkg, taken)
    if (!built) continue
    taken.add(built.name)
    const cls = classifyPlugin(pkg, hostFile)
    let readme = ''
    for (const candidate of ['README.md', 'README.zh.md', 'README.en.md']) {
      try {
        const full = join(pluginDir, candidate)
        if (statSync(full).isFile()) {
          readme = readFileSync(full, 'utf8').slice(0, 400)
          break
        }
      } catch { /* try next */ }
    }
    out.push({
      name: built.name,
      rawName: name,
      dir: pluginDir,
      dirName: entry.name,
      description: String(pkg.description || ''),
      host: hostFile,
      client: null,
      status: cls.status,
      channel: cls.channel,
      entrySource: cls.entrySource,
      imports: cls.imports,
      readme: readme,
    })
  }
  return out
}

/**
 * Scan the built-in sources: the runner managed dir + the profile's
 * node_modules (loader plugins installed via dsh add). Realpath-deduped —
 * a link-installed package and a managed copy of the same source resolve to
 * one entry. Returns { plugins, dirs }.
 */
export function scanAll() {
  const taken = new Set()
  const plugins = []
  const dirResults = []
  const realSeen = new Set()
  const pushDedup = (list, sourceLabel) => {
    const kept = []
    for (const p of list) {
      let key = p.dir
      try { key = realpathSync(p.dir) } catch { /* keep p.dir */ }
      if (realSeen.has(key)) continue
      realSeen.add(key)
      plugins.push(p)
      kept.push(p)
    }
    if (kept.length > 0) dirResults.push({ path: sourceLabel, count: kept.length })
  }
  // Built-in source 1: runner managed dir (~/.dsh/dynplugin-manager/plugins).
  pushDedup(scanDir(managedDir(), taken), '托管目录(runner)')
  // Built-in source 2: profile node_modules (loader plugins from dsh add).
  pushDedup(scanNodeModules(currentProfile(), taken), '已安装(loader)')
  return { plugins, dirs: dirResults }
}

/** Runner managed dir where self-contained plugins are installed to. */
function managedDir() {
  return join(dshHome(), 'dynplugin-manager', 'plugins')
}

/** Profile directory for a profile name (DSH_HOME-aware). */
function profileDirOf(profile) {
  return join(dshHome(), 'profiles', profile)
}

/**
 * Scan a profile's node_modules for loader-channel plugins: top-level
 * packages and @scope/name pairs. Only entries whose entry file actually
 * exports `apply` (or declare dsh.dynamic.host) count — a cordis-plugin
 * feature filter that keeps plain libraries out of the list.
 */
function scanNodeModules(profile, taken) {
  const out = []
  const nm = join(profileDirOf(profile), 'node_modules')
  let entries
  try {
    entries = readdirSync(nm, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '.pnpm' || entry.name === '.bin') continue
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = statSync(join(nm, entry.name)).isDirectory() } catch { isDir = false }
    }
    if (!isDir) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(nm, entry.name)
      let inner
      try {
        inner = readdirSync(scopeDir, { withFileTypes: true })
      } catch { continue }
      for (const innerEntry of inner) {
        if (innerEntry.name.startsWith('.')) continue
        let innerIsDir = innerEntry.isDirectory()
        if (!innerIsDir && innerEntry.isSymbolicLink()) {
          try { innerIsDir = statSync(join(scopeDir, innerEntry.name)).isDirectory() } catch { innerIsDir = false }
        }
        if (innerIsDir) collectNodeModulePlugin(join(scopeDir, innerEntry.name), taken, out)
      }
    } else {
      collectNodeModulePlugin(join(nm, entry.name), taken, out)
    }
  }
  return out
}

/** Collect one node_modules package if it is a cordis plugin. */
function collectNodeModulePlugin(pluginDir, taken, out) {
  const pkg = readPackageJson(pluginDir)
  if (!pkg) return
  const name = String(pkg.name || '').trim()
  if (!name) return
  if (isBundlePlugin(pkg)) return
  const hostFile = codeBodyFile(pluginDir, pkg, 'host')
  if (!hostFile) return
  if (!isCordisEntry(hostFile, pkg)) return
  const cls = classifyPlugin(pkg, hostFile)
  const built = buildName(pluginDir, pkg, taken)
  if (!built) return
  taken.add(built.name)
  let readme = ''
  for (const candidate of ['README.md', 'README.zh.md', 'README.en.md']) {
    try {
      const full = join(pluginDir, candidate)
      if (statSync(full).isFile()) {
        readme = readFileSync(full, 'utf8').slice(0, 400)
        break
      }
    } catch { /* try next */ }
  }
  out.push({
    name: built.name,
    rawName: name,
    dir: pluginDir,
    dirName: basename(pluginDir),
    description: String(pkg.description || ''),
    host: hostFile,
    client: null,
    status: cls.status,
    channel: cls.channel,
    entrySource: cls.entrySource,
    imports: cls.imports,
    readme: readme,
  })
}

/**
 * Cordis-plugin feature filter: the entry either declares dsh.dynamic.host
 * or exports an `apply` symbol (function/const/class or named export).
 * Libraries whose entry lacks apply are not plugins.
 */
function isCordisEntry(hostFile, pkg) {
  if (typeof pkg?.dsh?.dynamic?.host === 'string') return true
  try {
    const head = readFileSync(hostFile, 'utf8').slice(0, 8192)
    return /export\s+(?:function\s+apply|const\s+apply|class\s+apply|\{\s*apply\b)|return\s*\{\s*apply\b/.test(head)
  } catch {
    return false
  }
}

/**
 * Loader-channel quality gate shared by /dynload and the mount API: every
 * declared dependency must resolve on the real chain (profile node_modules,
 * plugin-local node_modules), and the package itself must be installed.
 * Returns an error text, or null when the gate passes.
 */
function loaderGate(profile, target) {
  if (target.status === 'no-entry') {
    return `Plugin "${target.name}" has no built entry file (${target.dir}); build it first or fix package.json main.`
  }
  if (target.status === 'needs-deps') {
    const list = (target.imports && target.imports.length > 0)
      ? target.imports.map((s) => `  - ${s}`).join('\n')
      : '  (unresolved)'
    return `Plugin "${target.name}" imports packages but package.json declares no dependencies. Add them first, e.g.:\n\ndependencies: {\n${target.imports.map((s) => `  "${s}": "<version>"`).join(',\n')}\n}\n\nImported:\n${list}\nThen rescan and retry /dynload.`
  }
  const pkg = readPackageJson(target.dir)
  const declared = []
  for (const field of ['dependencies', 'peerDependencies']) {
    const obj = pkg?.[field]
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) declared.push(...Object.keys(obj))
  }
  const missing = declared.filter((dep) => !resolvesFrom(target.dir, dep))
  if (missing.length > 0) {
    return `Plugin "${target.rawName}" is missing dependencies in profile "${profile}":\n${missing.map((d) => `  - ${d}`).join('\n')}\nInstall them (e.g. npm install in the plugin dir, or 'dsh plugin --profile ${profile} add <dep>'), then retry.`
  }
  if (!isInstalled(profile, target.rawName, target.dir)) {
    return `Package "${target.rawName}" is not installed in profile "${profile}". Install it first, e.g. 'dsh plugin --profile ${profile} add -w ${target.dir}' (or add <pkg> from npm), then retry /dynload ${target.name}.`
  }
  return null
}
/**
 * Verify one insert row by applying it through the loader's live include
 * entry — the SAME channel the official patch watcher (watchUserPatches)
 * uses — WITHOUT writing the patch file. This is the "pre-execute before
 * persisting" gate: real import resolution and real apply(ctx) run, and a
 * failure leaves zero residue (nothing written, nothing to roll back).
 * After a successful verification the caller persists the row; the watcher's
 * later refresh of the same content is a no-op.
 *
 * Compensations needed (same ones web-plugin-manager's live.ts documents):
 *   - applyEntryPatches mutates the patch objects it is given → deep-clone the
 *     stack before every update;
 *   - entry.update() can hang when the include's apply queue is poisoned →
 *     a timeout converts that into a "restart to apply" outcome.
 */
async function liveApplyInsert(ctx, profile, rowId, pkgName) {
  const loader = ctx.get('loader')
  if (loader === undefined) return { ok: false, message: 'no loader service' }
  let entry
  try {
    for (const candidate of loader.entries()) {
      if (candidate.id === 'include') { entry = candidate; break }
    }
  } catch {
    return { ok: false, message: 'loader entries unavailable' }
  }
  if (entry === undefined || typeof entry.update !== 'function' || entry.options === undefined || entry.options.config === undefined) {
    return { ok: false, message: 'no live include entry' }
  }
  const config = entry.options.config
  const current = config.patches
  if (!Array.isArray(current)) return { ok: false, message: 'no live patch stack' }
  const stack = structuredClone(current)
  stack.push({ insert: [{ id: rowId, name: pkgName }] })
  const { patches: _ignored, ...rest } = config
  try {
    await Promise.race([
      entry.update({ config: { ...rest, patches: stack } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('live apply timed out')), 8000)),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Any live-apply failure aborts the mount — no persist on uncertainty. */

// ── /dynload slash command ──────────────────────────────────────────────
async function loadPlugin(agent, runner, plugin, signal) {
  const hostCode = readFileSync(plugin.host, 'utf8')
  const def = runner.define({
    sessionId: agent.id,
    plugin: { kind: 'new', idPrefix: 'dyn' },
    name: plugin.rawName,
    purpose: plugin.description || plugin.rawName,
    code: { host: hostCode },
  })
  const receipt = await runner.run(agent, def.pluginId, def.packageId, 'run', signal)
  if (!receipt.ok) throw new Error(String(receipt.message || 'activation failed'))
  return def
}

/** Turn a package name into a safe insert-row id (scope slash → dash, @ dropped). */
function slugify(pkgName) {
  let id = pkgName.replace(/^@/, '').replace(/[\/\\]/g, '-').replace(/[^A-Za-z0-9._-]/g, '-')
  if (id.length > 120) id = id.slice(0, 120)
  return id
}

/**
 * Run the dsh CLI (through cmd.exe so .cmd resolution works on Windows) and
 * capture output. Never rejects: failures come back as { ok: false, ... }.
 */
function runDsh(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const full = ['/c', 'dsh', ...args]
    execFile('cmd.exe', full, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const message = String(stderr || stdout || '').trim()
      resolve(error
        ? { ok: false, code: typeof error.code === 'number' ? error.code : String(error.code || error.message), message: message || String(error.message) }
        : { ok: true, code: 0, message })
    })
  })
}

/** Whether `child` is inside `parent` (path-prefix check, case-insensitive). */
function isUnder(child, parent) {
  const c = child.toLowerCase().replace(/[\\/]+$/g, '')
  const p = parent.toLowerCase().replace(/[\\/]+$/g, '')
  return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/')
}

export function apply(ctx) {
  const commands = ctx.commands
  const runner = ctx.dynamicCordisRunner

  /**
   * Unified load: pick the channel by the plugin's shape.
   *   - runner channel (self-contained, no imports): session-scoped load
   *     through dynamicCordisRunner — can never crash the harness.
   *   - loader channel (declared deps / import-using): quality gate first —
   *     every declared dependency must be resolvable from the profile, or an
   *     insert row would fail the WHOLE profile at the next boot (fail-loud);
   *     only then write the managed insert row (official watcher applies it
   *     live, persistent).
   *   - needs-deps: code imports packages but package.json declares none —
   *     block with the exact import list so the user can declare them.
   */
  async function handleLoad(ctx, agent, target, signal) {
    if (target.status === 'no-entry') {
      return { kind: 'error', text: `Plugin "${target.name}" has no built entry file (${target.dir}); build it first or fix package.json main.` }
    }
    if (target.status === 'needs-deps') {
      const list = (target.imports && target.imports.length > 0)
        ? target.imports.map((s) => `  - ${s}`).join('\n')
        : '  (unresolved)'
      return {
        kind: 'error',
        text: `Plugin "${target.name}" imports packages but package.json declares no dependencies. Add them first, e.g.:\n\ndependencies: {\n${target.imports.map((s) => `  "${s}": "<version>"`).join(',\n')}\n}\n\nImported:\n${list}\nThen rescan and retry /dynload.`,
      }
    }
    if (target.channel === 'loader') {
      const profile = currentProfile()
      const gateError = loaderGate(profile, target)
      if (gateError !== null) return { kind: 'error', text: gateError }
      try {
        const rowId = slugify(target.rawName)
        if (hasManagedRow(profile, rowId)) {
          return {
            kind: 'success',
            text: `Mounted ${target.rawName} into profile "${profile}" (already mounted). It persists across restarts; unmount with /dynunmount ${target.name}.`,
          }
        }
        // VERIFY FIRST, PERSIST SECOND: apply the insert row through the live
        // include entry WITHOUT touching the patch file. Real import
        // resolution + real apply(ctx) run here — ANY failure (missing deps,
        // apply-time error, hang/timeout) aborts the mount: nothing was
        // written and there is nothing to roll back. Persisting a plugin that
        // failed its own mount would risk the whole profile at next boot.
        const live = await liveApplyInsert(ctx, profile, rowId, target.rawName)
        if (!live.ok) {
          await recordFailure(target.name, live.message)
          return {
            kind: 'error',
            text: `Mount of ${target.rawName} FAILED: ${live.message}\nNothing was written to the profile — fix the plugin (dependencies / code) and retry /dynload.`,
          }
        }
        await clearFailure(target.name)
        // Persist now: the official watcher re-applies the same content, which
        // is a no-op (identical patches are treated as unchanged).
        const written = writeInsertRow(profile, rowId, target.rawName)
        if (written === null) {
          return {
            kind: 'success',
            text: `Mounted ${target.rawName} into profile "${profile}" (already mounted). It persists across restarts; unmount with /dynunmount ${target.name}.`,
          }
        }
        return {
          kind: 'success',
          text: `Mounted ${target.rawName} into profile "${profile}" (applied live). It persists across restarts; unmount with /dynunmount ${target.name}.`,
        }
      } catch (error) {
        return { kind: 'error', text: `Failed to mount ${target.name}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    try {
      const def = await loadPlugin(agent, runner, target, signal)
      return {
        kind: 'success',
        text: `Loaded ${def.pluginId}/${def.packageId} (${def.name}). It is session-scoped: lost after a DSH restart.`,
      }
    } catch (error) {
      return { kind: 'error', text: `Failed to load ${target.name}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Resolve a scanned plugin by display name, or a listing error. */
  function findTarget(raw) {
    if (!raw) return { error: 'Usage: /dynload <plugin-name>. List available plugins in Settings → 动态插件.' }
    const { plugins } = scanAll()
    const target = plugins.find((p) => p.name === raw)
    if (!target) {
      const names = plugins.map((p) => p.name).join(', ')
      return { error: `Plugin "${raw}" not found. Available: ${names || '(none)'}` }
    }
    return { target }
  }

  // ── slash command /dynload <name> (unified: auto-routes runner/loader) ──
  ctx.effect(() => commands.register({
    name: 'dynload',
    description: 'Load a scanned dynamic plugin: self-contained ones load session-scoped (runner), import-using ones mount persistently (loader, insert row).',
    input: { hint: '<插件名>' },
    handler: async (invocation) => {
      const found = findTarget(invocation.rawInput.trim())
      if (found.error) return { kind: 'error', text: found.error }
      return handleLoad(ctx, invocation.agent, found.target, invocation.signal)
    },
  }))

  // ── slash command /dynunmount <name> (remove managed insert row)
  ctx.effect(() => commands.register({
    name: 'dynunmount',
    description: 'Remove a plugin from the running state: loader → managed insert row (live unmount); runner → delete its managed-dir copy (its only persistent trace).',
    input: { hint: '<插件名>' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) return { kind: 'error', text: 'Usage: /dynunmount <plugin-name>' }
      const { plugins } = scanAll()
      const target = plugins.find((p) => p.name === raw)
      if (!target) return { kind: 'error', text: `Plugin "${raw}" not found.` }
      const pkgName = target.rawName
      try {
        const profile = currentProfile()
        if (target.channel === 'runner') {
          if (isUnder(target.dir, managedDir())) {
            rmSync(target.dir, { recursive: true, force: true })
            return {
              kind: 'success',
              text: `Removed ${pkgName} from the managed dir (${target.dir}). Reinstall it through the dialog if needed.`,
            }
          }
          return {
            kind: 'error',
            text: `"${pkgName}" is a runner plugin but not installed in the managed dir (${target.dir}) — there is no persistent trace to remove.`,
          }
        }
        const removed = removeInsertRow(profile, slugify(pkgName))
        return {
          kind: 'success',
          text: removed
            ? `Removed insert row for ${pkgName} (unmounts live via patch watcher).`
            : `No managed insert row found for ${pkgName} — nothing to remove.`,
        }
      } catch (error) {
        return { kind: 'error', text: `Failed to unmount ${pkgName}: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ── slash command /dynuninstall <name> (full removal, restores clean state)
  ctx.effect(() => commands.register({
    name: 'dynuninstall',
    description: 'Fully remove a plugin: unmount (insert row), remove the package from the profile, delete managed copies and failure records. Restores a clean state.',
    input: { hint: '<插件名>' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) return { kind: 'error', text: 'Usage: /dynuninstall <plugin-name>' }
      const { plugins } = scanAll()
      const target = plugins.find((p) => p.name === raw)
      if (!target) return { kind: 'error', text: `Plugin "${raw}" not found.` }
      const profile = currentProfile()
      const steps = []
      try {
        if (target.channel === 'loader') {
          // 1. unmount: remove managed insert row
          try {
            const removed = removeInsertRow(profile, slugify(target.rawName))
            steps.push(removed ? `✓ insert 行已移除` : `— 无 insert 行`)
          } catch (error) {
            steps.push(`✗ insert 行移除失败: ${error instanceof Error ? error.message : String(error)}`)
          }
          // 2. remove the package + its exclusive deps from the profile
          const r = await runDsh(['plugin', '--profile', profile, 'remove', target.rawName])
          steps.push(r.ok ? `✓ 包已从 profile 移除` : `✗ 包移除失败: ${r.message || r.code}`)
        } else if (isUnder(target.dir, managedDir())) {
          // runner plugin installed into the managed dir: delete the copy.
          try {
            rmSync(target.dir, { recursive: true, force: true })
            steps.push(`✓ 托管副本已删除`)
          } catch (error) {
            steps.push(`✗ 托管副本删除失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          steps.push(`— 源码目录保留（${target.dir}）`)
        }
        // 3. clear failure records
        await clearFailure(target.name)
        steps.push(`✓ 状态记录已清理`)
        const failed = steps.some((s) => s.startsWith('✗'))
        return {
          kind: failed ? 'error' : 'success',
          text: `Uninstall ${target.rawName}:\n${steps.join('\n')}${failed ? '\n未完全清理，请按提示手动处理。' : '\n已恢复干净状态。'}`,
        }
      } catch (error) {
        return { kind: 'error', text: `Uninstall failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ── same-origin JSON routes for the Settings UI ────────────────────────
  const webServer = ctx.webServer
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const isSameOrigin = (req) => {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site === 'cross-site') return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      const host = req.headers.host
      if (typeof host !== 'string' || host === '') return false
      try {
        if (new URL(origin).host !== host) return false
      } catch {
        return false
      }
    }
    return true
  }
  const guard = (req, res) => {
    if (!isSameOrigin(req)) { json(res, 403, { ok: false, error: 'cross-site-request-rejected' }); return false }
    return true
  }
  const readBody = async (req) => {
    let raw = ''
    try {
      for await (const chunk of req) raw += chunk
    } catch (error) {
      return null
    }
    try {
      return JSON.parse(raw || '{}')
    } catch {
      return null
    }
  }
  const currentDirs = () => readDirs()

  /**
   * Compute live mount states for scanned plugins:
   *   - unbuilt    entry file missing (needs build)
   *   - needs-deps imports without declared deps (blocked)
   *   - runner:    loaded = dynamicCordisRunner inventory has an ACTIVE run
   *                whose package name matches the plugin
   *   - loader:    loaded = managed insert row present; failed = persisted
   *                mount failure (with reason); idle otherwise
   */
  async function withStates(plugins) {
    const profile = currentProfile()
    const failures = readFailures()
    const loadedNames = await runnerInventoryNames()
    return plugins.map((p) => {
      let state
      let failReason
      if (p.status === 'no-entry') state = 'unbuilt'
      else if (p.status === 'needs-deps') state = 'needs-deps'
      else if (p.channel === 'runner') state = loadedNames.has(p.rawName) ? 'loaded' : 'idle'
      else if (hasManagedRow(profile, slugify(p.rawName))) state = 'loaded'
      else if (failures[p.name]) { state = 'failed'; failReason = failures[p.name].message }
      else state = 'idle'
      return failReason === undefined ? { ...p, state } : { ...p, state, failReason }
    })
  }

  /** Names of runner-channel plugins with an active run (best-effort). */
  async function runnerInventoryNames() {
    try {
      const raw = typeof runner.inventory === 'function' ? runner.inventory() : null
      const rows = raw !== null && typeof raw.then === 'function' ? await raw : raw
      const out = new Set()
      for (const row of rows ?? []) {
        if (row === null || typeof row !== 'object' || !row.activeRun) continue
        if (!Array.isArray(row.packages)) continue
        for (const p of row.packages) {
          if (p !== null && typeof p === 'object' && typeof p.name === 'string') out.add(p.name)
        }
      }
      return out
    } catch {
      return new Set() // inventory unavailable → runner plugins show idle
    }
  }

  /**
   * Scan an install source into candidate plugin cards.
   *   - kind 'dir': the directory itself (if it is a plugin) or its first-level
   *     subdirectories.
   *   - kind 'github': owner/repo → zip download + extract to the cache dir,
   *     then scan like a local dir.
   *   - kind 'npm': registry metadata → one single-package card.
   */
  async function scanInstallSource(source, kind) {
    if (kind === 'npm') {
      const r = await fetch('https://registry.npmjs.org/' + encodeURIComponent(source), { signal: AbortSignal.timeout(30000) })
      if (!r.ok) throw new Error(`npm registry 查询失败 (HTTP ${r.status})`)
      const meta = await r.json()
      const rawName = String(meta.name || source)
      const profile = currentProfile()
      return {
        candidates: [{
          name: rawName,
          rawName,
          dir: null,
          description: String(meta.description || ''),
          channel: 'loader',
          status: 'ready',
          entrySource: 'npm',
          sourceKind: 'npm',
          version: String(meta['dist-tags']?.latest || ''),
          installed: isInstalled(profile, rawName),
          mounted: hasManagedRow(profile, slugify(rawName)),
        }],
        cacheDir: null,
      }
    }
    let scanRoot
    if (kind === 'github') scanRoot = await downloadAndExtractGithub(source)
    else scanRoot = source
    const taken = new Set()
    const candidates = []
    const profile = currentProfile()
    if (readPackageJson(scanRoot)) {
      collectFromDir(scanRoot, taken, candidates)
    } else {
      let entries
      try {
        entries = readdirSync(scanRoot, { withFileTypes: true })
      } catch {
        throw new Error('目录不存在或不可读: ' + scanRoot)
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        let isDir = e.isDirectory()
        if (!isDir && e.isSymbolicLink()) {
          try { isDir = statSync(join(scanRoot, e.name)).isDirectory() } catch { isDir = false }
        }
        if (isDir) collectFromDir(join(scanRoot, e.name), taken, candidates)
      }
    }
    // Stamp install state: whether the package is already added to the profile
    // (loader) or copied into the managed dir (runner), and whether it is
    // already mounted. The dialog uses this to switch the button to "mount"
    // or disable it instead of offering a pointless reinstall.
    for (const c of candidates) {
      if (c.channel === 'runner') {
        c.installed = existsSync(join(managedDir(), basename(c.dir)))
        c.mounted = false // runner loads are session-scoped; the dialog does not track them
      } else {
        c.installed = isInstalled(profile, c.rawName, c.dir)
        c.mounted = hasManagedRow(profile, slugify(c.rawName))
      }
    }
    return { candidates, cacheDir: kind === 'github' ? scanRoot : null }
  }

  /** Collect one directory as an install candidate (package.json + non-bundle). */
  function collectFromDir(dir, taken, out) {
    const pkg = readPackageJson(dir)
    if (!pkg) return
    const name = String(pkg.name || '').trim()
    if (!name) return
    if (isBundlePlugin(pkg)) return
    const hostFile = codeBodyFile(dir, pkg, 'host')
    const cls = classifyPlugin(pkg, hostFile)
    const built = buildName(dir, pkg, taken)
    if (!built) return
    taken.add(built.name)
    out.push({
      name: built.name,
      rawName: name,
      dir,
      description: String(pkg.description || ''),
      channel: cls.channel,
      status: cls.status,
      entrySource: cls.entrySource,
      imports: cls.imports,
      sourceKind: null,
    })
  }

  /** Download + extract a GitHub repo zip into the cache dir. */
  async function downloadAndExtractGithub(spec) {
    const parts = spec.split('/').map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) throw new Error('GitHub 地址格式应为 owner/repo')
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '').replace(/#.*$/, '')
    const target = join(dshHome(), 'dynplugin-manager', 'cache', `${owner}-${repo}`)
    mkdirSync(target, { recursive: true })
    let zipBuf = null
    for (const branch of ['main', 'master']) {
      const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
        if (r.ok) { zipBuf = Buffer.from(await r.arrayBuffer()); break }
      } catch { /* try next branch */ }
    }
    if (zipBuf === null) throw new Error('GitHub 下载失败（网络不可达或仓库不存在）')
    const zipPath = join(target, 'src.zip')
    writeFileSync(zipPath, zipBuf)
    const extractDir = join(target, 'src')
    rmSync(extractDir, { recursive: true, force: true })
    mkdirSync(extractDir, { recursive: true })
    const tarOk = await new Promise((resolve) => {
      execFile('tar.exe', ['-xf', zipPath, '-C', extractDir], { timeout: 60000, windowsHide: true }, (e) => resolve(!e))
    })
    if (!tarOk) {
      const psOk = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`], { timeout: 120000, windowsHide: true }, (e) => resolve(!e))
      })
      if (!psOk) throw new Error('压缩包解压失败')
    }
    // GitHub zips contain one root folder <repo>-<branch>/
    const root = readdirSync(extractDir, { withFileTypes: true }).find((e) => e.isDirectory())
    return root ? join(extractDir, root.name) : extractDir
  }

  /**
   * Install one plugin directory:
   *   - mode 'link':  dsh plugin add "link:<dir>"   (symlink, edits live)
   *   - mode 'copy':  dsh plugin add "file:<dir>"   (copied into .pnpm)
   *   - mode 'managed': copy into the runner managed dir (self-contained
   *     plugins, session-scoped loads).
   */
  async function installPlugin(dir, mode) {
    const profile = currentProfile()
    if (mode === 'managed') {
      const dest = join(managedDir(), basename(dir))
      try {
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(managedDir(), { recursive: true })
        cpSync(dir, dest, { recursive: true })
        return { installed: true, dir: dest, message: `✓ 已复制到托管目录\n${dest}\n在会话中用 /dynload 加载（会话级）。` }
      } catch (error) {
        return { installed: false, message: `✗ 复制失败: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const spec = mode === 'link' ? 'link:' + dir : 'file:' + dir
    const r = await runDsh(['plugin', '--profile', profile, 'add', '-w', spec])
    if (!r.ok) {
      return {
        installed: false,
        message: `✗ dsh plugin add 失败\n${r.message}\n可手动执行:\ndsh plugin --profile ${profile} add -w "${spec}"`,
      }
    }
    return { installed: true, dir, message: `✓ ${mode === 'link' ? 'link' : 'copy'} 安装完成\n${r.message || ''}`.trim() }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/dynplugin/list',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const { plugins } = scanAll()
          const stateful = await withStates(plugins)
          json(res, 200, { ok: true, plugins: stateful, dirs: currentDirs() })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dynplugin/install/scan',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readBody(req)
        if (!body) { json(res, 400, { ok: false, error: 'bad json body' }); return }
        try {
          const source = String(body.source || '').trim()
          const kind = String(body.kind || 'dir').trim()
          if (!source) { json(res, 400, { ok: false, error: 'source required' }); return }
          const result = await scanInstallSource(source, kind)
          json(res, 200, { ok: true, ...result })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dynplugin/install',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readBody(req)
        if (!body) { json(res, 400, { ok: false, error: 'bad json body' }); return }
        try {
          const dir = String(body.dir || '').trim()
          const mode = String(body.mode || 'link').trim()
          if (!dir) { json(res, 400, { ok: false, error: 'dir required' }); return }
          if (!['link', 'copy', 'managed'].includes(mode)) { json(res, 400, { ok: false, error: 'mode must be link|copy|managed' }); return }
          const result = await installPlugin(dir, mode)
          json(res, 200, { ok: true, ...result })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dynplugin/mount',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readBody(req)
        if (!body) { json(res, 400, { ok: false, error: 'bad json body' }); return }
        const name = String(body.name || '').trim()
        if (!name) { json(res, 400, { ok: false, error: 'name required' }); return }
        try {
          const { plugins } = scanAll()
          const target = plugins.find((p) => p.name === name)
          if (!target) { json(res, 404, { ok: false, error: `Plugin "${name}" not found` }); return }
          // Agent-less mount: no agent context available over HTTP; reuse the
          // loader-channel path directly (runner loads need an agent, so they
          // stay slash-command only).
          if (target.channel === 'runner') {
            json(res, 400, { ok: false, error: 'runner plugins load session-scoped — use /dynload in a session' })
            return
          }
          const profile = currentProfile()
          const gateError = loaderGate(profile, target)
          if (gateError !== null) {
            json(res, 400, { ok: false, error: gateError })
            return
          }
          const rowId = slugify(target.rawName)
          if (hasManagedRow(profile, rowId)) {
            json(res, 200, { ok: true, mounted: true, already: true, text: `already mounted` })
            return
          }
          const live = await liveApplyInsert(ctx, profile, rowId, target.rawName)
          if (!live.ok) {
            await recordFailure(target.name, live.message)
            json(res, 200, { ok: false, mounted: false, error: live.message })
            return
          }
          await clearFailure(target.name)
          await writeInsertRow(profile, rowId, target.rawName)
          json(res, 200, { ok: true, mounted: true, already: false, text: 'applied live' })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dynplugin/dirs',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method === 'GET') {
          json(res, 200, { ok: true, dirs: currentDirs() })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readBody(req)
        if (!body) { json(res, 400, { ok: false, error: 'bad json body' }); return }
        const dir = String(body.path || '').trim()
        if (!dir) { json(res, 400, { ok: false, error: 'path required' }); return }
        const alias = String(body.alias || '').trim()
        const dirs = currentDirs().map((d) => ({ path: d.path, alias: d.alias || '', order: d.order }))
        if (dirs.some((d) => d.path === dir)) { json(res, 409, { ok: false, error: 'directory already added' }); return }
        if (alias) {
          const aliasTaken = dirs.some((d) => d.alias === alias) ||
            dirs.some((d) => basename(d.path) === alias)
          if (aliasTaken) { json(res, 409, { ok: false, error: 'alias already in use (must differ from other aliases and directory names)' }); return }
        }
        dirs.push({ path: dir, alias, order: dirs.length })
        try {
          await writeDirs(dirs)
          json(res, 200, { ok: true, dirs })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dynplugin/dir',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'DELETE') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readBody(req)
        if (!body) { json(res, 400, { ok: false, error: 'bad json body' }); return }
        const dir = String(body.path || '').trim()
        const dirs = currentDirs().filter((d) => d.path !== dir).map((d) => ({ path: d.path, alias: d.alias || '', order: d.order }))
        if (dirs.length === currentDirs().length) { json(res, 404, { ok: false, error: 'directory not found' }); return }
        try {
          await writeDirs(dirs)
          json(res, 200, { ok: true, dirs })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
  ctx.effect(() => {
    const disposers = []
    try {
      for (const route of routes) disposers.push(webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dynplugin-manager: routes')
}
