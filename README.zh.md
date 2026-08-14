# dsh-dynplugin-manager

> 管理 DSH 动态插件（Dynamic Cordis Plugins）：指定目录扫描、浏览、加载。社区空白，自研插件。

DSH 的动态插件（`cordis_define` / `cordis_run`）是**会话级**机制：存在于当前会话，进程重启后失效。官方只有 agent 工具（模型才能调用），**没有人类可操作的界面**。本插件补齐这个空缺：

- **设置页"动态插件"**：管理扫描目录（可添加多个）、浏览扫描到的插件（名称 + 描述 + README）、打开插件源目录
- **斜杠命令 `/dynload <name>`**：在任意会话直接加载动态插件，不经过 agent
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

重启 `dsh web` 后：设置 → 动态插件 → 添加扫描目录 → 会话里输入 `/dynload <插件名>`（或 `/dyn-<插件名>`）。

## 扫描规范（重要）

扫描器**只扫一层**：用户指定目录下的每一个**第一层子文件夹**。

### 判定：必须有 package.json

一个文件夹要被识别为动态插件，**必须包含 `package.json`**，否则直接跳过（不扫描、不显示）。

```text
扫描目录/
├── web-access/          ← ✓ 有 package.json，是插件
│   ├── package.json
│   ├── plugin/index.js  ← 代码体
│   └── README.md
├── 随便放的文件夹/       ← ✗ 没有 package.json，跳过
│   └── index.js
└── 普通项目/            ← ✗ 没有 package.json，跳过
```

### package.json 必要字段

| 字段 | 要求 |
|---|---|
| `name` | **必须**。没有 `name` 的 package.json 视为无效，跳过 |
| `description` | 可选。有则作为插件描述显示；没有则留空 |
| `dsh.dynamic.host` | **必须**。代码体文件路径（相对 package.json 所在目录），扫描器**不猜测**代码体位置，只认此声明 |

### package.json 必填模板

```json
{
  "name": "my-plugin",
  "description": "一句话描述（可选）",
  "dsh": {
    "dynamic": {
      "host": "plugin/index.js",
      "client": "plugin/client.js"
    }
  }
}
```

- `host` 必填：指向插件代码体文件（纯 JavaScript 函数体，以 `return { apply(ctx) {...} }` 结尾，即官方 cordis_define 的 `code.host`）
- `client` 可选：指向 client 半代码体（对应 `code.client`）；纯 host 插件省略此项

> 没有 `dsh.dynamic.host` 的文件夹**不算插件**，扫描器不会加载它。从社区 clone 的插件若 package.json 没有此字段，手动补上（参考上面的模板）即可被扫描。

> 没有 package.json 的插件文件夹：**手动创建一个**，至少写上 `name` + `dsh.dynamic.host` 即可被扫描。

示例（最小可用）：

```json
{
  "name": "my-plugin"
}
```

> 没有 package.json 的插件文件夹：**手动创建一个**，至少写上 `name` 即可被扫描。

### 名称冲突消歧

同一扫描范围（所有已添加目录）内，插件显示名取自 `package.json` 的 `name`。冲突时按以下规则消歧：

1. 先扫到的保持原名
2. 冲突的**逐级加父文件夹名**：`test2/插件1`（注意：文件夹层级间用 `/`）
3. 父文件夹加到头（盘符根）仍冲突 → 说明是同一份文件（同名同路径），按重复处理，只显示一次

```text
c:/user/test1/插件1/package.json      → 显示名：插件1
c:/user/test1/test2/插件1/package.json → 显示名：test2/插件1（因 插件1 已被占用）
```

### 代码体定位

`/dynload <name>` 加载时，**只读 `dsh.dynamic.host` / `dsh.dynamic.client` 声明的文件**，不做任何猜测。加载前仍会用官方 precheck（语法编译 + 插件形状校验）确认，校验不过则报错提示。

## 与同名包的区别

npm 上已有 `dsh-plugin-manager`（作者 hrhgit）——那是**管理 bundle 插件**（Loader 条目启停、持久化到 cordis.patch.yml）的工具。本插件管的是**动态插件**（会话级、代码体加载），二者定位不同、可共存。

## 维护状态

本插件由 **deepseek-v4-flash**（AI agent）制作。如果这句话没有被删除，说明作者不会主动维护此插件——它是为补上"DSH 动态插件无人可操作界面"的空白而做的，能用就行，不计划更新。欢迎 fork 和 PR。

## License

MIT
