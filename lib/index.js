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
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { currentProfile, writeInsertRow, removeInsertRow, isInstalled, needsLoaderChannel } from './loader.js'

export const name = 'dynplugin-manager'

/** Hard dependencies: the runner must exist before this plugin activates. */
export const inject = ['dynamicCordisRunner', 'commands', 'webServer']

// ── scan-directory store: JSON file, atomic writes, serialized queue ────
function storePath() {
  return join(homedir(), '.dsh', 'dynplugin-manager.json')
}

function loadDirs() {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.dirs)) {
      return parsed.dirs.map((d) => ({
        path: String(d.path || '').trim(),
        alias: String(d.alias || '').trim(),
        order: Number(d.order) || 0,
      })).filter((d) => d.path)
    }
  } catch { /* absent or unreadable → empty list */ }
  return []
}

/** Read the current dirs; callers must treat the result as immutable. */
function readDirs() {
  return loadDirs()
}

let writeQueue = Promise.resolve()

/** Persist a full dirs array. Serialized; atomic via tmp file + rename. */
function writeDirs(dirs) {
  const payload = { dirs: dirs.map((d) => ({ path: d.path, alias: d.alias || '', order: d.order })) }
  writeQueue = writeQueue.then(async () => {
    const target = storePath()
    const tmp = target + '.tmp'
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, target)
  })
  return writeQueue
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

/** Whether the package declares itself a bundle plugin (skip those). */
function isBundlePlugin(pkg) {
  return pkg?.dsh?.bundle?.patch !== undefined
}

/** Read the head of a JS file to sniff its load-channel requirement. */
function sniffChannel(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 8192)
    return needsLoaderChannel(head) ? 'loader' : 'runner'
  } catch {
    return 'runner'
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
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const pluginDir = join(scanDir, entry.name)
    const pkg = readPackageJson(pluginDir)
    if (!pkg) continue
    const name = String(pkg.name || '').trim()
    if (!name) continue
    if (isBundlePlugin(pkg)) continue // bundle plugins are managed elsewhere
    const hostFile = codeBodyFile(pluginDir, pkg, 'host')
    const built = buildName(pluginDir, pkg, taken)
    if (!built) continue
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
      dirName: entry.name,
      description: String(pkg.description || ''),
      host: hostFile,
      client: null,
      status: hostFile ? 'ready' : 'no-entry',
      channel: hostFile ? sniffChannel(hostFile) : null,
      entrySource: hostFile
        ? (typeof pkg?.dsh?.dynamic?.host === 'string' ? 'dsh.dynamic.host' : 'package.json main/exports')
        : 'missing',
      readme: readme,
    })
  }
  return out
}

/** Scan every configured directory; returns { plugins, dirs }. */
export function scanAll(dirs) {
  const taken = new Set()
  const plugins = []
  const dirResults = []
  for (const d of dirs) {
    const found = scanDir(d.path, taken)
    plugins.push(...found)
    dirResults.push({ path: d.path, alias: d.alias || '', count: found.length })
  }
  return { plugins, dirs: dirResults }
}

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

export function apply(ctx) {
  const commands = ctx.commands
  const runner = ctx.dynamicCordisRunner

  /**
   * Unified load: pick the channel by the plugin's shape.
   *   - runner channel (self-contained, no import/require): session-scoped
   *     load through dynamicCordisRunner.
   *   - loader channel (community npm plugin using imports): mount via a
   *     managed insert row in cordis.patch.yml — the official patch watcher
   *     applies it live (no restart) and it persists across restarts.
   */
  async function handleLoad(agent, target, signal) {
    if (target.status !== 'ready') {
      return { kind: 'error', text: `Plugin "${target.name}" has no built entry file (${target.dir}); build it first or fix package.json main.` }
    }
    if (target.channel === 'loader') {
      const profile = currentProfile()
      if (!isInstalled(profile, target.rawName)) {
        return {
          kind: 'error',
          text: `Package "${target.rawName}" is not installed in profile "${profile}". Install it first, e.g. 'dsh plugin --profile ${profile} add -w ${target.dir}' (or add <pkg> from npm), then retry /dynload ${target.name}.`,
        }
      }
      try {
        const rowId = slugify(target.rawName)
        const written = writeInsertRow(profile, rowId, target.rawName)
        const state = written === null ? 'already mounted' : 'insert row written — official patch watcher mounts it live'
        return {
          kind: 'success',
          text: `Mounted ${target.rawName} into profile "${profile}" (${state}). It persists across restarts; unmount with /dynunmount ${target.name}.`,
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
    const { plugins } = scanAll(readDirs())
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
      return handleLoad(invocation.agent, found.target, invocation.signal)
    },
  }))

  // ── slash command /dynunmount <name> (remove managed insert row)
  ctx.effect(() => commands.register({
    name: 'dynunmount',
    description: 'Remove the managed insert row for a loader-channel plugin (unmounts it live).',
    input: { hint: '<插件名>' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) return { kind: 'error', text: 'Usage: /dynunmount <plugin-name>' }
      const { plugins } = scanAll(readDirs())
      const target = plugins.find((p) => p.name === raw)
      const pkgName = target ? target.rawName : raw
      try {
        const profile = currentProfile()
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
  const routes = [
    {
      kind: 'exact',
      path: '/api/dynplugin/list',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        try {
          const { plugins } = scanAll(currentDirs())
          json(res, 200, { ok: true, plugins, dirs: currentDirs() })
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
