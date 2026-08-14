# dsh-dynplugin-manager

> Manage DSH dynamic plugins (Dynamic Cordis Plugins): scan directories, browse, load. Community gap — self-built plugin.

DSH dynamic plugins (`cordis_define` / `cordis_run`) are **session-scoped**: they live in the current session and are lost when the process restarts. Officially they are only reachable through agent tools (model-invoked) — **no human-operable UI exists**. This plugin fills that gap:

- **Settings page "动态插件" (Dynamic Plugins)**: manage scan directories (add multiple), browse scanned plugins (name + description + README), open plugin source directories
- **Slash command `/dynload <name>`**: load a dynamic plugin directly in any session, without going through an agent
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

After restarting `dsh web`: Settings → Dynamic Plugins → add a scan directory → type `/dynload <plugin-name>` (or `/dyn-<plugin-name>`) in a session.

## Scan spec (important)

The scanner only looks **one level deep**: every **first-level subdirectory** of a user-specified directory.

### Rule: package.json required

For a folder to be recognized as a dynamic plugin, it **must contain `package.json`**; otherwise it is skipped (not scanned, not shown).

```text
scan-dir/
├── web-access/          ← ✓ has package.json, it's a plugin
│   ├── package.json
│   ├── plugin/index.js  ← code body
│   └── README.md
├── random-folder/       ← ✗ no package.json, skipped
│   └── index.js
└── plain-project/       ← ✗ no package.json, skipped
```

### Required package.json fields

| Field | Requirement |
|---|---|
| `name` | **Required.** A package.json without `name` is invalid and skipped |
| `description` | Optional. Shown as the plugin description when present; empty otherwise |
| `dsh.dynamic.host` | **Required.** Path to the code-body file (relative to the package.json directory). The scanner **never guesses** where the code body is — it only trusts this declaration |

### Required package.json template

```json
{
  "name": "my-plugin",
  "description": "One-line description (optional)",
  "dsh": {
    "dynamic": {
      "host": "plugin/index.js",
      "client": "plugin/client.js"
    }
  }
}
```

- `host` required: points to the plugin code body (plain JavaScript function body ending in `return { apply(ctx) {...} }` — i.e. the official `cordis_define` `code.host`)
- `client` optional: points to the client-half code body (the `code.client`); omit for host-only plugins

> A folder without `dsh.dynamic.host` is **not a plugin** and the scanner will not load it. For plugins cloned from the community whose package.json lacks this field, add it manually (see the template above) and it becomes scannable.

> For a plugin folder without package.json: **create one manually** — `name` + `dsh.dynamic.host` is the minimum for it to be scanned.

### Name-collision disambiguation

Within the full scan scope (all added directories), the display name comes from `package.json` `name`. On collision:

1. The first scanned keeps its original name
2. Colliding ones **prepend parent folder names level by level**: `test2/插件1` (folder levels joined with `/`)
3. If collision persists all the way up to the drive root → it is the same file (same name + same path), treated as a duplicate and shown once

```text
c:/user/test1/插件1/package.json       → display name: 插件1
c:/user/test1/test2/插件1/package.json  → display name: test2/插件1 (because 插件1 is taken)
```

### Code-body location

`/dynload <name>` reads **only** the files declared by `dsh.dynamic.host` / `dsh.dynamic.client` — no guessing. Before loading, the official precheck (syntax compile + plugin-shape validation) still runs; on failure the load errors out with the reason.

## Difference from the same-named package

There is already a `dsh-plugin-manager` on npm (author hrhgit) — that one manages **bundle plugins** (Loader-entry enable/disable, persisted to cordis.patch.yml). This plugin manages **dynamic plugins** (session-scoped, code-body loading). Different targets, they can coexist.

## Maintenance status

This plugin was authored by **deepseek-v4-flash** (an AI agent). If this notice has not been removed, the author does not actively maintain this plugin — it was built to fill the gap of "DSH dynamic plugins have no human-operable UI" and works as-is. No updates are planned as long as it keeps working. Forks and PRs are welcome.

## License

MIT
