import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import {
  buildToolDefinitions,
  createCoreService,
  createLocalApprovalProvider
} from "@jira-workbench/core";
import { JIRA_TASK_BOARD_RESOURCE_URI } from "@jira-workbench/core/tools.mjs";
import { loadNativeUi } from "./native-ui.mjs";
import { VERSION } from "./version.mjs";

export const THREAD_RESOURCE_URI = "ui://jira-workbench-native/thread.html";
export const SETTINGS_RESOURCE_URI = "ui://jira-workbench-native/settings.html";

const configSchema = z.object({
  baseUrl: z.string().max(4000).optional(),
  token: z.string().max(16000).optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
  boardSources: z.record(z.string(), z.unknown()).optional(),
  promptTemplates: z.record(z.string(), z.unknown()).optional(),
  syncSettings: z.record(z.string(), z.unknown()).optional(),
  imageProcessing: z.record(z.string(), z.unknown()).optional(),
  messageTemplate: z.string().max(50000).optional()
}).strict();

function nativeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function result(data, text) {
  return { structuredContent: data, content: [{ type: "text", text }] };
}

function metadata(resourceUri, type) {
  return {
    ui: { resourceUri, visibility: ["app"] },
    "openai/outputTemplate": resourceUri,
    ...(type ? { "openai/ui": { entrypoints: [{ type }] } } : {})
  };
}

export function createNativeServices({ dataRoot, version = VERSION, core: suppliedCore, settingsOptionsTimeoutMs = 45000 } = {}) {
  if (!dataRoot) throw new TypeError("原生工作台必须有独立的数据目录。");
  const approvalProvider = createLocalApprovalProvider();
  // Pass every persistent path explicitly: legacy environment variables must
  // never make this preview a second writer of the production adapter's files.
  const core = suppliedCore || createCoreService({
    dataRoot,
    version,
    configFile: join(dataRoot, "config.json"),
    bindingsFile: join(dataRoot, "issue-bindings.json"),
    workspacesFile: join(dataRoot, "issue-workspaces.json"),
    baselineFile: join(dataRoot, "svn-baselines.json"),
    reviewStateFile: join(dataRoot, "svn-reviews.json"),
    reviewArtifactsRoot: join(dataRoot, "attachments", "svn-reviews"),
    approvalProvider
  });
  const capabilities = Object.freeze({
    nativeUi: true,
    settings: true,
    workspaceBinding: true,
    projectCatalog: false,
    sessionContext: false,
    conversationCreation: false,
    conversationBinding: false,
    skills: false,
    taskAutoRefresh: true,
    automation: false,
    automaticUpdates: false,
    svn: true
  });
  let writes = Promise.resolve();
  async function revision() {
    let bytes;
    try { bytes = await readFile(core.configStore.configFile || join(dataRoot, "config.json")); }
    catch (error) {
      if (error.code !== "ENOENT") throw nativeError("NATIVE_CONFIG_READ_FAILED", "无法读取工作台配置，请检查本地目录权限。");
      bytes = Buffer.alloc(0);
    }
    return createHash("sha256").update(bytes).digest("hex");
  }
  async function readSettings() {
    const config = await core.configStore.getPublic();
    return {
      view: "codexSettings",
      config,
      revision: await revision(),
      credentialConfigured: Boolean(config.hasToken)
    };
  }
  async function getSettings() {
    await writes;
    return readSettings();
  }
  function saveSettings({ config, expectedRevision, acknowledged } = {}) {
    const operation = writes.then(async () => {
      if (acknowledged !== true) throw nativeError("NATIVE_SETTINGS_CONFIRMATION_REQUIRED", "请在设置面板明确确认保存。");
      if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || ""))) {
        throw nativeError("NATIVE_CONFIG_REVISION_REQUIRED", "请先读取最新设置再保存。");
      }
      if (expectedRevision !== await revision()) {
        throw nativeError("NATIVE_CONFIG_REVISION_CONFLICT", "设置已由另一窗口更新，请重新读取后保存。");
      }
      const checked = configSchema.safeParse(config);
      if (!checked.success) throw nativeError("NATIVE_CONFIG_INVALID", "设置字段或类型无效，请检查输入。");
      const normalized = await core.configStore.prepare(checked.data);
      await core.configStore.save(normalized);
      return readSettings();
    });
    writes = operation.catch(() => {});
    return operation;
  }
  let optionsInFlight = null;
  function listSettingsOptions(input = {}) {
    const key = JSON.stringify([input.expectedRevision, input.projectKey || ""]);
    if (optionsInFlight) {
      if (optionsInFlight.key === key) return optionsInFlight.promise;
      return Promise.reject(nativeError("NATIVE_OPTIONS_BUSY", "Jira 选项正在读取，请等待本次完成后重试。"));
    }
    const promise = readSettingsOptions(input).finally(() => {
      if (optionsInFlight?.promise === promise) optionsInFlight = null;
    });
    optionsInFlight = { key, promise };
    return promise;
  }
  async function readSettingsOptions({ expectedRevision, projectKey = "" } = {}) {
    await writes;
    if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || "")) || expectedRevision !== await revision()) {
      throw nativeError("NATIVE_CONFIG_REVISION_CONFLICT", "配置已变化，请重新读取设置，再读取 Jira 选项。");
    }
    let publicConfig;
    try { publicConfig = await core.configStore.getPublic(); }
    catch { throw nativeError("NATIVE_CONFIG_READ_FAILED", "无法读取已保存的 Jira 连接，请检查本地配置后重试。"); }
    if (!publicConfig.configured || !publicConfig.hasToken) {
      throw nativeError("NATIVE_CONFIG_REQUIRED", "请先保存有效的 Jira 连接，再读取项目与 Filter。");
    }
    // Only the server reads saved credentials. Unsaved PATs never travel with
    // catalog requests, and upstream response bodies are not passed to the UI.
    let config;
    try { config = await core.configStore.load(); }
    catch { throw nativeError("NATIVE_CONFIG_READ_FAILED", "无法读取已保存的 Jira 连接，请检查本地配置后重试。"); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settingsOptionsTimeoutMs);
    let projectsResult, filtersResult;
    try {
      [projectsResult, filtersResult] = await Promise.allSettled([
        Promise.resolve().then(() => core.jira.fetchProjects(config, { signal: controller.signal })),
        Promise.resolve().then(() => core.jira.fetchFilters(config, { projectKey, signal: controller.signal }))
      ]);
      if (controller.signal.aborted) throw nativeError("NATIVE_OPTIONS_TIMEOUT", "读取 Jira 选项已超时并取消；已选来源保持不变，请稍后重试。");
    } finally { clearTimeout(timer); }
    if (expectedRevision !== await revision()) {
      throw nativeError("NATIVE_CONFIG_REVISION_CONFLICT", "读取期间配置已变化，请重新读取设置和 Jira 选项。");
    }
    const warnings = [];
    if (projectsResult.status === "rejected") warnings.push("项目列表读取失败；可以手动填写项目 Key，或稍后重试。");
    if (filtersResult.status === "rejected") warnings.push("Filter 列表读取失败；已选 Filter 会保留，可以手动填写 ID，或稍后重试。");
    return {
      view: "codexSettingsOptions", revision: expectedRevision,
      projects: (projectsResult.status === "fulfilled" ? projectsResult.value?.projects || [] : []).map((item) => ({
        id: String(item.id || ""), key: String(item.key || ""), name: String(item.name || "")
      })).filter((item) => item.key),
      filters: (filtersResult.status === "fulfilled" ? filtersResult.value?.filters || [] : []).map((item) => ({
        id: String(item.id || ""), name: String(item.name || ""), owner: String(item.owner || ""),
        favourite: Boolean(item.favourite), projectMatch: String(item.projectMatch || "unknown")
      })).filter((item) => /^\d+$/.test(item.id)),
      warnings
    };
  }
  const baseOptions = {
    workbench: core.jiraWorkbench,
    svn: core.svnWorkbench,
    workspaces: core.workspaceBindings,
    approvalProvider,
    version,
    serverName: "jira-workbench-native"
  };
  const businessTools = buildToolDefinitions({
    service: core.jiraWorkbench,
    svn: core.svnWorkbench,
    workspaces: core.workspaceBindings,
    approvalProvider
  });
  const extraNames = [
    "jira_codex_open_workbench", "jira_codex_open_thread_panel", "jira_codex_open_settings",
    "jira_codex_status", "jira_codex_get_settings", "jira_codex_save_settings", "jira_codex_list_settings_options"
  ];
  async function getStatus() {
    const config = await core.configStore.getPublic();
    return {
      view: "codexStatus",
      version,
      configured: Boolean(config.configured),
      host: "codex-native",
      availableTools: [...businessTools.map((tool) => tool.name), ...extraNames],
      capabilities,
      syncSettings: config.syncSettings,
      settings: { available: true },
      message: "原生预览已接入公共业务核心；会话创建、真实会话上下文、宿主项目列表与 Skill 尚未通过原生接口验收。"
    };
  }
  const additionalTools = [
    ...[
      ["jira_codex_open_workbench", "Jira 工作台", JIRA_TASK_BOARD_RESOURCE_URI, "global"],
      ["jira_codex_open_thread_panel", "Jira 关联任务", THREAD_RESOURCE_URI, "thread"],
      ["jira_codex_open_settings", "Jira 工作台设置", SETTINGS_RESOURCE_URI, "settings"]
    ].map(([name, title, resourceUri, type]) => ({
      name, title, description: `打开${title}，不创建会话或修改业务状态。`, inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: metadata(resourceUri, type),
      handler: async () => result(await getStatus(), `${title}原生入口已就绪。`)
    })),
    {
      name: "jira_codex_status", title: "原生工作台能力状态", description: "读取实际注册的工具、配置状态与尚未验证的宿主能力。",
      inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: metadata(JIRA_TASK_BOARD_RESOURCE_URI),
      handler: async () => result(await getStatus(), "已读取原生工作台能力状态。")
    },
    {
      name: "jira_codex_get_settings", title: "读取 Jira 工作台设置", description: "仅返回脱敏配置与 revision，不返回 PAT 或 Webhook。",
      inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: metadata(SETTINGS_RESOURCE_URI),
      handler: async () => result(await getSettings(), "已读取脱敏设置。")
    },
    {
      name: "jira_codex_list_settings_options", title: "读取 Jira 设置选项", description: "仅使用已保存连接读取 Jira 项目和可访问的 Filter；不修改 Jira 或设置。",
      inputSchema: { expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), projectKey: z.string().max(50).regex(/^(?:[A-Za-z][A-Za-z0-9_]{0,49})?$/).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: metadata(SETTINGS_RESOURCE_URI),
      handler: async (input) => result(await listSettingsOptions(input), "已读取 Jira 设置选项；未修改配置。")
    },
    {
      name: "jira_codex_save_settings", title: "保存 Jira 工作台设置", description: "由用户在面板明确确认后保存，校验 revision 并使用 Core 密钥存储。",
      inputSchema: { config: configSchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), acknowledged: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: metadata(SETTINGS_RESOURCE_URI),
      handler: async (input) => result(await saveSettings(input), "设置已保存，凭据不会回显。")
    }
  ];
  const options = {
    ...baseOptions,
    uiResources: [
      { uri: JIRA_TASK_BOARD_RESOURCE_URI, loadHtml: () => loadNativeUi({ version, surface: "global" }), _meta: { ui: { prefersBorder: false } } },
      { name: "jira-native-thread", uri: THREAD_RESOURCE_URI, title: "Jira 关联任务", loadHtml: () => loadNativeUi({ version, surface: "thread" }), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } },
      { name: "jira-native-settings", uri: SETTINGS_RESOURCE_URI, title: "Jira 工作台设置", loadHtml: () => loadNativeUi({ version, surface: "settings" }), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }
    ],
    // Mutations are UI-only and retain Core's confirmation/token checks.
    // This is host visibility policy, not a claim of cryptographic user identity.
    toolMetadata: (definition) => definition.annotations?.readOnlyHint === false
      ? { ui: { visibility: ["app"] } }
      : {},
    additionalTools
  };
  return { core, options, capabilities, getStatus, getSettings, saveSettings, listSettingsOptions };
}
