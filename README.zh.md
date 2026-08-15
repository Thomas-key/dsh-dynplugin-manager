# dsh-dynplugin-manager

> 管理 DSH 动态插件（Dynamic Cordis Plugins）：指定目录扫描、浏览、加载。社区空白，自研插件。

DSH 的动态插件有两条加载通道：

- **runner 通道**（`cordis_define` / `cordis_run`）：**会话级**，代码在 vm 沙箱执行（禁 import/require），进程重启后失效
- **loader 通道**（insert 行 + 官方 patch watcher）：**持久**，社区 npm 插件形态（正常 `import`），改 `cordis.patch.yml` 由官方 watcher 热挂载、免重启

官方只有 agent 工具（模型才能调用），**没有人类可操作的界面**。本插件补齐这个空缺，并统一为一条命令：

- **设置页"动态插件"**：管理扫描目录（可添加多个）、浏览扫描到的插件（名称 + 描述 + README + 状态/通道徽标）、打开插件源目录
- **斜杠命令 `/dynload <插件名>`**：按插件形态**自动分流**——自包含 → runner 会话级加载；需 import → loader 持久挂载
- **斜杠命令 `/dynunmount <插件名>`**：移除 loader 挂载（精准删 managed 块）
- **只读管理**：管理页只浏览，加载一律走斜杠命令

## 安装

### ⚠️ 同名包警告

npm 上可能已存在或将来出现**同名包**（其他作者发布）。直接按裸包名安装可能装到错误的包。请始终显式指定本仓库：

```sh
# 从 GitHub 安装
dsh plugin --profile web add -w Thomas-key/dsh-dynplugin-manager

# 或从本地目录安装
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

### 第 1 步：安装运行时依赖（必须！）

本插件以 **link 方式**安装（profile 引用本地目录），Node 从**目录自身**解析 `import`。运行时依赖 `@deepseek-ai/dsh-tools` **不会随仓库分发**（它在 `node_modules/`，被 .gitignore 排除）——**必须先**在本地仓库装好，否则 `dsh web` **启动即崩**，报 `ERR_MODULE_NOT_FOUND`：

```sh
cd dsh-dynplugin-manager
npm install          # 把 @deepseek-ai/dsh-tools 装进 ./node_modules
cd ..
```

> `peerDependencies`（`@deepseek-ai/cordis`、`react`）由 DSH 宿主提供——不需要本地安装。

### 第 2 步：添加插件

```sh
dsh plugin --profile web add -w ./dsh-dynplugin-manager   # 本地安装（link）
```

重启 `dsh web` 后：设置 → 动态插件 → 添加扫描目录 → 会话里输入 `/dynload <插件名>`。

## 扫描规范（重要）

扫描器**只扫一层**：用户指定目录下的每一个**第一层子文件夹**。

### 判定

一个文件夹要被识别为插件，必须同时满足：

1. **有 `package.json`**（无则跳过，不扫描不显示）
2. **有 `name` 字段**（无则跳过）
3. **不是 bundle 插件**（声明了 `dsh.bundle.patch` 的跳过——那些归 `dsh plugin add` 管）

```text
扫描目录/
├── web-access/          ← ✓ 有 package.json，非 bundle，是插件
│   ├── package.json
│   ├── plugin/index.js  ← 入口（dsh.dynamic.host 声明）
│   └── README.md
├── dsh-emoji/           ← ✗ 声明了 dsh.bundle，跳过（bundle 插件）
│   └── package.json
├── 随便放的文件夹/       ← ✗ 没有 package.json，跳过
│   └── index.js
```

### 入口定位（不要求作者写字段）

入口文件按 **Node 模块解析规则**推断，优先级：

1. `dsh.dynamic.host`（我们的字段，写了优先）
2. `main`（package.json 标准字段）
3. `exports["."]`（含 `{ default }` 形态）
4. 兜底 `index.js`

推断出的文件**必须真实存在**才算 `ready`；文件缺失（如未构建的 TS 仓库）标 **「未构建」**，加载时给出提示。

### 通道判定

读入口文件头部（8KB）嗅探：含 `import` / `require` → **loader 通道**（需 import 的社区 npm 插件形态）；否则 → **runner 通道**（自包含，web-access 形态）。

| 通道 | 代码形态 | `/dynload` 行为 | 持久性 |
|---|---|---|---|
| runner | 自包含（无 import/require） | 会话级加载 | 重启消失 |
| loader | 正常 import（社区 npm 插件） | 写 managed insert 行，官方 watcher 热挂载 | **持久** |

### 加载 npm 默认安装的非 bundle 插件

把 `~/.dsh/profiles/<profile>/node_modules` 加为扫描目录即可——npm 装好的非 bundle 包会被自动识别（入口已构建、依赖树完整），直接 `/dynload <包名>` 挂载。

### loader 通道前置要求

`/dynload` 走 loader 通道时，包必须**已安装进当前 profile**（`dsh plugin add -w <目录>` 或 `dsh plugin add <包名>`）——insert 行的 `name` 是包名，loader 从 profile 的 node_modules 解析。未安装会得到明确提示。

### 名称冲突消歧

同一扫描范围（所有已添加目录）内，插件显示名取自 `package.json` 的 `name`。冲突时按以下规则消歧：

1. 先扫到的保持原名
2. 冲突的**逐级加父文件夹名**：`test2/插件1`（注意：文件夹层级间用 `/`）
3. 父文件夹加到头（盘符根）仍冲突 → 说明是同一份文件（同名同路径），按重复处理，只显示一次

```text
c:/user/test1/插件1/package.json      → 显示名：插件1
c:/user/test1/test2/插件1/package.json → 显示名：test2/插件1（因 插件1 已被占用）
```

### 插件作者模板

非 npm 形态（本地源码目录）的插件，无 package.json 时**按模板手动补一份**即可被扫描（补到 `name` + `main` 即可，`dsh.dynamic.host` 可选）：

```json
{
  "name": "my-plugin",
  "type": "module",
  "description": "一句话描述（可选）",
  "main": "index.js",
  "dsh": { "dynamic": { "host": "index.js", "client": "client.js" } }
}
```

## 与同名包的区别

npm 上已有 `dsh-plugin-manager`（作者 hrhgit）——那是**管理 bundle 插件**（Loader 条目启停、持久化到 cordis.patch.yml）的工具。本插件管的是**动态插件**（会话级、代码体加载 + loader 挂载），二者定位不同、可共存。

## 维护状态

本插件由 **deepseek-v4-flash**（AI agent）制作。如果这句话没有被删除，说明作者不会主动维护此插件——它是为补上"DSH 动态插件无人可操作界面"的空白而做的，能用就行，不计划更新。欢迎 fork 和 PR。

## License

MIT
