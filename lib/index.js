// dsh-dynplugin-manager — manage DSH dynamic plugins: scan directories,
// browse, and load via /dynload slash command. Host half.
//
// Scan spec (see README): a plugin is a first-level subdirectory of a
// user-added scan directory that contains package.json with `name` and
// `dsh.dynamic.host`. Name collisions are disambiguated by prepending parent
// folder names level by level (joined with "/"), up to the drive root.
//
// Scan-directory list persistence: a small JSON file under the DSH home
// (~/.dsh/dynplugin-manager.json), written atomically (tmp + rename) through
// a serialized write queue. Deliberately NOT the settings service — direct
// file storage keeps the read-modify-write flow simple and avoids the
// deep-freeze snapshot constraints of settings scopes.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'

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
  const declared = pkg?.dsh?.dynamic?.[half]
  if (typeof declared !== 'string' || declared.length === 0) return null
  const full = resolve(pluginDir, declared)
  try {
    if (!statSync(full).isFile()) return null
  } catch {
    return null
  }
  return full
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
    const hostFile = codeBodyFile(pluginDir, pkg, 'host')
    if (!hostFile) continue // no dsh.dynamic.host → not a plugin
    const clientFile = codeBodyFile(pluginDir, pkg, 'client')
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
      client: clientFile,
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
  let clientCode
  if (plugin.client) clientCode = readFileSync(plugin.client, 'utf8')
  const def = runner.define({
    sessionId: agent.id,
    plugin: { kind: 'new', idPrefix: 'dyn' },
    name: plugin.rawName,
    purpose: plugin.description || plugin.rawName,
    code: {
      ...(hostCode !== undefined ? { host: hostCode } : {}),
      ...(clientCode !== undefined ? { client: clientCode } : {}),
    },
  })
  const receipt = await runner.run(agent, def.pluginId, def.packageId, 'run', signal)
  if (!receipt.ok) throw new Error(String(receipt.message || 'activation failed'))
  return def
}

export function apply(ctx) {
  const commands = ctx.commands
  const runner = ctx.dynamicCordisRunner

  // ── slash command /dynload <name> (parameter form, kept as fallback) ────
  ctx.effect(() => commands.register({
    name: 'dynload',
    description: 'Load a dynamic plugin by its scanned display name (see Settings → 动态插件). Usage: /dynload <name>',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) {
        return { kind: 'error', text: 'Usage: /dynload <plugin-name>. List available plugins in Settings → 动态插件.' }
      }
      const { plugins } = scanAll(readDirs())
      const target = plugins.find((p) => p.name === raw)
      if (!target) {
        const names = plugins.map((p) => p.name).join(', ')
        return { kind: 'error', text: `Plugin "${raw}" not found. Available: ${names || '(none)'}` }
      }
      try {
        const def = await loadPlugin(invocation.agent, runner, target, invocation.signal)
        return {
          kind: 'success',
          text: `Loaded ${def.pluginId}/${def.packageId} (${def.name}). It is session-scoped: lost after a DSH restart.`,
        }
      } catch (error) {
        return { kind: 'error', text: `Failed to load ${target.name}: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // ── per-plugin commands /dyn-<name>, re-synced after every scan ────────
  // Command names cannot contain "/", so a display name that was
  // disambiguated with "/" (e.g. "test2/插件1") is mapped to "test2-插件1".
  const pluginCommandDisposers = new Map()

  const syncPluginCommands = () => {
    // dispose all previously registered per-plugin commands
    for (const dispose of pluginCommandDisposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    pluginCommandDisposers.clear()

    const { plugins } = scanAll(readDirs())
    for (const plugin of plugins) {
      const commandName = 'dyn-' + plugin.name.replace(/\//g, '-')
      const pluginName = plugin.name // capture for the handler closure
      const disposer = commands.register({
        name: commandName,
        description: `Load dynamic plugin "${pluginName}" (session-scoped).`,
        handler: async (invocation) => {
          const { plugins: current } = scanAll(readDirs())
          const target = current.find((p) => p.name === pluginName)
          if (!target) {
            return { kind: 'error', text: `Plugin "${pluginName}" no longer found in scan directories.` }
          }
          try {
            const def = await loadPlugin(invocation.agent, runner, target, invocation.signal)
            return {
              kind: 'success',
              text: `Loaded ${def.pluginId}/${def.packageId} (${def.name}). It is session-scoped: lost after a DSH restart.`,
            }
          } catch (error) {
            return { kind: 'error', text: `Failed to load ${target.name}: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
      pluginCommandDisposers.set(commandName, disposer)
    }
  }

  // initial sync at plugin activation
  syncPluginCommands()

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
          syncPluginCommands()
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
          syncPluginCommands()
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

  // When this plugin is stopped/updated, dispose every per-plugin command.
  ctx.effect(() => () => {
    for (const dispose of pluginCommandDisposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    pluginCommandDisposers.clear()
  }, 'dynplugin-manager: plugin commands')
}
