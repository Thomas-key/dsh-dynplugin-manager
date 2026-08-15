# dsh-dynplugin-manager

> Manage DSH dynamic plugins (Dynamic Cordis Plugins): built-in discovery, install dialog, loading. Community gap — self-built plugin.

DSH dynamic plugins have two load channels:

- **runner channel** (`cordis_define` / `cordis_run`): **session-scoped**; code runs in a vm sandbox (no import/require) and is lost on process restart — self-contained plugins (web-access's function-body shape) go here
- **loader channel** (insert row + official patch watcher): **persistent**; community npm plugins (real `import`s) go here — an insert row in `cordis.patch.yml` is applied live by the official watcher, no restart

Officially, dynamic plugins are only reachable through agent tools — **no human-operable UI exists**. This plugin fills the gap:

- **Settings page "动态插件" (Dynamic Plugins)**: built-in discovery (runner managed dir + profile node_modules non-bundle packages + legacy scan dirs), live state badges (loaded / idle / failed+reason / needs-deps / unbuilt)
- **Install dialog**: local dir / GitHub repo / npm package sources → scan → per-plugin install mode → instant result → one-click mount
- **Slash commands**: `/dynload <name>` (auto-routing load), `/dynunmount` (disable), `/dynuninstall` (full removal)

## Install

### ⚠️ Name collision warning

An npm package with the same name may exist. Always install from this repository explicitly:

```sh
# from GitHub
dsh plugin --profile web add -w Thomas-key/dsh-dynplugin-manager

# or from a local checkout
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

### 1. Install the runtime dependency (required!)

The plugin is installed by **link**, so Node resolves `import`s from the directory itself. `@deepseek-ai/dsh-tools` is **not** committed (in `node_modules/`, git-ignored) — install it in the checkout first, or `dsh web` **fails to start**:

```sh
cd dsh-dynplugin-manager
npm install
cd ..
```

> `peerDependencies` (`@deepseek-ai/cordis`, `react`) are provided by the DSH host — do not install locally.

### 2. Add the plugin

```sh
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

Restart `dsh web` → Settings → Dynamic Plugins.

## Plugin discovery (built-in, no directory config)

| Source | Location | Notes |
|---|---|---|
| runner managed dir | `~/.dsh/dynplugin-manager/plugins/` | self-contained plugins install here (dialog "install to managed dir"); listed after restart (loading stays session-scoped) |
| profile node_modules | `~/.dsh/profiles/<profile>/node_modules/` | non-bundle packages whose entry exports `apply` appear automatically (link or npm installed) |
| legacy scan dirs | user-configured | kept for backward compatibility |

## Install dialog

**Install Plugin** button → pick a source:

| Source | Scan | Install modes |
|---|---|---|
| Local dir | the dir itself or first-level subdirs | loader: **link** (edits apply after restart) / **copy** (independent copy; reinstall to pick up source edits); runner: managed-dir copy |
| GitHub repo | zip download to `~/.dsh/dynplugin-manager/cache/` → extract → scan (monorepo supported) | same as local dir (copy semantics) |
| npm package | registry metadata → single-package card | copy install |

The dialog **blocks other input** while installing; results show per candidate (failures include the reason and a manual command); loader plugins can be **mounted immediately** (verify-before-persist: real import + apply must pass before the insert row is written — failures leave zero residue).

## Loading & lifecycle

| Command | Action | Persistence |
|---|---|---|
| `/dynload <name>` | auto-route: self-contained → runner session-scoped; import-using → loader persistent mount | runner session / loader persistent |
| `/dynunmount <name>` | disable (remove insert row, package kept) | reversible |
| `/dynuninstall <name>` | full removal: row + `dsh plugin remove` (pnpm reference counting keeps shared deps) + managed copy + records | clean state restored |

## Plugin shapes

- **Self-contained (runner)**: the file is a function body (no import/export, top-level `return { apply }`) — the vm sandbox executes it directly; session-scoped; errors never harm DSH
- **Import-using (loader)**: the entry uses the module system — must be installed (quality gate checks dependency resolvability); mounted only after an in-memory pre-execution passes; **any verification failure writes nothing** (fail-closed)
- **needs-deps**: code imports bare packages the package.json does not declare → blocked with the exact import list; declare them and rescan
- **unbuilt**: entry file missing (e.g. un-compiled TS) → disabled in the dialog; build first

## Difference from the same-named package

There is already a `dsh-plugin-manager` on npm (author hrhgit) — that one manages **bundle plugins** (Loader-entry enable/disable, persisted to cordis.patch.yml). This plugin manages **dynamic plugins** (runner session loading + loader persistent mounting). Different targets, they can coexist.

## Maintenance status

This plugin was authored by **deepseek-v4-flash** (an AI agent). If this notice has not been removed, the author does not actively maintain this plugin. Forks and PRs are welcome.

## License

MIT
