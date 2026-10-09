# 安装与验证

## 先看当前状态

本包为 `@jira-workbench/codex-client@0.33.8` 原生开发预览，尚未发布 npm。第一轮本机插件详情与工作台打开已经用户确认；新构建、设置、会话侧面板和 npm source 安装仍待验。已有 DSH 包不是此原生插件包。

普通用户现在继续使用现有 Codex / DSH 版本；不要尝试安装不存在的原生 npm 包。开发验收可以在明确选择后安装本地预览，但不自动重启，也不迁移原有凭据和数据。

## 本机原生预览验收

这不是 npm 发布安装。确认隔离探针通过后，在仓库根目录执行以下两步；`<桌面后端 codex.exe>` 必须替换为当前桌面实际使用的 CLI 绝对路径，不能因为 PATH 中的 `codex` 可用就假定两者版本相同。

先初始化 / 登录 Codex，确认目标 `CODEX_HOME` 已存在、与当前桌面一致，并且 PATH 中有 Node、npm 和 `tar`。首次安装会修改该 home 的配置、Marketplace 注册和插件缓存，不修改 Codex 应用本体；不要把临时测试 home 误当作生产安装目标。

```powershell
# 1. 构建并准备持久安装包；此步骤不修改 Codex 配置。
npm run build:codex-client
npm run install:codex-client:preview

# 2. 明确执行首次安装；通过官方命令注册并验证安装缓存。
npm run install:codex-client:preview -- --install --codex-executable "<桌面后端 codex.exe>"
```

如果已经生成 `.tgz`，可在两次命令中都传入 `--package "<tgz 的绝对路径>"`，保证准备和安装使用同一构建。也可使用 `--codex-module "<codex.js 的绝对路径>"`；两种 CLI 参数互斥。`--codex-home` 和 `--install-root` 仅在需要明确指定目录时使用。

安装源保存在 `%LOCALAPPDATA%\jira-workbench\codex-native-plugin`，独立 Marketplace 为 `jira-workbench-native-preview`，插件标识为 `jira-workbench-native@jira-workbench-native-preview`。实际业务数据仍使用另外的 `codex-native-preview` 目录。默认准备不写活动 catalog、不注册插件；`--install` 会先备份 `CODEX_HOME` 下的 `config.toml`，再调用官方 Marketplace / Plugin 命令并核对缓存文件 hash。备份仅用于人工恢复，失败时不会用整份配置覆盖其他并发改动。

安装器只处理首次安装；同一构建且缓存验证通过时允许重复检查。已有不同构建、禁用状态或未知安装记录会拒绝覆盖，不自动升级、卸载或终止进程。现有正式工作台与 DSH 不受替换。

安装后先从 Codex 的“插件”页确认「Jira 工作台 · 原生预览」已启用，再检查工作台、设置和会话侧面板三个官方入口。如果当前桌面没有刷新插件目录，保存工作后手工正常退出 Codex，并从原始图标重新打开；不要改用注入快捷方式或本地浏览器代替原生验收。逐项记录见[实机验收清单](../../docs/codex-native-acceptance.md)。

首次安装结果包含 `pluginDetailUrl`：本地来源的详情链接必须带 `marketplacePath`，指向实际 `.agents/plugins/marketplace.json`。不要把无 query 的 `codex://plugins/name@自建来源` 当作通用详情入口；当前桌面会忽略它。来源路径需要 URL 编码，直接使用安装器输出的完整链接即可。

### 显式复用本机旧配置

默认仍不读取旧凭据。用户明确选择复用后，可在仓库根目录执行：

```powershell
# 先检查可迁入的设置，不解密 PAT、不修改原生配置。
npm run import:codex-client:config

# 明确迁入旧连接、面板来源和模板等兼容偏好。
npm run import:codex-client:config -- --apply
```

默认来源为 `%LOCALAPPDATA%\jira-workbench\config.json`，目标为独立的 `codex-native-preview`。通过安装记录定位真正的缓存 STDIO 入口，再调用原生设置 MCP 工具保存；不直接复制整个配置，不把旧目录用作第二个业务数据根。

PAT 只在当前 Windows 用户的本地内存中解密，并由目标 Core 重新以 DPAPI 加密；不放入命令参数或日志。旧配置不修改，目标已有有效连接时拒绝覆盖，revision 冲突或保存结果不明确时停止，不重试写入。

保留 Jira 地址、任务数量、需求 / Bug 来源、消息模板和同步偏好。旧 Skill 引用、会话 / 项目绑定、SVN 状态、Webhook、自动监控及宿主模型路由不迁入。完成后重新打开工作台或刷新设置，再验实际任务和 Sheets 加载；目标已有有效连接时不要重复导入。

## 未来用户安装：四步

以下是发布及验收后的目标流程，不是当前可执行的上线安装承诺。

| 步骤 | 用户操作 | 完成标志 |
| --- | --- | --- |
| 1. 添加来源 | 添加正式发布的 Jira Workbench Marketplace | 插件目录中出现该来源 |
| 2. 安装插件 | 选择「Jira 工作台（原生）」并安装、启用 | 宿主识别插件与 MCP 服务 |
| 3. 打开工作台 | 点击宿主提供的工作台插件图标 / 入口 | 在官方面板中打开工作台，不弹出本地浏览器代替 |
| 4. 配置连接 | 在工作台设置中填写 Jira 地址、PAT 和任务来源，确认保存 | 保存后回读正确，任务能正常加载 |

正式 Marketplace 地址、安装命令、图标位置和最低 Codex 版本，必须等发布与真实桌面验收后再填写。当前不提供猜测命令；也不要求用户手动安装 Core 或启动一个常驻服务。

首次配置使用新的独立目录。PAT 留空时保留已保存值，已保存 PAT 不回传到界面。设置在工作台同页打开，不通过会话侧边浏览器跳转。2026-10-09 新代码支持只读任务列表定时 / 返回可见面板刷新；详情、设置、SVN 或隐藏页面时暂停。当前本机安装缓存仍为旧构建，不会因仓库 build 自动更新；首次安装器拒绝覆盖不同构建，勿直接复制活动缓存。当前原生会话创建、关联、项目列表、Skill 和自动化未启用。

## 开发包：先构建，再隔离验证

前提：Node.js 22 或更新版本、npm、可使用的 Codex CLI，以及已完成依赖准备的本仓库。npm source 下载不执行安装生命周期脚本，因此必须先构建再打包。

在仓库根目录执行：

```powershell
npm run build:codex-client
npm run test:codex-client
npm run probe:codex-client:install
```

安装探针会自动生成本地 tarball，在全新的临时 `CODEX_HOME` 中建立 local catalog，调用官方 `plugin add`，再从安装缓存读取 `mcp.json`、将 `PLUGIN_ROOT` 替换为实际安装路径并启动 STDIO。探针会读取入口元数据、三个完整 UI 资源、未配置状态，并验证关闭后运行时回收，最后输出结果并清理临时目录。它不会加载生产插件、打开或重启桌面、读取旧 Jira 凭据或发布 npm；输出路径被清理后不是可继续使用的生产安装。

探针从 PATH 查找 `@openai/codex/bin/codex.js`。如未找到，显式提供该 JS 的绝对路径；也可以通过 `--codex-executable` 指定桌面实际使用的 `codex.exe`，二者互斥，不能传 `codex.ps1`：

```powershell
npm run probe:codex-client:install -- --codex-module "<@openai/codex/bin/codex.js 的绝对路径>"
npm run probe:codex-client:install -- --codex-executable "<桌面后端 codex.exe 的绝对路径>"
```

本机已使用 CLI `0.147.0` 通过增强后的探针，验证范围为 `npm tarball → 临时 local Marketplace → 官方 plugin add → 安装缓存 STDIO → global / settings / thread 元数据与三个 UI 资源`。状态返回 `configured: false`，关闭后运行时正常回收。UI HTML 可以读取不等于桌面实际渲染；该探针也不证明 npm source registry 安装。

2026-10-08 和 2026-10-09 已额外使用当前桌面后端 CLI `0.162.0-alpha.2` 通过同一隔离探针。PATH 包装器与桌面后端版本不同，因此当前实机安装优先显式指定桌面后端。

2026-10-09 最后一轮仓库根 `npm test` 退出码为 0：主套件 328 个、DSH Client 10 个、原生适配器 87 个，共 425 个测试通过。原生专项覆盖来源回写、请求取消、同步导航竞态、附件去重和跨目录审核，安装器与显式导入回归也保持通过。全量自动化回归不替代真实桌面 UI、真实 npm source 或尚未启用的会话关联工作流验收。

若需要单独保存和检查 tarball，执行：

```powershell
npm pack --workspace @jira-workbench/codex-client --ignore-scripts
```

此命令只生成本地 `.tgz`，不发布 npm。应核对 tarball 含 `plugin.json`、`mcp.json`、`dist/stdio-entry.mjs`、`dist/daemon.mjs` 与 UI 文件，并在没有仓库 `node_modules` 的解包目录验证运行，避免源码工作区掩盖缺文件或未打包依赖。现有专项测试已覆盖解包后无 `node_modules` 启动、双桥共享 Core 和三个 UI 资源读取；增强后的探针进一步验证官方安装缓存中的 STDIO 与资源。

### 隔离本地 Marketplace

优先使用上述自动探针。以下是手工排查时的同等隔离要求，不能直接在生产 shell 下复制安装命令。所有安装验证只使用临时目录，不在真实 `%USERPROFILE%\.codex` 或现有 `CODEX_HOME` 注册插件。

1. 创建独立临时根目录；将 tarball 解包到 `plugins/jira-workbench-native`，另准备 `.agents/plugins`、`codex-home`、`data` 和 npm cache 目录。
2. 在临时根目录的 `.agents/plugins/marketplace.json` 放置下面的 catalog。
3. 仅为测试子进程指定 `CODEX_HOME`、`CODEX_SQLITE_HOME` 和 `JIRA_WORKBENCH_NATIVE_DATA_DIR`，分别指向临时的 `codex-home`、`codex-home` 和 `data`；cwd 也使用临时根目录。不要修改当前桌面进程的全局环境或凭据。
4. 在该子进程运行下面的 Marketplace / 插件命令，然后读取工具与 UI 资源；只验证协议，不执行真实 Jira 流转、SVN 提交、模型调用或新建会话。

```json
{
  "name": "jira-native-preview-test",
  "interface": { "displayName": "Jira 原生预览隔离测试" },
  "plugins": [
    {
      "name": "jira-workbench-native",
      "source": {
        "source": "local",
        "path": "./plugins/jira-workbench-native"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

在已隔离的测试子进程中执行，`<临时根目录>` 替换为真实绝对路径：

```powershell
codex plugin marketplace add "<临时根目录>" --json
codex plugin add jira-workbench-native@jira-native-preview-test --json
codex plugin list --json
```

本机 CLI `0.147.0` 使用 `plugin add`，不是 `plugin install`。`source.path` 相对 Marketplace 根目录解析，必须以 `./` 开头且不能越出根目录；解包后检查不能残留额外的 `package/` 层导致 manifest 找不到。

`CODEX_HOME` 必须事先存在。若需要 npm 网络读取，应同时把测试子进程的 `NPM_CONFIG_CACHE` 指向临时 cache、`NPM_CONFIG_USERCONFIG` 指向临时空 npmrc，避免使用个人 npm 凭据。不要使用未验证的 `CODEX_CONFIG_HOME` 作为隔离保证。

### 这些结果不能混淆

- 本地 tarball 可启动：证明打包文件与运行依赖完整。
- 隔离 local Marketplace 安装成功：证明该 catalog 与本地插件加载路径可用。
- 真实 npm source 安装成功：需要包已经发布，并实际走 npm registry 路径；前两项不能替代。
- 桌面图标、面板和交互正常：需要真实官方桌面宿主验收；CLI 静态检查不能替代。

npm source 要求 HTTPS registry；不支持把本地 tarball 路径当作 `version`，普通 HTTP 本地 registry 也不能作为有效安装验证。当前不为了预览测试发布包或改机器证书信任。

## 启动、退出与排错

插件启用后，宿主启动 STDIO 薄桥，薄桥自动连接或启动本包受管理的 Core。无需用户手动运行 daemon。默认业务数据是 `%LOCALAPPDATA%\jira-workbench\codex-native-preview`；测试必须覆盖为临时独立目录。

服务根据数据目录确定 loopback 端口，所有连接须 Bearer 认证且不能带浏览器 Origin。直接用浏览器打开服务地址被拒绝是预期行为，不是面板入口丢失。不要分享 `.runtime/endpoint.json`，其中包含本机连接凭据。

关闭最后一个插件连接后，Core 等待租约、请求、实际工具执行和后台 SVN 操作结束再空闲退出。不要在 SVN 写操作进行时强制停止。端口被其他进程占用或版本不匹配时，应报告冲突；不能通过杀未知进程、删未知锁记录或启动第二个状态写者“修复”。

验收失败时记录：Codex / CLI / Node 版本、入口类型、脱敏错误、是否为隔离安装。不要附上 PAT、npm Token、Bearer Token 或完整端点记录。先使用旧适配器继续工作，原生预览不能静默回退到注入界面并声称验收成功。

参见 [原生迁移门槛](../../docs/codex-native-migration.md) 与 [官方打包说明](https://developers.openai.com/plugins/build/plugins)。
