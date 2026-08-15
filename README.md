# dsh-dynplugin-manager

> Manage DSH dynamic plugins (Dynamic Cordis Plugins): scan directories, browse, load. Community gap — self-built plugin.

DSH dynamic plugins have two load channels:

- **runner channel** (`cordis_define` / `cordis_run`): **session-scoped**; code runs in a vm sandbox (no import/require) and is lost on process restart
- **loader channel** (insert row + official patch watcher): **persistent**; the community npm-plugin shape (normal `import`s); an insert row in `cordis.patch.yml` is applied live by the official watcher — no restart

Officially, dynamic plugins are only reachable through agent tools (model-invoked) — **no human-operable UI exists**. This plugin fills that gap with one unified command:

- **Settings page "动态插件" (Dynamic Plugins)**: manage scan directories (add multiple), browse scanned plugins (name + description + README + status/channel badge), open plugin source directories
- **Slash command `/dynload <plugin-name>`**: **auto-routes by plugin shape** — self-contained → runner session-scoped load; import-using → loader persistent mount
- **Slash command `/dynunmount <plugin-name>`**: remove a loader mount (surgical managed-block removal)
- **Read-only management**: the settings page only browses; loading always happens via the slash command

## Install

### ⚠️ Name collision warning

An npm package with the same name may exist or appear later (published by someone else). Installing by bare npm name may pull the wrong package. Always install from this repository explicitly:

```sh
# from GitHub
dsh plugin --profile web add -w Thomas-key/dsh-dynplugin-manager

# or from a local checkout
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

### 1. Install the runtime dependency (required!)

The plugin is installed by **link** (the profile references this directory), so Node resolves `import`s from the directory itself. The runtime dependency `@deepseek-ai/dsh-tools` is **not** committed (it lives in `node_modules/`, git-ignored) — you must install it in the checkout first, or `dsh web` **fails to start** with `ERR_MODULE_NOT_FOUND`:

```sh
cd dsh-dynplugin-manager
npm install          # installs @deepseek-ai/dsh-tools into ./node_modules
cd ..
```

> `peerDependencies` (`@deepseek-ai/cordis`, `react`) are provided by the DSH host — do not install them locally.

### 2. Add the plugin

```sh
dsh plugin --profile web add -w ./dsh-dynplugin-manager   # local install (link)
```

After restarting `dsh web`: Settings → Dynamic Plugins → add a scan directory → type `/dynload <plugin-name>` in a session.

## Scan spec (important)

The scanner only looks **one level deep**: every **first-level subdirectory** of a user-specified directory.

### Recognition

A folder is recognized as a plugin only when all of these hold:

1. **It has `package.json`** (otherwise skipped — not scanned, not shown)
2. **`name` is present** (otherwise skipped)
3. **It is not a bundle plugin** (declaring `dsh.bundle.patch` is skipped — those belong to `dsh plugin add`)

```text
scan-dir/
├── web-access/          ← ✓ has package.json, non-bundle, it's a plugin
│   ├── package.json
│   ├── plugin/index.js  ← entry (declared by dsh.dynamic.host)
│   └── README.md
├── dsh-emoji/           ← ✗ declares dsh.bundle, skipped (bundle plugin)
│   └── package.json
├── random-folder/       ← ✗ no package.json, skipped
│   └── index.js
```

### Entry resolution (no author cooperation needed)

The entry file follows **Node module-resolution rules**, in priority order:

1. `dsh.dynamic.host` (our field; wins when present)
2. `main` (standard package.json field)
3. `exports["."]` (including the `{ default }` shape)
4. `index.js` fallback

The resolved file **must actually exist** to be `ready`; a missing file (e.g. an unbuilt TS repo) is marked **「未构建」** (unbuilt) and loading reports it.

### Channel detection

The entry head (8KB) is sniffed: `import` / `require` present → **loader channel** (community npm-plugin shape); otherwise → **runner channel** (self-contained, web-access shape).

| Channel | Code shape | `/dynload` behavior | Persistence |
|---|---|---|---|
| runner | self-contained (no import/require) | session-scoped load | lost on restart |
| loader | real imports (community npm plugins) | writes a managed insert row; official watcher mounts it live | **persistent** |

### Loading npm-installed non-bundle plugins

Add `~/.dsh/profiles/<profile>/node_modules` as a scan directory — npm-installed non-bundle packages are recognized automatically (built entry, complete dependency tree); `/dynload <pkg-name>` mounts them directly.

### loader-channel prerequisite

For `/dynload` to take the loader path, the package must be **installed into the current profile** (`dsh plugin add -w <dir>` or `dsh plugin add <pkg>`) — the insert row's `name` is the package name, resolved from the profile's node_modules. Missing installs produce a clear hint.

### Name-collision disambiguation

Within the full scan scope (all added directories), the display name comes from `package.json` `name`. On collision:

1. The first scanned keeps its original name
2. Colliding ones **prepend parent folder names level by level**: `test2/插件1` (folder levels joined with `/`)
3. If collision persists all the way up to the drive root → it is the same file (same name + same path), treated as a duplicate and shown once

```text
c:/user/test1/插件1/package.json       → display name: 插件1
c:/user/test1/test2/插件1/package.json  → display name: test2/插件1 (because 插件1 is taken)
```

### Plugin-author template

For non-npm-shape (local source) plugins without package.json, **create one manually from this template** — `name` + `main` are enough to be scanned (`dsh.dynamic.host` optional):

```json
{
  "name": "my-plugin",
  "type": "module",
  "description": "One-line description (optional)",
  "main": "index.js",
  "dsh": { "dynamic": { "host": "index.js", "client": "client.js" } }
}
```

## Difference from the same-named package

There is already a `dsh-plugin-manager` on npm (author hrhgit) — that one manages **bundle plugins** (Loader-entry enable/disable, persisted to cordis.patch.yml). This plugin manages **dynamic plugins** (session-scoped runner loading + persistent loader mounting). Different targets, they can coexist.

## Maintenance status

This plugin was authored by **deepseek-v4-flash** (an AI agent). If this notice has not been removed, the author does not actively maintain this plugin — it was built to fill the gap of "DSH dynamic plugins have no human-operable UI" and works as-is. No updates are planned as long as it keeps working. Forks and PRs are welcome.

## License

MIT
