# Jira 工作台接手与维护指南

更新日期：2026-10-09，时区 Asia/Shanghai。供换设备继续开发、测试和维护的本人、协作者及后续 AI 助手读取。

Jira 工作台是个人本地运行的 Jira、JXL Sheets 和 SVN 工具，采用共享业务核加宿主适配层。当前 DSH 和既有 Codex 路径已经发布，新的 Codex 原生接入仍是开发预览。本轮要求是保存并同步工程，**暂不发布，不替换旧适配器**。

Git 能恢复代码、测试和文档，不能单独恢复 Jira 凭据、宿主会话、项目绑定、安装状态和 SVN 工作副本。新设备先建立开发环境，再选择一种宿主安装，最后分项验收。

常用入口：[快速接手](#快速接手)、[制作进度](#制作进度与剩余工作)、[DSH 安装](#dsh-安装与维护)、[既有 Codex 安装](#既有-codex-安装与维护)、[原生预览](#codex-原生预览安装与验收)、[数据迁移](#换设备的数据与凭据)、[发布流程](#发布流程)。

## 快速接手

### 新设备先执行这四步

准备 Git、Node.js 和 npm。为兼顾 DSH，建议 Node 22.19.x 或 24 及以上版本，不使用 Node 23。Windows 安装及发布脚本需要 PowerShell。

```powershell
git clone https://github.com/yzj555/jira-workbench.git
Set-Location .\jira-workbench
npm ci
npm test
```

已经拉过仓库时，先检查 `git status --short` 并保留修改，再 `git pull --ff-only`；不要强制重置。开发依赖用仓库根的 npm 和 `package-lock.json`，不把本仓库改成 pnpm workspace。`pnpm` 是 DSH 插件管理另需的工具。

接着选一条路径，不同时执行所有安装：

| 目标 | 接下来阅读 | 影响 |
| --- | --- | --- |
| 了解或开发工程 | 本文架构、进度和后续任务 | 准备依赖、测试，不安装生产插件 |
| 使用已发布 DSH | 本文 DSH 安装流程 | 修改所选 DSH profile 的依赖和 bundle |
| 使用既有 Codex | 本文既有 Codex 安装流程 | 安装程序、CLI、插件和快捷方式 |
| 验收 Codex 原生预览 | 本文原生预览流程 | 隔离探针与实际首次安装分别执行 |
| 发布新版本 | 本文发布流程 | 仅在再次得到发布授权后执行 |

接手完成的标志：测试退出码为 0；确认实际宿主版本、数据根和启动入口；重新配置 Jira 并先验只读任务、Filter、Sheet；继续原生迁移前读[迁移记录](codex-native-migration.md)和[实机验收记录](codex-native-acceptance.md)。

## 当前代码与发布状态

以下为 2026-10-09 快照，不代表以后拉取时的最新状态。业务代码基线为 [`240dfa9`](https://github.com/yzj555/jira-workbench/commit/240dfa9506326df964b2731998d59bfc2b477c19)。

| 项目 | 当前事实 | 接手含义 |
| --- | --- | --- |
| `main` 源码 | 统一版本仍为 `0.33.8`，已加入原生预览和修复 | 与已发布包版本号相同但内容不同，以 commit 区分 |
| GitHub Release | [`v0.33.8`](https://github.com/yzj555/jira-workbench/releases/tag/v0.33.8)，正式发布，基于 `b612729` | 不包含后续原生预览改造 |
| npm 正式包 | Core、DSH Client、DSH Host 的公开 registry 最新版均为 `0.33.8` | 普通 DSH 用户只安装 Host，新源码改动未随之发布 |
| 新 Codex 原生包 | `@jira-workbench/codex-client` 未发布，registry 查询为 404 | 不能用 npm / npx 安装，也没有正式 npm source 安装承诺 |
| 本地全量回归 | 主测试 328、DSH Client 10、原生 87，共 425 项通过 | 自动化回归，不等同真实宿主验收 |
| GitHub CI | [`240dfa9` 的 CI](https://github.com/yzj555/jira-workbench/actions/runs/37877486260) 成功 | 主分支推送未触发 Release |
| 旧机原生预览 | 仍安装 2026-10-08 构建，用户确认插件出现且工作台能打开 | 2026-10-09 的设置、刷新、附件、SVN 新代码未覆盖缓存 |

**目前不要重推 `v0.33.8`，不要覆盖同版本 npm，不把新原生包加入正式发布范围。** 查询未来实际状态：

```powershell
git log -5 --oneline
git status --short --branch
npm view @jira-workbench/dsh version --registry=https://registry.npmjs.org/
npm view @jira-workbench/core version --registry=https://registry.npmjs.org/
npm view @jira-workbench/dsh-client version --registry=https://registry.npmjs.org/
```

有已登录的 GitHub CLI 时可用 `gh release view v0.33.8`、`gh run list --limit 5`。企业镜像晚于官方 registry 不一定是发布失败。`git pull` 不更新已安装的 npm 包或 Codex 插件缓存。

## 产品规则和交互约束

这是每位用户配置自己的 Jira Data Center PAT 的本地工具，不是服务器插件或多人共用业务服务；当前不提供 Jira Cloud 切换。

- **执行单与需求上下文分开。** 子单是绑定、流转和提交的对象；需求可同时来自父子单及各自附件。父单不可读时说明缺口，不阻断子单、不覆盖子单字段。
- **会话与项目独立绑定。** 一个 Jira 可关联多个目录；每次处理 / SVN 选明确目录。解除会话不删除项目。SVN 不依赖会话存在。
- **服务端为唯一状态源。** 绑定使用 revision 并发校验，不以浏览器 `localStorage` 作为第二份事实。
- **创建成功再关联和导航。** 创建、首条消息接受、绑定保存和导航不能互相冒充回执；失败要恢复操作、不长期阻塞、不自动重复创建。
- **主工作区布局稳定。** 面板与会话同级、区域尽量撑满；操作区保持可见。设置同页打开、左侧锚点导航，不跳到会话侧边浏览器。
- **有色彩但不杂乱。** 需求、Bug、主操作和风险有语义色；少用大框套小框和纯线框按钮。下拉入口、选中回写、自动收起和圆角统一。
- **浮窗只放最小上下文。** DSH 摘要栏靠右、Session log 左侧附近作为入口，紧凑侧边浮窗不复制完整详情 / SVN。
- **附件要能真正预览。** 原图、左右切换、放大；文档尽量复用首次下载。原生 Codex 的本地下载再打开仍未迁入，链接导航不等于下载完成。
- **SVN 交互一致。** 单击文件选中并预览，不重复比较同一文件；双击 TortoiseSVN；遮罩只覆盖差异区，独立和详情入口布局一致。

这些是后续设计约束，不是所有宿主已完整验收的承诺。

## 架构与目录

```text
packages/core                   共享 Jira、JXL、附件、绑定与 SVN 规则
    ↑                               ↑                         ↑
packages/codex                packages/dsh             packages/codex-client
既有 Windows 混合接入         DSH 进程内 Host            Codex 原生开发预览
Plugin、App Server、CDP        credentials、approval    官方 Plugin / MCP Apps
安装、更新、Bug 监控           session/workspace        STDIO 薄桥与单实例 Core
                                    ↑
                             packages/dsh-client
                             DSH 原生浏览器入口与布局
```

| 路径 | 职责 | 修改注意 |
| --- | --- | --- |
| `packages/core/index.mjs` | `createCoreService`、数据路径、provider 注入 | 不依赖宿主私有对象 |
| `core/jira-client.mjs`、`jxl-client.mjs` | Jira、项目 / Filter、JXL 目录和表格 | 用户权限、目录缺失与行数截断分开 |
| `packages/core/lib/` | 绑定、流转、附件和 SVN 状态机 | revision、快照、一次性令牌与对账不削弱 |
| `core/mcp/jira-task-board-mcp.mjs` | 中性工具、MCP 注册与宿主扩展 | DSH 使用中性定义，原生注入资源和元数据 |
| `core/mcp/ui/task-board.html` | 共享业务 UI | 改动影响多宿主，需对应回归 |
| `packages/codex/` | 正式混合路径、App Server、注入、更新与维护 | 不与原生预览混称 |
| `packages/dsh/plugin.mjs`、`lib/` | DSH provider、会话、分析、同源 API | 修复适配包，不修改 DSH 工程 |
| `packages/dsh-client/src/` | DSH React / TypeScript UI | 输出 `lib/client.js`，改源码后重建 |
| `packages/codex-client/lib/` | 原生设置、能力状态、UI、运行时与桥 | 不加 CDP / DOM 兜底或伪造会话能力 |
| `packages/codex-client/ui/` | 设置、同步和样式 | UI 只经官方桥，不直接连后台 HTTP |
| `scripts/` | npm 发布、原生探针、首次安装与导入 | 准备、安装、导入、发布分开 |
| `.github/workflows/` | 主分支 CI 与 tag 发布 | 推送 `v*` 会发布，不是默认草稿 |
| `docs/` | 接手、原生迁移和实机验收 | 更新事实和证据，不只写百分比 |

表中 `core/...` 是 `packages/core/...` 的简写。Core 业务逻辑维护一份；新增宿主优先 provider / 扩展点，必要的 Core 合同改动须兼容旧行为并补测试。

既有 Codex 由受管快捷方式启动桌面、本地服务与最小注入宿主，Plugin / MCP Apps 承载业务，App Server 处理会话等能力。DSH 在宿主进程内组装 Core，不启动 Codex 的 `47823` / `47824`。

原生 Codex 运行链：官方 Plugin → MCP Apps 桥 → STDIO 薄桥 → 认证 loopback → 单实例 Core。每个 STDIO 不另建状态；最后连接关闭后，等待租约、请求、工具及 SVN 操作结束再退出。

官方扩展提供侧栏和会话面板入口；npm source 下载不运行安装生命周期脚本，因此包须预构建完整。声明入口不等于本工程已取得真实会话身份或完成桌面验收。[OpenAI 扩展说明](https://developers.openai.com/plugins/build/extensions)、[插件打包说明](https://developers.openai.com/plugins/build/plugins)。

## 制作进度与剩余工作

Core 已共享 Jira / JXL、父子单、附件、独立多目录、流转和 SVN。DSH 原生项目、会话创建关联、模板 / Skill、中心工作区和浮窗已接入，DSH 0.2 适配进入 `0.33.8` 正式版。既有 Codex 仍提供兼容层、会话、Bug 监控和自更新；不能因原生面板能打开而删除。

| 能力 | DSH 正式路径 | Codex 原生预览 |
| --- | --- | --- |
| 任务、历史、Sheet、父子单 | 已接入，受权限约束 | 协议和只读抽样通过，业务 UI 待验 |
| 项目目录候选 | workspace registry | 手工配置，`projectCatalog: false` |
| 会话目录与关联 | session query/controller | 未实现，`sessionContext / conversationBinding: false` |
| 新建并绑定 | 已接入，保存后导航 | `conversationCreation: false` |
| Skill | 项目作用域 Skill | `skills: false` |
| 设置、来源、模板 | 已接入 | 新代码已实现，待安装验收 |
| 图片预览 | 原图、切换、放大 | 去重、缓存、原始尺寸已补，实机待验 |
| 图片模型与文本降级 | 原图模型优先，视觉 / OCR / 未解析兜底 | 尚未完成等价宿主路由 |
| 文档本地下载再打开 | Core 缓存链路 | 未迁入，当前官方链接在 Jira 查看 |
| SVN | 人工审核、安全复检与审批 | 复用 Core、多目录校验已补，实机待验 |
| 任务列表自动刷新 | 已有宿主 UI 路径 | 新代码 `taskAutoRefresh: true`，只读可见面板刷新 |
| 后台 Bug、自更新 | 初版不挂载 | `automation / automaticUpdates: false` |

DSH 精确适配 `0.2.0-rc.2`，不承诺任意最新版或整个 `0.2.x` 兼容。DSH 会话语义审查 provider 还未实现，当前安全降级为人工审核。

### 原生最近完成

- 自包含插件、global / thread / settings、独立数据根、单实例运行时。
- 设置连接、Jira 项目 / Filter、模板和任务同步；保存有 hash revision、PAT 不回显。
- 选项仅用保存凭据，45 秒整体取消预算、UI 55 秒；单飞、保留未知已选 ID、错误脱敏。
- 配置变更清旧缓存；自动刷新遇详情、设置、SVN、输入、隐藏暂停，失败退避、迟到回复丢弃。
- 原图请求去重、4 项缓存、原始尺寸；父单 / 文档用官方导航。
- 独立 SVN 入口补目录上下文，同 Jira 跨目录不沿用错误审核；确认时快照变化取消，不重试提交。
- 版本、打包、安装和导入回归纳入全量测试，原生包仍不进入正式发包清单。

用户只确认旧预览插件与全局工作台可打开，设置、thread、入口位置和新构建仍待验。模拟宿主截图不是实际桌面验收。

### 下一轮处理顺序

1. **受控更新预览。** 当前安装器只支持首次安装 / 同构建复检，拒绝不同 hash 覆盖。补备份、更新、旧运行时退出、恢复边界，不复制活动缓存或绕过保护。
2. **验新 UI。** 官方桌面验设置回写、Filter、刷新、Sheet 完整目录、图片、独立 SVN、多目录。
3. **补可信宿主合同。** 会话身份、创建回执、项目和 Skill。App Server / 用户信任的 Hooks 可研究，但独立客户端、匿名 session、最后触发会话或深链不能冒充当前桌面会话。
4. **补等价缺口。** 文档下载、图片路由、关联浮窗和自动化边界；不永久隐藏功能后宣称完成。
5. **验干净安装再发布。** 原生 npm source、三入口和关键流程通过后决定包及 Marketplace 分发。
6. **最后切换退役。** 数据迁移、备份、回滚、回归和用户确认齐全后才退出旧注入。

不再以“92% 可用”等估计代替证据；分别记录代码、隔离验证、实机和发布。

## DSH 安装与维护

### 普通用户安装正式版

前提：DSH `0.2.0-rc.2` 可启动，`pnpm` 和 SVN 1.8+ 在 PATH，具备 Jira 根地址、PAT 和工作副本权限。先正常停止 DSH Web。

```powershell
dsh plugin --profile web add @jira-workbench/dsh@0.33.8
dsh web
```

可省略固定版本后缀，但安装当时 registry 的版本前需核对兼容性。Host 自动带同版本 Core / Client，不单独装另两包。

用终端输出的完整启动地址进入“插件 → Jira 工作台 → 配置”，填写 Jira 根地址和 PAT；不要只输入端口。工作台内设置负责来源、模板、Skill、图片模型。先在 DSH 添加项目，再在 Issue 处理上下文选项目和会话。

`--profile web` 选择依赖与 bundle 的 profile，`dsh web` 启动它。**profile 不隔离工作台数据**：同一 `DSH_HOME` 的多个 profile 默认共用 `$DSH_HOME/jira-workbench`，测试 profile 不是独立业务环境。

```powershell
dsh plugin --profile web why @jira-workbench/dsh
dsh plugin --profile web why @jira-workbench/core
dsh plugin --profile web why @jira-workbench/dsh-client
```

三包必须同版本。镜像过旧时，本次安装可加 `--registry=https://registry.npmjs.org/`，不必改全局设置。

### 图片与分析消息

当前会话模型支持图片时，首条消息发送原图并附文件名和 Jira 来源，不把解析结果堆入文本。文本模型遇图片时，优先让这个新 Jira 会话使用配置的图片模型并直接发送原图；该会话保留图片模型，未来新会话的默认模型恢复，不修改 DSH 工程。

无法安全切换或宿主仍拒绝图片时，再尝试配置的视觉模型生成结构化说明、本地 OCR、明确“图片未解析”的兜底。没有配置视觉模型也可以创建会话，但只能使用可用的 OCR 或未解析提示，不能声称理解图片。成功结果按附件 ID 和文件 SHA-256 缓存，失败不长期缓存。原生 Codex 不因 DSH 已有这条链路而自动具备同等能力。

### 从源码验当前 main

先正常停止 DSH Web，在 Workbench 根目录完成 `npm ci` 后：

```powershell
npm run test:dsh-client
$workbenchRoot = (Resolve-Path '.').Path.Replace('\', '/')
dsh plugin --profile web add `
  "link:$workbenchRoot/packages/core" `
  "link:$workbenchRoot/packages/dsh-client" `
  "link:$workbenchRoot/packages/dsh"
dsh web
```

三包须同 checkout；link 目录不能移动 / 删除。Host / Core 修改后重启，Client 修改先构建再重启和浏览器刷新。

只有源码 DSH CLI 时，到已准备好的 DSH 根目录将 `dsh` 换成 `pnpm dsh`；`$workbenchRoot` 仍指 Workbench。不修改 DSH 源码、手工复制 patch 或创建 junction。

### 升级回滚与卸载

停止 DSH 后，用 `dsh plugin --profile web add @jira-workbench/dsh@<目标版本>` 明确选择已发布且兼容的版本，随后启动和核对三包。`update` 遵守保存范围，不保证固定版本跨范围升最新。

普通 registry 安装用 `dsh plugin --profile web remove @jira-workbench/dsh`。源码三 link 是三个直接依赖，完整移除：

```powershell
dsh plugin --profile web remove @jira-workbench/dsh @jira-workbench/dsh-client @jira-workbench/core
```

正常卸载保留业务数据和 credentials，不通过删数据根修依赖。Release ZIP 含源码和 Client 产物，不含全部第三方依赖；真正离线还需预置依赖 / 包管理缓存、DSH 环境，单靠解压和 link 不保证运行。详见[DSH 安装手册](../packages/dsh/INSTALL.md)。

源码 link 切回 registry 时，先正常停止 DSH、在同 profile 移除三个直接 link，再只安装发布版 Host；否则同版本号的 Core / Client 可能仍从源码目录加载。用 `why` 同时检查版本和来源，不只看版本数字。

## 既有 Codex 安装与维护

这是 `packages/codex` 正式混合路径，不是原生预览。需要 Windows Store Codex、PowerShell、Node/npm，SVN 另需当前用户认证。

完整仓库或已校验 Release 解压根目录执行：

```powershell
& .\packages\codex\installer\lifecycle.ps1 -Action Auto -LaunchAfterInstall:$false
```

安装器准备独立官方 npm CLI、生产依赖、插件、服务和快捷方式，有联网、程序和配置写入。仅阅读项目不要运行安装；正式 ZIP 已有 Client 产物，不要求普通用户编译前端。

`-InstallCodexCli:$false` 只禁止自动装 CLI，**仍需可用独立 CLI 和 Plugin 注册**。当前缺 CLI 会安装失败，不能称为成功后降级。运行时可以优先发现桌面配套 CLI，与安装前置条件分别核对。

保存任务、正常退出旧 Codex 后，用安装器创建的“Codex”快捷方式启动并重新配置 Jira。Store 原始入口不启用旧注入侧栏，开发 `start-poc.ps1` 又使用不同 profile，不混用。

```powershell
$maintenance = Join-Path $env:LOCALAPPDATA 'Programs\JiraWorkbench\packages\codex\installer\lifecycle.ps1'
& $maintenance -Action Status
# 明确需要修复再执行；会写文件、依赖和插件注册。
& $maintenance -Action Repair
```

`Status.healthy` 只验安装组件，不证明 Jira、模型或 UI。`Auto` 新机安装、外部新源更新，安装目录内运行可能进菜单。普通卸载保留数据，`Purge` 不可恢复，不用于排错。

更新入口“设置 → 版本更新”：下载校验后自动安装，验证完成等用户确认重启，重启后核对状态。重启失败不等于安装失败；先看验证 / 回滚，SVN 活动中不强杀。

**旧 Codex 的 Purge 会递归清除 `%LOCALAPPDATA%\jira-workbench`。原生预览数据和持久插件源默认也在其中，可能一并删除。换机或修 Token 不执行 Purge。** 详见[既有 Codex 手册](../packages/codex/README.md)。

## Codex 原生预览安装与验收

不从 npm 安装、不修改 Codex 应用本体、不注入、不用旧注入快捷方式。实际首次安装仍会通过官方命令修改配置、注册和缓存，并非零写入。

先在新机初始化 / 登录 Codex，确认目标 `CODEX_HOME` 已存在且与桌面一致，PATH 有 Node、npm 和 `tar`。自定义 home 可传 `--codex-home`，不能使用空测试目录冒充真实桌面配置。旧机验收环境为桌面 `26.1002.7124.0`、后端 CLI `0.162.0-alpha.2`，PATH CLI 另为 `0.147.0`；这些是样本，不是最低版本保证。

先构建和隔离验收：

```powershell
npm run build:codex-client
npm run test:codex-client
npm run probe:codex-client:install -- --codex-executable "<桌面实际使用的 codex.exe 绝对路径>"
```

用新设备实际文件替换路径，不能复制旧机 hash 目录。也可用 `--codex-module "<官方 codex.js 的绝对路径>"`，二者互斥，不能传 `codex.ps1`。PATH CLI 与桌面后端版本可能不同。

探针创建临时 CODEX_HOME、Marketplace 和数据，官方安装后读取缓存 STDIO 与三 UI 资源并清理；不改生产配置、不打开桌面、不创建会话，也不证明 registry 安装 / 桌面渲染。

确定进行**新设备首次安装**后：

```powershell
# 准备持久包，不注册生产插件。
npm run install:codex-client:preview
# 明确首次安装，备份配置并验证缓存。
npm run install:codex-client:preview -- --install --codex-executable "<桌面实际使用的 codex.exe 绝对路径>"
```

已有不同构建会拒绝覆盖，不把它当升级器。源码 build 不更新缓存。插件为 `jira-workbench-native@jira-workbench-native-preview`；直接用输出的 `pluginDetailUrl`，不手拼缺 `marketplacePath` 的本地详情链接。

从原始 Codex 图标检查官方详情、global、settings、thread；如需重载，保存工作后手工正常退出重开。先验设置和只读数据，不用注入页 / 独立浏览器代替。

同机、同 Windows 用户可显式复用能解密的旧配置：

```powershell
npm run import:codex-client:config
# 检查结果并明确选择后：
npm run import:codex-client:config -- --apply
```

默认旧源为 `%LOCALAPPDATA%\jira-workbench\config.json`，通过缓存 STDIO 保存到独立预览数据。只迁兼容连接、来源、模板、同步；不迁 Skill、会话 / 项目、SVN、Webhook、自动监控、模型路由。目标已有效配置则拒绝覆盖。跨机 DPAPI 密文不能用此命令解密。详见[原生安装手册](../packages/codex-client/INSTALL.md)。

## 换设备的数据与凭据

先结束提交 / 分析、关闭服务，私有离线备份。不同机器、宿主或 Core 不共用一个运行数据根。

| 内容 | 默认位置 | 换机处理 |
| --- | --- | --- |
| 旧 Codex 数据 | `%LOCALAPPDATA%\jira-workbench` | 私有留档，按项重建，不整体覆盖 |
| 原生预览数据 | 上述目录下 `codex-native-preview` | 独立备份，新机重新配置 |
| 原生持久源 / receipt | 上述目录下 `codex-native-plugin` | 旧路径 / hash 不复用，新机重新安装 |
| Codex 配置和会话 | 实际 CODEX_HOME / CODEX_SQLITE_HOME，旧 reader 可用 CODEX_SESSIONS_DIR | 按宿主流程恢复，仓库无通用跨机会话导入器 |
| DSH 工作台数据 | `$DSH_HOME/jira-workbench`，默认 `%USERPROFILE%\.dsh\jira-workbench` | 绑定 / 历史留档，credentials 和会话另属 DSH |
| 项目和 SVN 工作副本 | 用户本地绝对目录 | 单独备份未提交 / 未纳管文件，或重新检出 |
| Skill、模型和账号 | 各宿主配置 | 重装或按宿主恢复，重新确认作用域 |

旧机 `F:\my\jira-workbench`、`F:\dsh\deepseek-harness`、`F:\CodexHome` 只是记录，新机不必照建。环境变量覆盖的数据文件按实际路径备份。

### 不直接恢复为活动状态

- `config.json`：Windows PAT / Webhook 用 DPAPI CurrentUser，用户名或 OpenAI 账号相同不保证解密；新机重填。DSH 配置存引用，复制文件不等于复制 PAT。
- `issue-bindings.json`：映射不包含会话；宿主未恢复时重新关联，不能改 threadId 假装成功。
- `issue-workspaces.json`、`svn-baselines.json`：路径、工作副本、revision 有变化时重新绑定扫描。
- `svn-reviews.json`、`attachments/svn-reviews`：保留历史证据，旧快照不当新机有效审核。确认令牌只在内存、90 秒有效、单次使用，重启 / 换机后重新确认。
- `bug-monitor.json`、`automation.json`：可能恢复队列、旧 turn 或推送，新机先关闭监控再审查。
- `update-state.json`、`updates`、`updater`、`.runtime`、安装清单、快捷方式、`codex-profile`：不迁入运行位置。旧更新状态可能自动续装，PID、路径、注册不可靠。
- 原生 `.runtime/endpoint.json`：含 Bearer，不传 Git / 聊天 / 共享文档，新机自动生成。

DPAPI 失败先停服务、私有备份并隔离旧配置，重新录入；只改 Token 也可能被旧密文预读取阻断。没有通用自动跨机迁移脚本，不用 Purge 修凭据。

旧 SVN `committing` / `commit_unknown` 先核对远端日志和实际 revision，**报错不代表未提交，禁止直接重试**。旧改名前 `%LOCALAPPDATA%\jira-codex-panel-poc` 升级可能迁移白名单后删旧目录，先完整备份。

## 开发构建与验证

从仓库根执行，除非另有说明：

| 命令 | 用途 | 边界 |
| --- | --- | --- |
| `npm ci` | 锁文件准备依赖 | 需 registry，依赖可能执行正常安装脚本 |
| `npm test` | 全量回归和客户端构建 | 隔离测试不等同生产 UI |
| `npm run test:dsh-client` | TS、构建、Client 专项 | 生成 `lib/client.js` |
| `npm run test:codex-client` | 原生构建、87 专项 | 生成产物，不更新安装 |
| `npm run build:codex-client` | 自包含运行与 UI | 不是发布 |
| `npm run probe:codex-client:install` | 临时官方安装探针 | 可启动子进程，不改生产配置 |
| `npm run release:npm:verify` | 正式三包 pack dry-run | 先构建，不发布 |
| `node packages/codex/scripts/verify-release-version.mjs v0.33.8` | 当前版本一致性 | 检查依赖、清单、workspace |

既有 Codex probes 位于 `packages/codex`，在该目录或 npm workspace 执行；可启动临时 App Server，不创建消息，但并非无进程副作用。

原生 `dist`、共享 UI 副本 `ui/core-task-board.html`、截图、缓存、tgz 不强加 Git。DSH `lib/client.js` 是交付文件，按现有构建和跟踪策略，不套用原生 ignore。

验收按安装 / 入口 → 设置回写 → 只读列表 / 详情 → 附件 / 目录 / Skill → 明确授权的创建、流转、提交。协议、隔离安装、真实 registry、真实 UI 分别记证据，不以生产提交证明安装。

## 发布流程

### 提交与发布分开

`main` 推送触发 CI；`v*` 标签触发 Release workflow，直接发布 GitHub Release 并继续 npm，不是默认草稿。**本次只提交推送文档，不执行下面发版步骤。**

| 交付 | 包含 | 不包含 |
| --- | --- | --- |
| GitHub ZIP | Core、既有 Codex、DSH Host、已构建 Client | 原生 codex-client、node_modules、完整测试 |
| 配套资产 | update-manifest.json、SHA256SUMS.txt、ZIP attestation | 个人配置与凭据 |
| npm | Core → DSH Client → DSH Host | private 根、既有 Codex、新原生包 |
| Git 文档 | 本指南和各包手册 | ZIP builder 不复制 docs，离线需另外保存 |

版本脚本对齐原生版本不等于加入发包范围。原生首发还需发布清单、Marketplace、可信发布和干净安装验收。

### 授权后的正式步骤

替换占位为未发布的新版本，不用已存在的 `0.33.8`：

```powershell
$releaseVersion = '<未发布的新版本>'
node packages/codex/scripts/set-version.mjs $releaseVersion
npm install --package-lock-only --ignore-scripts
npm test
npm run release:npm:verify
node packages/codex/scripts/verify-release-version.mjs "v$releaseVersion"
git diff --check
git status --short
```

审核所有改动，按明确路径暂存、中文提交，推 `main` 并确认 CI，再在同一已推送提交创建 / 推送标签：

```powershell
git -c push.followTags=false push origin HEAD:refs/heads/main
# CI 与提交版本确认后才执行，会正式发布。
git tag "v$releaseVersion"
git push origin "refs/tags/v$releaseVersion"
```

不 `git push --tags` 顺带推其他标签，不移动已发布 tag。只保存用 `git -c push.followTags=false push origin HEAD:refs/heads/main`。

流水线：Windows `npm ci` → 版本检查 → 全量测试 → cachebuster → ZIP / manifest / checksum → attestation → 正式 Release；成功后 Ubuntu npm job 用 Node 22.19.0、npm 11，构建 Client、pack 检查、三包发布。

本地 `build-release.ps1` 会清空输出目录，默认仓库 `dist`；不要放用户文件。旧机已有 ZIP 不一定当前版本。构建不是发布，人工发包前也必须显式测试和 pack。

### Trusted Publishing 与账号

GitHub 推送、Release、npm 发布和业务 Jira/SVN 权限各自独立。开发及公共依赖下载通常无需 npm 发布登录；手工发布才涉及账号安全验证。

正式三包各在 npm 设置配置：

| 字段 | 当前仓库值 |
| --- | --- |
| Organization or user | yzj555 |
| Repository | jira-workbench |
| Workflow filename | release.yml，不是完整路径 |
| Environment | 留空，与当前 job 一致 |
| Allowed actions | 允许直接 npm publish，不只 staged publish |

Trusted Publishing 用 OIDC 短时身份而非长期写 Token，须云托管 runner、`id-token: write`、匹配 repo/workflow 和兼容 CLI。新配置可能默认仅 staged publish，需允许当前直接发布；`npm whoami` 不能验 OIDC 权限。[npm 官方说明](https://docs.npmjs.com/trusted-publishers/)。

`v0.33.8` 工作流已成功，网站权限仍由维护者管理。换机无需重配 Publisher，改 owner、workflow、environment 或发布方式则重新核对。新包首发参考[发布手册](../packages/dsh/PUBLISHING.md)，不保存 Token / OTP / 恢复码、不为发布绕过验证。

新建 Publisher 须在 2 天内完成首次成功发布，否则按 npm 规则过期。同版本包已人工发完、CI 只是全部跳过，不构成 OIDC 验证；不要为了验证而擅自发布，等正式发版安排再配置并验。已验证的现有配置不因此要求重新建立。[配置时效说明](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)。

### 成功核对与失败恢复

- 验两 jobs、Release 资产版本、checksum / attestation；官方 registry 的三包 version、依赖、integrity、provenance；干净环境实际安装。
- Release 成功、npm 失败是部分发布，不能说全部成功。
- 权限 / 网络修复后可原 tag rerun；`--if-missing` 只补缺失，不覆盖也不比对已存在包的内容。
- 已上传内容错误必须发更高版本，不覆盖、不常规 unpublish、不移 tag。
- 本地 `release:npm:publish` 不自动构建 / pack；先测试、`release:npm:verify`。本机没有 CI OIDC 身份，不能当成本地登录。

## 常见问题与安全

| 现象 | 先核对 | 不要做 |
| --- | --- | --- |
| 拉代码没变化 | 重建、重启，实际是源码还是 npm / 缓存 | 认为 git pull 自动升级安装 |
| DSH 别的 bundle 不兼容 | 报错点名的插件及其 peer | 一律归因 Jira 或 allow-version 放行 |
| DSH 模块找不到 | profile、三包版本、link 是否移动 | 改宿主、删未知包或建 junction |
| 项目 / Skill 空 | registry、作用域；原生是否未支持 | 会话标题猜项目，伪造空列表成功 |
| Filter / Sheet 不完整 | 用户权限、JQL；目录和行数分开 | 硬编码别人 ID、截图当完整性证明 |
| 原生 HTTP 403 | 是否误开认证 loopback | 公开 Bearer、允许 Origin、转发公网 |
| 旧 Codex 无侧栏 / 启动失败 | 受管入口、Status、CLI 来源、日志 | 按名字杀所有 ChatGPT、伪造安装成功 |
| 新机 Token 解密失败 | 旧 DPAPI、新机重新配置 | Purge 或明文写公开 JSON |
| 图片仍 OCR | 实际模型能力/provider、重载 | 按名字猜视觉、发送至未批准服务 |
| SVN 报错 / 不明 | log、回执、实际 revision | 自动重试 / 整工作副本提交 |
| npm 用户只拉旧版 | 镜像、固定版本和依赖范围 | 重发旧版本或移动 tag |

旧 Codex 启动日志在安装目录 `packages/codex/.runtime`，更新日志在数据根 `updates/logs`。先脱敏再提供；不分享完整认证启动 URL、PAT、Webhook、npm Token、Bearer、endpoint 或 credentials 原文。

Jira 写操作只限明确确认的流转；SVN 只提交审核显式路径，复检、一次性确认和对账不削弱。未纳管文件不自动 add、冲突/external 不自动修复、结果不明不重试。

图片可能含业务秘密，配置视觉 provider 前确认允许发送附件。OCR 失败也不能假装读懂；原生宿主对应路由尚待补。

Captain Tsubasa 生产运维诊断仍须 devops-tracer MCP-first、只读取证、禁止 shell SSH 和猜测归因。阅读工程不授权生产操作。

## 给下一位开发者或 AI 助手

新会话可提供以下说明：

> 请先读取 README、docs/PROJECT_HANDOFF.md、docs/codex-native-migration.md 和 docs/codex-native-acceptance.md，再检查 Git 与代码。业务保存基线 240dfa9，版本 0.33.8，但 main 含未发布原生预览，与 npm/Release 内容不同。原生会话创建/关联、宿主项目、Skill 未实现；新源码未覆盖旧机预览。保留旧 Codex/DSH，不改 DSH 工程，不用 CDP/DOM 冒充原生，不伪造验收。只做本次明确任务；无发布授权不推 v* / 发布，无业务授权不建真实会话、不调用模型、不流转 Jira、不提交 SVN。保留用户改动，不复制凭据、不整目录恢复旧安装状态。

每轮核对 commit、工作区、版本、宿主、数据根、构建和加载来源。文档是日期快照，新事实以代码和验证更新，不用历史百分比或截图代替。

## 文档索引

- [仓库总览](../README.md)和[Core 规则](../packages/core/README.md)。
- [既有 Codex 安装与维护](../packages/codex/README.md)。
- [DSH 安装](../packages/dsh/INSTALL.md)、[架构](../packages/dsh/DESIGN.md)、[Client](../packages/dsh-client/README.zh.md)。
- [正式 npm 发布](../packages/dsh/PUBLISHING.md)。
- [原生包](../packages/codex-client/README.md)、[原生安装](../packages/codex-client/INSTALL.md)。
- [原生迁移](codex-native-migration.md)和[实机验收](codex-native-acceptance.md)。

手册与实现冲突时以代码和验证为准并修手册，不能静默改变安装、发布、权限边界。
