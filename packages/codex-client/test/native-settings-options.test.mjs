import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJiraTaskBoardMcpServer } from "@jira-workbench/core";
import { createNativeServices, SETTINGS_RESOURCE_URI } from "../lib/native-services.mjs";

const TOOL = "jira_codex_list_settings_options";
const PAT = "fixture-saved-pat-never-return";
const WEBHOOK = "fixture-saved-webhook-never-return";
const UPSTREAM = "fixture-upstream-private-response";
const SECRET_VALUES = [PAT, WEBHOOK, UPSTREAM];

function assertNoSecrets(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRET_VALUES) {
    assert.equal(serialized.includes(secret), false, "设置选项和错误不得包含凭据或上游私有原文");
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(context, {
  configured = true,
  hasToken = true,
  onPublic,
  onLoad,
  onProjects,
  onFilters
} = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), "jira-native-settings-options-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const configFile = join(dataRoot, "config.json");
  await writeFile(configFile, JSON.stringify({
    baseUrl: "https://jira.saved.example.test",
    tokenProtected: "fixture-encrypted-not-a-real-credential",
    boardSources: { projectKey: "SAVED" }
  }));
  const initialBytes = await readFile(configFile);
  const expectedRevision = createHash("sha256").update(initialBytes).digest("hex");
  const savedConfig = {
    baseUrl: "https://jira.saved.example.test",
    token: PAT,
    wecomWebhook: WEBHOOK,
    deployment: "data_center",
    boardSources: { projectKey: "SAVED" }
  };
  const projectRecords = [{
    id: "10101", key: "CT", name: "Fixture Project",
    token: PAT, authorization: `Bearer ${PAT}`
  }];
  const filterRecords = [{
    id: "10202", name: "Fixture Filter", owner: "Fixture Owner",
    favourite: true, projectMatch: "match",
    jql: `fixture-private-jql ${UPSTREAM}`, token: PAT, wecomWebhook: WEBHOOK
  }];
  const calls = { public: 0, load: 0, prepare: 0, save: 0, projects: [], filters: [] };
  const realNetwork = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("设置选项单测禁止真实联网。");
  });
  const core = {
    configStore: {
      configFile,
      getPublic: async () => {
        calls.public++;
        await onPublic?.({ configFile, calls });
        return { baseUrl: savedConfig.baseUrl, configured, hasToken };
      },
      load: async () => {
        calls.load++;
        await onLoad?.({ configFile, savedConfig, calls });
        return structuredClone(savedConfig);
      },
      prepare: async () => { calls.prepare++; throw new Error("只读工具不能 prepare 配置。"); },
      save: async () => { calls.save++; throw new Error("只读工具不能保存配置。"); }
    },
    jira: {
      fetchProjects: async (config) => {
        calls.projects.push(structuredClone(config));
        await onProjects?.({ configFile, config, calls });
        return { projects: structuredClone(projectRecords), token: PAT, site: savedConfig.baseUrl };
      },
      fetchFilters: async (config, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        const { signal, ...publicOptions } = options;
        calls.filters.push({ config: structuredClone(config), options: structuredClone(publicOptions) });
        await onFilters?.({ configFile, config, options, calls });
        return { filters: structuredClone(filterRecords), token: PAT, site: savedConfig.baseUrl };
      }
    },
    jiraWorkbench: { listTasks: async () => ({ issues: [], activeIssues: [], completedIssues: [], total: 0 }) },
    workspaceBindings: { get: async () => ({ revision: 0, binding: null }) },
    svnWorkbench: { context: async () => ({ changes: [], projectScopes: [] }) }
  };
  const services = createNativeServices({ dataRoot, version: "fixture-version", core });
  const definition = services.options.additionalTools.find(({ name }) => name === TOOL);
  assert.ok(definition, "原生服务必须注册设置选项工具");
  async function unchanged() {
    assert.deepEqual(await readFile(configFile), initialBytes);
    assert.equal(calls.prepare, 0);
    assert.equal(calls.save, 0);
    assert.equal(realNetwork.mock.callCount(), 0, "只允许使用 stub Jira，不访问真实网络");
  }
  return {
    services, definition, core, calls, configFile, expectedRevision,
    initialBytes, savedConfig, realNetwork, unchanged
  };
}

async function connectServices(context, services) {
  const server = createJiraTaskBoardMcpServer(services.options);
  const client = new Client({ name: "native-settings-options-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("设置选项工具是只读 app-only，初始化与状态读取不会自动联网或解密凭据", async (context) => {
  const f = await fixture(context);
  const client = await connectServices(context, f.services);
  const tool = (await client.listTools()).tools.find(({ name }) => name === TOOL);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  assert.equal(tool._meta.ui.resourceUri, SETTINGS_RESOURCE_URI);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["expectedRevision", "projectKey"]);
  assert.deepEqual(tool.inputSchema.required, ["expectedRevision"]);
  const status = await f.services.getStatus();
  assert.equal(status.availableTools.includes(TOOL), true);
  assert.equal(status.capabilities.projectCatalog, false, "Jira 项目选项不是 Codex 原生项目目录列表");
  await f.services.getSettings();
  assert.equal(f.calls.load, 0);
  assert.deepEqual(f.calls.projects, []);
  assert.deepEqual(f.calls.filters, []);
  await f.unchanged();
});

test("设置选项只用已保存配置读取 Jira，输出白名单不回显凭据或私有 JQL", async (context) => {
  const f = await fixture(context);
  const output = await f.definition.handler({
    expectedRevision: f.expectedRevision,
    projectKey: "CT",
    config: { baseUrl: "https://unsaved.example.test", token: "fixture-unsaved-token" },
    baseUrl: "https://unsaved.example.test",
    token: "fixture-unsaved-token"
  });
  assert.deepEqual(output.structuredContent, {
    view: "codexSettingsOptions",
    revision: f.expectedRevision,
    projects: [{ id: "10101", key: "CT", name: "Fixture Project" }],
    filters: [{ id: "10202", name: "Fixture Filter", owner: "Fixture Owner", favourite: true, projectMatch: "match" }],
    warnings: []
  });
  assert.equal(f.calls.load, 1);
  assert.deepEqual(f.calls.projects, [f.savedConfig]);
  assert.deepEqual(f.calls.filters, [{ config: f.savedConfig, options: { projectKey: "CT" } }]);
  assertNoSecrets(output);
  assert.doesNotMatch(JSON.stringify(output), /fixture-unsaved-token|unsaved\.example\.test|tokenProtected/);
  await f.unchanged();
});

test("设置选项经 MCP 拒绝缺失和非法 revision，不进行 Jira 读取或配置写入", async (context) => {
  const f = await fixture(context);
  const client = await connectServices(context, f.services);
  for (const input of [
    {},
    { expectedRevision: "" },
    { expectedRevision: "not-a-revision" },
    { expectedRevision: "A".repeat(64) },
    { expectedRevision: f.expectedRevision, projectKey: 42 },
    { expectedRevision: f.expectedRevision, projectKey: "CT ORDER BY created" },
    { expectedRevision: f.expectedRevision, projectKey: "X".repeat(51) }
  ]) {
    const output = await client.callTool({ name: TOOL, arguments: input });
    assert.equal(output.isError, true);
    assertNoSecrets(output);
  }
  assert.equal(f.calls.load, 0);
  assert.deepEqual(f.calls.projects, []);
  assert.deepEqual(f.calls.filters, []);
  await f.unchanged();
});

test("未配置连接或缺少已保存 Token 时拒绝读取选项，不提前调用私有配置或 Jira", async (context) => {
  for (const flags of [{ configured: false, hasToken: true }, { configured: true, hasToken: false }]) {
    const f = await fixture(context, flags);
    await assert.rejects(f.definition.handler({ expectedRevision: f.expectedRevision }), (error) => {
      assertNoSecrets(String(error.message));
      assert.match(error.message, /配置|连接|凭据|Token/);
      return true;
    });
    assert.equal(f.calls.load, 0);
    assert.deepEqual(f.calls.projects, []);
    assert.deepEqual(f.calls.filters, []);
    await f.unchanged();
  }
});

test("调用前配置已变化时拒绝旧 revision，不查询 Jira 或覆盖其他窗口的配置", async (context) => {
  const f = await fixture(context);
  const otherBytes = JSON.stringify({ changedBy: "fixture-other-window" });
  await writeFile(f.configFile, otherBytes);
  await assert.rejects(f.definition.handler({ expectedRevision: f.expectedRevision, projectKey: "CT" }), {
    code: "NATIVE_CONFIG_REVISION_CONFLICT"
  });
  assert.equal(f.calls.load, 0);
  assert.deepEqual(f.calls.projects, []);
  assert.deepEqual(f.calls.filters, []);
  assert.equal(await readFile(f.configFile, "utf8"), otherBytes);
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.realNetwork.mock.callCount(), 0);
});

test("Jira 读取期间配置 revision 变化时不接受旧选项结果", async (context) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(context, {
    onProjects: async () => { entered.resolve(); await release.promise; }
  });
  const operation = f.definition.handler({ expectedRevision: f.expectedRevision, projectKey: "CT" });
  const rejected = assert.rejects(operation, { code: "NATIVE_CONFIG_REVISION_CONFLICT" });
  await entered.promise;
  const otherBytes = JSON.stringify({ changedBy: "fixture-during-jira-read" });
  await writeFile(f.configFile, otherBytes);
  release.resolve();
  await rejected;
  assert.equal(await readFile(f.configFile, "utf8"), otherBytes);
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.realNetwork.mock.callCount(), 0);
});

test("项目读取失败可保留 Filter 选项，warning 不泄露上游原文或凭据", async (context) => {
  const f = await fixture(context, {
    onProjects: async () => { throw new Error(`${UPSTREAM} Bearer ${PAT} ${WEBHOOK}`); }
  });
  const output = await f.definition.handler({ expectedRevision: f.expectedRevision, projectKey: "CT" });
  assert.equal(output.structuredContent.view, "codexSettingsOptions");
  assert.equal(output.structuredContent.revision, f.expectedRevision);
  assert.deepEqual(output.structuredContent.projects, []);
  assert.deepEqual(output.structuredContent.filters, [
    { id: "10202", name: "Fixture Filter", owner: "Fixture Owner", favourite: true, projectMatch: "match" }
  ]);
  assert.equal(output.structuredContent.warnings.length, 1);
  assert.match(JSON.stringify(output.structuredContent.warnings), /项目/);
  assertNoSecrets(output);
  await f.unchanged();
});

test("Filter 读取失败可保留项目选项，warning 不泄露上游原文或凭据", async (context) => {
  const f = await fixture(context, {
    onFilters: async () => { throw new Error(`${UPSTREAM} Bearer ${PAT} ${WEBHOOK}`); }
  });
  const output = await f.definition.handler({ expectedRevision: f.expectedRevision, projectKey: "CT" });
  assert.equal(output.structuredContent.view, "codexSettingsOptions");
  assert.equal(output.structuredContent.revision, f.expectedRevision);
  assert.deepEqual(output.structuredContent.projects, [{ id: "10101", key: "CT", name: "Fixture Project" }]);
  assert.deepEqual(output.structuredContent.filters, []);
  assert.equal(output.structuredContent.warnings.length, 1);
  assert.match(JSON.stringify(output.structuredContent.warnings), /Filter|筛选/);
  assertNoSecrets(output);
  await f.unchanged();
});

test("私有配置读取失败返回固定脱敏错误，不启动 Jira 请求", async (context) => {
  const f = await fixture(context, {
    onLoad: async () => { throw new Error(`${UPSTREAM} ${PAT} ${WEBHOOK}`); }
  });
  const client = await connectServices(context, f.services);
  const output = await client.callTool({ name: TOOL, arguments: { expectedRevision: f.expectedRevision, projectKey: "CT" } });
  assert.equal(output.isError, true);
  assertNoSecrets(output);
  assert.match(JSON.stringify(output.content), /配置|凭据|读取/);
  assert.deepEqual(f.calls.projects, []);
  assert.deepEqual(f.calls.filters, []);
  await f.unchanged();
});

test("公开配置状态读取失败同样返回固定脱敏错误，不解密凭据或启动 Jira 请求", async (context) => {
  const f = await fixture(context, {
    onPublic: async () => { throw new Error(`${UPSTREAM} ${PAT} ${WEBHOOK}`); }
  });
  const client = await connectServices(context, f.services);
  const output = await client.callTool({ name: TOOL, arguments: { expectedRevision: f.expectedRevision } });
  assert.equal(output.isError, true);
  assertNoSecrets(output);
  assert.match(JSON.stringify(output.content), /配置|凭据|读取/);
  assert.equal(f.calls.load, 0);
  assert.deepEqual(f.calls.projects, []);
  assert.deepEqual(f.calls.filters, []);
  await f.unchanged();
});

test("项目与 Filter 均读取失败时返回空选项和两条脱敏 warning，不伪造成功数据", async (context) => {
  const fail = async () => { throw new Error(`${UPSTREAM} ${PAT} ${WEBHOOK}`); };
  const f = await fixture(context, { onProjects: fail, onFilters: fail });
  const output = await f.definition.handler({ expectedRevision: f.expectedRevision, projectKey: "CT" });
  assert.equal(output.structuredContent.view, "codexSettingsOptions");
  assert.equal(output.structuredContent.revision, f.expectedRevision);
  assert.deepEqual(output.structuredContent.projects, []);
  assert.deepEqual(output.structuredContent.filters, []);
  assert.equal(output.structuredContent.warnings.length, 2);
  assert.match(JSON.stringify(output.structuredContent.warnings), /项目/);
  assert.match(JSON.stringify(output.structuredContent.warnings), /Filter|筛选/);
  assertNoSecrets(output);
  await f.unchanged();
});

test("未指定项目 Key 仍可只读获取选项，不写入默认项目选择", async (context) => {
  const f = await fixture(context);
  const output = await f.definition.handler({ expectedRevision: f.expectedRevision });
  assert.equal(output.structuredContent.view, "codexSettingsOptions");
  assert.equal(output.structuredContent.revision, f.expectedRevision);
  assert.equal(output.structuredContent.projects.length, 1);
  assert.equal(output.structuredContent.filters.length, 1);
  assert.equal(f.calls.filters.length, 1);
  assert.deepEqual(Object.keys(f.calls.filters[0].options), ["projectKey"]);
  assert.equal(typeof f.calls.filters[0].options.projectKey, "string");
  assertNoSecrets(output);
  await f.unchanged();
});
