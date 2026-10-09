# Jira 工作台 · Codex 原生预览

`@jira-workbench/codex-client` 是 Jira 工作台的 Codex 原生 Plugin / MCP Apps 适配器。工作台由官方插件入口承载，业务复用本地 Core；不修改 Codex 安装文件，不通过 CDP 或 DOM 注入界面，也不修改 DSH 工程。

当前为 `0.33.8` 开发预览，尚未发布此 npm 包，不能按已上线插件安装。用户已确认第一轮本机预览能打开；设置、会话侧面板及新构建的实际交互、入口位置和真实 npm source 安装仍待验。它还不是现有 Codex / DSH 适配器的完整替代品。

## 安装从哪里开始

用户安装目标流程：添加 Marketplace → 安装插件 → 从官方插件图标打开 → 配置 Jira 连接。

这条流程要在发布并完成桌面验收后才对普通用户开放。当前提供开发包的隔离验证及需明确选择的本机预览安装流程，见 [安装与验证说明](INSTALL.md)。不要执行针对未发布包的 `npm install`、`npx` 或 npm source 插件安装命令。

## 当前能力

| 能力 | 当前状态 |
| --- | --- |
| 工作台、会话侧面板、设置入口 | 用户已确认旧预览工作台能打开；settings / thread 与新构建实际交互仍待验 |
| 任务、Jira Sheets、详情、需求上下文、附件 | 复用 Core 完整 MCP 业务 UI；原生宿主交互回归待验 |
| 设置 | 工作台内同页打开；连接、Jira 项目 / Filter 选项、消息模板与任务同步策略已接入；新代码待安装验收 |
| 项目目录绑定、SVN 审核与提交 | 复用 Core；项目目录可手动配置，不等于读取 Codex 项目列表 |
| 原生项目列表 | `projectCatalog: false` |
| 真实当前会话上下文 | `sessionContext: false` |
| 创建、绑定 Codex 会话 | `conversationCreation / conversationBinding: false` |
| 宿主 Skill 列表与绑定 | `skills: false` |
| 定时 / 返回可见面板自动刷新 | 新代码 `taskAutoRefresh: true`；只读任务列表、操作期间暂停、失败退避；旧安装缓存尚未更新 |
| 自动化、自动更新 | `automation / automaticUpdates: false` |

设置入口目前采用自定义 MCP Apps UI，不代表已经实现或验收宿主自动生成的结构化设置表单。`thread` 入口表示可声明会话侧面板，不表示能够取得真实 threadId 或自动建立会话关联。

新代码的任务同步设置可编辑并由服务端回写；只有面板可见且没有详情、设置、SVN 或输入操作时刷新任务列表。它不启用后台 Bug 监控、Sheets 后台同步或自动安装更新。自动刷新旧回复不会把用户拉回列表，保存来源后清理旧连接缓存。

图片使用原图预览、有界缓存与原始尺寸查看；父单与非图片附件通过官方导航进入 Jira。非图片本地首次下载 / 二次打开仍为迁移缺口，不能把链接导航声称为下载完成。设置的项目列表来自 Jira，不是 Codex 原生项目目录。

未支持的宿主能力应明确提示不可用，不能返回伪造的创建、绑定或保存成功。匿名会话标识、一次深链打开、App Server 独立创建会话都不能替代现有桌面窗口的关联回执。

## 运行方式与数据隔离

```text
Codex 官方 Plugin / MCP Apps UI
  ↕ 官方 MCP Apps 桥接
Codex STDIO 连接 → 薄协议桥 → 受管理的单实例本地 Core
```

插件包预构建并包含运行代码与 UI 资源，不依赖用户安装时运行 lifecycle 脚本来补全 Core 或编译前端。每个 STDIO 连接只充当协议桥，持久状态由受管理的 Core 单实例持有。

Windows 默认数据目录为 `%LOCALAPPDATA%\jira-workbench\codex-native-preview`。它与旧 Codex / DSH 数据独立：不自动搬迁，不自动读取旧凭据、绑定或审核状态，不把旧环境变量当作原生预览的数据源。开发测试可显式设置 `JIRA_WORKBENCH_NATIVE_DATA_DIR`，仍应使用全新隔离目录。

本地服务仅监听 `127.0.0.1`，根据数据目录身份确定端口，以操作系统监听权保证单实例；必须携带 Bearer 凭据，拒绝浏览器 Origin 请求。端口不是面向浏览器的工作台入口。不要公开、转发服务端口或分享 `.runtime/endpoint.json`。

连接关闭后，服务在无有效租约、请求、实际工具 handler 和后台 SVN 操作时才空闲退出。即使发起请求的连接已断开，也不能在提交或其他写操作结束前释放单实例监听权；协议桥不得自动重放失败的写请求。

写工具采用 `app-only` 可见性，并保留 Core 既有的人工复核与一次性确认控制。`app-only` 是宿主可见性策略，不是用户身份的密码学证明，不能替代业务授权或确认校验。

## 验收与迁移

本机静态审查样本为 Windows Codex `26.1002.7124.0`、CLI `0.147.0`。这仅证明相关协议和加载分支存在，不构成最低版本承诺，也不代表所有账号、平台或桌面模式都已通过实测。

2026-10-09 最终原生适配器专项 87 个测试通过：UI 29、服务 9、运行时 10、打包 1、设置选项 12、取消 9、设置回写 9、任务同步 8。覆盖完整解包、双桥共用 Core、确认与并发冲突、真实请求取消、旧回复竞态、附件去重及跨目录审核。仓库根 `npm test` 退出码为 0：主套件 328、DSH Client 10、原生适配器 87，共 425 个测试通过。

设置宽 / 窄、工作台、任务详情、暗色会话侧面板五张模拟宿主截图已检查。这不是实际 Codex 桌面截图，不能据此宣布官方入口或会话关联已经验收。

增强后的 `npm run probe:codex-client:install` 已通过官方 CLI 的隔离 local Marketplace 安装，并按安装缓存中的 `mcp.json` 替换 `PLUGIN_ROOT` 后运行 STDIO，读取三个原生入口及完整 UI 资源、确认未配置状态，并验证关闭后运行时回收。它不安装到生产环境、不打开桌面，也不证明真实 npm registry 安装或桌面渲染。

当前桌面后端 CLI `0.162.0-alpha.2` 也已通过隔离探针。显式本机验收与默认隔离验证分别记录，不能把 CLI 安装成功当作实际界面验收通过。

本机仍安装 2026-10-08 构建；本轮未覆盖缓存、未自动重启、未发布。新代码须先进行受控更新，再验设置、图片、SVN 与同步的真实交互。

详细迁移门槛、回归清单与退出旧注入链的条件见 [原生迁移记录](../../docs/codex-native-migration.md) 与 [实机验收清单](../../docs/codex-native-acceptance.md)。当前保留旧 Codex / DSH，不自动重启，未发布 npm。

## 官方依据

- [插件打包、Marketplace 与 npm source](https://developers.openai.com/plugins/build/plugins)
- [原生扩展入口](https://developers.openai.com/plugins/build/extensions)
- [MCP Apps UI 与官方桥接](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Codex 环境变量与状态目录](https://learn.chatgpt.com/docs/config-file/environment-variables)
