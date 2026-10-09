import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJiraTaskBoardMcpServer } from "@jira-workbench/core";
import { JIRA_TASK_BOARD_RESOURCE_URI, JIRA_TASK_BOARD_TOOL } from "@jira-workbench/core/tools.mjs";
import {
  createNativeServices,
  SETTINGS_RESOURCE_URI,
  THREAD_RESOURCE_URI
} from "../lib/native-services.mjs";

const resources = [];
afterEach(async () => {
  while (resources.length) await resources.pop()();
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function fixture({ onPrepare, onSave } = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), "jira-native-services-test-"));
  resources.push(() => rm(dataRoot, { recursive: true, force: true }));
  const configFile = join(dataRoot, "config.json");
  let config = { baseUrl: "https://jira.example.test", token: "fixture-existing-pat", maxResults: 100 };
  let publicRevision = 0;
  const preparedInputs = [];
  const saves = [];
  const core = {
    configStore: {
      configFile,
      getPublic: async () => ({
        baseUrl: config.baseUrl,
        maxResults: config.maxResults,
        configured: Boolean(config.baseUrl && config.token),
        hasToken: Boolean(config.token),
        credentialStorage: "fixture protected storage",
        updatedAt: `fixture-${publicRevision}`
      }),
      load: async () => ({ ...config, wecomWebhook: "fixture-existing-webhook" }),
      prepare: async (input) => {
        preparedInputs.push(structuredClone(input));
        await onPrepare?.(input);
        return { ...config, ...input, token: input.token || config.token };
      },
      save: async (normalized) => {
        await onSave?.(normalized);
        config = structuredClone(normalized);
        publicRevision += 1;
        saves.push(structuredClone(normalized));
        await writeFile(configFile, JSON.stringify({
          baseUrl: config.baseUrl,
          maxResults: config.maxResults,
          tokenProtected: "fixture-encrypted-value",
          updatedAt: `fixture-${publicRevision}`
        }));
        return core.configStore.getPublic();
      }
    },
    jiraWorkbench: {
      listTasks: async () => ({ issues: [], activeIssues: [], completedIssues: [], total: 0 })
    },
    workspaceBindings: {
      get: async () => ({ revision: 0, binding: null }),
      bind: async () => ({ revision: 1, binding: null })
    },
    svnWorkbench: { context: async () => ({ changes: [], projectScopes: [] }) }
  };
  const services = createNativeServices({ dataRoot, version: "fixture-version", core });
  return { dataRoot, configFile, core, services, preparedInputs, saves };
}

async function connectServices(services) {
  const server = createJiraTaskBoardMcpServer(services.options);
  const client = new Client({ name: "native-services-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  resources.push(() => server.close(), () => client.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("原生服务要求独立数据目录并保持未验收宿主能力关闭", async () => {
  assert.throws(() => createNativeServices({}), /独立的数据目录/);
  const { core, services } = await fixture();
  assert.equal(services.core, core);
  assert.equal(Object.isFrozen(services.capabilities), true);
  const status = await services.getStatus();
  assert.equal(status.view, "codexStatus");
  assert.equal(status.version, "fixture-version");
  assert.equal(status.host, "codex-native");
  assert.equal(status.configured, true);
  assert.deepEqual(status.capabilities, {
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
  assert.equal(status.availableTools.includes(JIRA_TASK_BOARD_TOOL), true);
  assert.equal(status.availableTools.some((name) => /create.*analysis|list.*threads|bug_monitor/.test(name)), false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-existing-pat|fixture-existing-webhook/);
});

test("设置只读取公开配置，返回稳定 hash revision 和凭据配置状态", async () => {
  const { core, services } = await fixture();
  core.configStore.load = async () => { throw new Error("公开设置不得解密凭据"); };
  const settings = await services.getSettings();
  assert.equal(settings.view, "codexSettings");
  assert.equal(settings.credentialConfigured, true);
  assert.equal(settings.config.hasToken, true);
  assert.equal(settings.config.token, undefined);
  assert.equal(settings.config.wecomWebhook, undefined);
  assert.equal(settings.revision, createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal((await services.getSettings()).revision, settings.revision);
  assert.doesNotMatch(JSON.stringify(settings), /fixture-existing-pat|fixture-existing-webhook/);
});

test("保存设置必须明确确认并携带合法最新 revision，拒绝后队列仍可读取", async () => {
  const { services, saves } = await fixture();
  const revision = (await services.getSettings()).revision;
  await assert.rejects(services.saveSettings({ config: {}, expectedRevision: revision }), { code: "NATIVE_SETTINGS_CONFIRMATION_REQUIRED" });
  await assert.rejects(services.saveSettings({ config: {}, expectedRevision: revision, acknowledged: false }), { code: "NATIVE_SETTINGS_CONFIRMATION_REQUIRED" });
  for (const expectedRevision of [undefined, "", "not-a-revision", "A".repeat(64)]) {
    await assert.rejects(services.saveSettings({ config: {}, expectedRevision, acknowledged: true }), { code: "NATIVE_CONFIG_REVISION_REQUIRED" });
  }
  assert.equal(saves.length, 0);
  assert.equal((await services.getSettings()).revision, revision);
});

test("设置严格使用白名单，不能启用后台监控或注入宿主内部配置", async () => {
  const { services, preparedInputs, saves } = await fixture();
  const expectedRevision = (await services.getSettings()).revision;
  for (const config of [
    { bugMonitorEnabled: true },
    { wecomWebhook: "fixture-unauthorized-webhook" },
    { codexProjectPath: "C:\\unexpected-project" },
    { tokenProtected: "fake ciphertext" },
    { baseUrl: 123 },
    { maxResults: 0 },
    { maxResults: 1001 },
    { token: "x".repeat(16001) }
  ]) {
    await assert.rejects(services.saveSettings({ config, expectedRevision, acknowledged: true }), { code: "NATIVE_CONFIG_INVALID" });
  }
  assert.equal(preparedInputs.length, 0);
  assert.equal(saves.length, 0);
});

test("正确保存复用 Core prepare/save，返回新 revision 且不回显 PAT", async () => {
  const { services, preparedInputs, saves, configFile } = await fixture();
  const expectedRevision = (await services.getSettings()).revision;
  const input = {
    baseUrl: "https://other-jira.example.test",
    token: "fixture-new-pat",
    maxResults: 200,
    promptTemplates: { requirement: { customized: true, content: "fixture prompt" } }
  };
  const saved = await services.saveSettings({ config: input, expectedRevision, acknowledged: true });
  assert.deepEqual(preparedInputs, [input]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].token, "fixture-new-pat");
  assert.equal(saved.config.baseUrl, input.baseUrl);
  assert.equal(saved.config.maxResults, 200);
  assert.equal(saved.credentialConfigured, true);
  assert.notEqual(saved.revision, expectedRevision);
  assert.equal(saved.revision, createHash("sha256").update(await readFile(configFile)).digest("hex"));
  assert.doesNotMatch(JSON.stringify(saved), /fixture-new-pat|fixture-existing-pat|fixture-existing-webhook|tokenProtected/);
  await assert.rejects(services.saveSettings({ config: { maxResults: 300 }, expectedRevision, acknowledged: true }), { code: "NATIVE_CONFIG_REVISION_CONFLICT" });
  const second = await services.saveSettings({ config: { maxResults: 300 }, expectedRevision: saved.revision, acknowledged: true });
  assert.equal(second.config.maxResults, 300);
  assert.equal(saves[1].token, "fixture-new-pat", "不输入新 PAT 时交由 Core 保留原凭据");
});

test("配置被其他写入者改变时 hash CAS 阻止覆盖", async () => {
  const { services, configFile, saves } = await fixture();
  const expectedRevision = (await services.getSettings()).revision;
  await writeFile(configFile, JSON.stringify({ updatedBy: "fixture-other-process" }));
  await assert.rejects(services.saveSettings({ config: { maxResults: 500 }, expectedRevision, acknowledged: true }), { code: "NATIVE_CONFIG_REVISION_CONFLICT" });
  assert.equal(saves.length, 0);
  assert.match(await readFile(configFile, "utf8"), /fixture-other-process/);
});

test("同一实例串行处理保存，第二个旧 revision 操作不会覆盖第一个", async () => {
  const entered = deferred();
  const release = deferred();
  const { services, saves } = await fixture({
    onSave: async () => { entered.resolve(); await release.promise; }
  });
  const expectedRevision = (await services.getSettings()).revision;
  const first = services.saveSettings({ config: { maxResults: 200 }, expectedRevision, acknowledged: true });
  await entered.promise;
  const second = services.saveSettings({ config: { maxResults: 300 }, expectedRevision, acknowledged: true });
  const secondRejected = assert.rejects(second, { code: "NATIVE_CONFIG_REVISION_CONFLICT" });
  let readCompleted = false;
  const read = services.getSettings().then((settings) => { readCompleted = true; return settings; });
  await Promise.resolve();
  assert.equal(readCompleted, false);
  release.resolve();
  const firstResult = await first;
  await secondRejected;
  assert.equal((await read).config.maxResults, 200);
  assert.equal(saves.length, 1);
  assert.equal((await services.getSettings()).revision, firstResult.revision);
});

test("Core 保存失败不会污染后续保存队列，错误不携带秘密输入", async () => {
  let failed = false;
  const { services, saves } = await fixture({
    onSave: async () => {
      if (!failed) { failed = true; throw Object.assign(new Error("fixture protected storage unavailable"), { code: "FIXTURE_SAVE_FAILED" }); }
    }
  });
  const expectedRevision = (await services.getSettings()).revision;
  await assert.rejects(services.saveSettings({ config: { token: "fixture-failed-pat" }, expectedRevision, acknowledged: true }), {
    code: "FIXTURE_SAVE_FAILED",
    message: "fixture protected storage unavailable"
  });
  const recovered = await services.saveSettings({ config: { maxResults: 250 }, expectedRevision, acknowledged: true });
  assert.equal(recovered.config.maxResults, 250);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].token, "fixture-existing-pat");
  assert.doesNotMatch(JSON.stringify(recovered), /fixture-failed-pat|fixture-existing-pat/);
});

test("原生入口注册 app-only metadata，业务写工具保留 Core 确认约束", async () => {
  const { services } = await fixture();
  const client = await connectServices(services);
  const tools = (await client.listTools()).tools;
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const [name, type, uri] of [
    ["jira_codex_open_workbench", "global", JIRA_TASK_BOARD_RESOURCE_URI],
    ["jira_codex_open_thread_panel", "thread", THREAD_RESOURCE_URI],
    ["jira_codex_open_settings", "settings", SETTINGS_RESOURCE_URI]
  ]) {
    assert.deepEqual(byName[name]._meta["openai/ui"].entrypoints, [{ type }]);
    assert.deepEqual(byName[name]._meta.ui.visibility, ["app"]);
    assert.equal(byName[name]._meta.ui.resourceUri, uri);
    const opened = await client.callTool({ name, arguments: {} });
    assert.equal(opened.structuredContent.capabilities.conversationCreation, false);
    assert.equal(opened.structuredContent.capabilities.projectCatalog, false);
  }
  for (const name of ["jira_codex_status", "jira_codex_get_settings", "jira_codex_save_settings"]) {
    assert.deepEqual(byName[name]._meta.ui.visibility, ["app"]);
  }
  assert.equal(byName[JIRA_TASK_BOARD_TOOL]._meta["openai/ui"], undefined, "不把原生入口复制到每个业务工具");
  assert.equal(byName[JIRA_TASK_BOARD_TOOL].annotations.readOnlyHint, true);
  assert.deepEqual(byName.jira_bind_issue_workspace._meta.ui.visibility, ["app"]);
  assert.equal(byName.jira_bind_issue_workspace.annotations.readOnlyHint, false);
  const settings = await client.callTool({ name: "jira_codex_get_settings", arguments: {} });
  assert.doesNotMatch(JSON.stringify(settings), /fixture-existing-pat|fixture-existing-webhook/);
  const denied = await client.callTool({
    name: "jira_codex_save_settings",
    arguments: { config: {}, expectedRevision: settings.structuredContent.revision, acknowledged: false }
  });
  assert.equal(denied.isError, true);
  const availableResources = (await client.listResources()).resources;
  assert.deepEqual(availableResources.map(({ uri }) => uri).sort(), [JIRA_TASK_BOARD_RESOURCE_URI, THREAD_RESOURCE_URI, SETTINGS_RESOURCE_URI].sort());
});
