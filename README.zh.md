# dsh-dynplugin-manager

> 管理 DSH 动态插件（Dynamic Cordis Plugins）：内置发现、安装弹窗、加载。社区空白，自研插件。

DSH 动态插件有两条加载通道：

- **runner 通道**（`cordis_define` / `cordis_run`）：**会话级**，代码在 vm 沙箱执行（禁 import/require），进程重启后失效——自包含插件（如 web-access 的函数体形态）走这里
- **loader 通道**（insert 行 + 官方 patch watcher）：**持久**，社区 npm 插件形态（正常 `import`）走这里——写 `cordis.patch.yml` 由官方 watcher 热挂载、免重启

官方只有 agent 工具（模型才能调用），**没有人类可操作的界面**。本插件补齐：

- **设置页"动态插件"**：内置发现（runner 托管目录 + profile 已安装的非 bundle 包 + 历史扫描目录），状态徽标（已加载/未加载/加载失败+原因/缺依赖声明/未构建）
- **安装弹窗**：本地目录 / GitHub 仓库 / npm 包三种来源 → 扫描 → 逐插件选安装方式 → 安装结果即时反馈 → 一键挂载
- **斜杠命令**：`/dynload <插件名>`（自动分流加载）、`/dynunmount`（停用）、`/dynuninstall`（彻底卸载）

## 安装

### ⚠️ 同名包警告

npm 上可能已存在同名包。请始终显式指定本仓库：

```sh
# 从 GitHub 安装
dsh plugin --profile web add -w Thomas-key/dsh-dynplugin-manager

# 或从本地目录安装
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

### 第 1 步：安装运行时依赖（必须！）

本插件以 **link 方式**安装（profile 引用本地目录），Node 从**目录自身**解析 `import`。运行时依赖 `@deepseek-ai/dsh-tools` **不会随仓库分发**（在 `node_modules/`，被 .gitignore 排除）——**必须先**在本地仓库装好，否则 `dsh web` **启动即崩**：

```sh
cd dsh-dynplugin-manager
npm install
cd ..
```

> `peerDependencies`（`@deepseek-ai/cordis`、`react`）由 DSH 宿主提供，不需要本地安装。

### 第 2 步：添加插件

```sh
dsh plugin --profile web add -w ./dsh-dynplugin-manager
```

重启 `dsh web` 后：设置 → 动态插件。

## 插件发现（内置，无需配置目录）

| 来源 | 位置 | 说明 |
|---|---|---|
| runner 托管目录 | `~/.dsh/dynplugin-manager/plugins/` | 自包含插件安装到这里（弹窗「安装到托管目录」），重启后仍在列表（加载是会话级） |
| profile 已安装包 | `~/.dsh/profiles/<profile>/node_modules/` | 非 bundle + 入口导出 `apply` 的包自动出现（link 或 npm 安装均可） |
| 历史扫描目录 | 用户自配 | 向后兼容保留 |

## 安装弹窗

**安装插件** 按钮 → 选择来源：

| 来源 | 扫描方式 | 安装方式 |
|---|---|---|
| 本地目录 | 目录本身或一层子目录 | loader：**link**（改源码重启即生效）/ **copy**（独立副本，改源码需重装）；runner：托管目录复制 |
| GitHub 仓库 | 下载 zip 到 `~/.dsh/dynplugin-manager/cache/` → 解压 → 扫描（支持 monorepo） | 同本地目录（copy 语义） |
| npm 包 | registry 元数据 → 单包卡片 | copy 安装 |

安装时弹窗**阻塞其他输入**；完成后显示结果（失败给出原因 + 手动命令），loader 插件可**立即挂载**（验证先于写入：真实 import + apply 通过才写 insert 行，失败零残留）。

## 加载与生命周期

| 命令 | 动作 | 持久性 |
|---|---|---|
| `/dynload <插件名>` | 自动分流：自包含 → runner 会话级；需 import → loader 持久挂载 | runner 会话级 / loader 持久 |
| `/dynunmount <插件名>` | 停用（删 insert 行，包保留） | 可逆 |
| `/dynuninstall <插件名>` | 彻底移除：删行 + `dsh plugin remove`（pnpm 引用计数保留共享依赖）+ 删托管副本 + 清记录 | 依赖图恢复干净；`.pnpm` 物理残留可手动 `dsh plugin --profile web prune` 回收（勿自动 prune——会误删用户手动安装的包） |

## 插件形态说明

- **自包含（runner）**：文件是函数体（无 import/export，顶层 `return { apply }`）——vm 沙箱直接执行，会话级，怎么报错都不影响 DSH
- **需 import（loader）**：入口用模块系统——必须已安装（质量门检查依赖可解析），挂载前内存预执行验证，**任何验证失败都不写配置**（fail-closed）
- **缺依赖声明**：代码 import 了裸包但 package.json 没声明 → 拦截并列出包名，补声明后重扫
- **未构建**：入口文件缺失（如 TS 未编译）→ 置灰，先构建

## 与同名包的区别

npm 上已有 `dsh-plugin-manager`（作者 hrhgit）——那是**管理 bundle 插件**（Loader 条目启停、持久化到 cordis.patch.yml）的工具。本插件管的是**动态插件**（runner 会话级加载 + loader 持久挂载）。二者定位不同、可共存。

## 维护状态

本插件由 **deepseek-v4-flash**（AI agent）制作。如果这句话没有被删除，说明作者不会主动维护此插件。欢迎 fork 和 PR。

## License

MIT
