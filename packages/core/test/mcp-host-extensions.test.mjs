import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createJiraTaskBoardMcpServer,
  JIRA_TASK_BOARD_RESOURCE_URI,
  JIRA_TASK_BOARD_TOOL
} from "../mcp/jira-task-board-mcp.mjs";

const opened = [];
afterEach(async () => {
  while (opened.length) await opened.pop().close();
});

const workbench = {
  listTasks: async () => ({ issues: [], activeIssues: [], completedIssues: [], total: 0 })
};

async function connectServer(options = {}) {
  const server = createJiraTaskBoardMcpServer({ workbench, version: "test-version", ...options });
  const client = new Client({ name: "core-host-extension-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  opened.push(server, client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("未传宿主扩展时保留默认工具、资源和空外联 CSP", async () => {
  const client = await connectServer();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(({ name }) => name), [JIRA_TASK_BOARD_TOOL]);
  assert.equal(tools[0]._meta.ui.resourceUri, JIRA_TASK_BOARD_RESOURCE_URI);
  assert.equal(tools[0]._meta["openai/outputTemplate"], JIRA_TASK_BOARD_RESOURCE_URI);
  assert.equal(tools[0]._meta["openai/ui"], undefined);

  const resources = (await client.listResources()).resources;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].name, "jira-workbench");
  assert.equal(resources[0].title, "Jira 任务工作台");
  const resource = (await client.readResource({ uri: JIRA_TASK_BOARD_RESOURCE_URI })).contents[0];
  assert.match(resource.text, /Jira Sheets/);
  assert.match(resource.text, /test-version/);
  assert.deepEqual(resource._meta, {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }
  });
});

test("宿主可覆盖默认工作台 HTML 并追加独立会话与设置资源", async () => {
  const threadUri = "ui://native-test/thread.html";
  const settingsUri = "ui://native-test/settings.html";
  const loads = [];
  const client = await connectServer({
    uiResources: [
      {
        uri: JIRA_TASK_BOARD_RESOURCE_URI,
        loadHtml: async (context) => {
          loads.push(context);
          return "<main>native global __JIRA_WORKBENCH_VERSION__</main>";
        },
        _meta: { ui: { prefersBorder: false }, "openai/ui": { availableDisplayModes: ["fullscreen"] } }
      },
      {
        name: "native-thread",
        uri: threadUri,
        title: "会话任务",
        loadHtml: ({ version }) => `<main>native thread ${version}</main>`
      },
      {
        name: "native-settings",
        uri: settingsUri,
        loadHtml: () => "<main>native settings</main>",
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
      }
    ]
  });
  assert.equal(loads.length, 0, "自定义 HTML 在读取资源前不执行");
  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map(({ uri }) => uri).sort(), [JIRA_TASK_BOARD_RESOURCE_URI, threadUri, settingsUri].sort());
  assert.equal(resources.find(({ uri }) => uri === JIRA_TASK_BOARD_RESOURCE_URI).title, "Jira 任务工作台");
  const global = (await client.readResource({ uri: JIRA_TASK_BOARD_RESOURCE_URI })).contents[0];
  assert.equal(global.text, "<main>native global test-version</main>");
  assert.deepEqual(loads, [{ uri: JIRA_TASK_BOARD_RESOURCE_URI, version: "test-version" }]);
  assert.equal(global._meta.ui.prefersBorder, false);
  assert.deepEqual(global._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.deepEqual(global._meta["openai/ui"].availableDisplayModes, ["fullscreen"]);
  assert.equal((await client.readResource({ uri: threadUri })).contents[0].text, "<main>native thread test-version</main>");
  assert.equal((await client.readResource({ uri: settingsUri })).contents[0].mimeType, "text/html;profile=mcp-app");
});

test("宿主入口元数据透传且不修改内置业务 handler", async () => {
  const client = await connectServer({
    toolMetadata: ({ name }) => name === JIRA_TASK_BOARD_TOOL ? {
      ui: { visibility: ["app", "model"] },
      "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] }
    } : undefined
  });
  const [tool] = (await client.listTools()).tools;
  assert.equal(tool._meta.ui.resourceUri, JIRA_TASK_BOARD_RESOURCE_URI);
  assert.deepEqual(tool._meta.ui.visibility, ["app", "model"]);
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "global" }, { type: "thread" }]);
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await client.callTool({ name: JIRA_TASK_BOARD_TOOL, arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.counts.active, 0);
});

test("宿主额外工具保留 app-only visibility、输入校验与能力降级结果", async () => {
  const calls = [];
  const client = await connectServer({
    additionalTools: [{
      name: "native_settings_entry",
      title: "设置",
      description: "宿主用户设置入口，不返回凭据。",
      inputSchema: { section: z.enum(["connection", "templates"]).optional().default("connection") },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: {
        ui: { resourceUri: JIRA_TASK_BOARD_RESOURCE_URI, visibility: ["app"] },
        "openai/ui": { entrypoints: [{ type: "settings" }] }
      },
      handler: async ({ section }) => {
        calls.push(section);
        return {
          structuredContent: { section, capabilities: { createConversation: false } },
          content: [{ type: "text", text: "设置已就绪；尚未验证的宿主能力保持关闭。" }]
        };
      }
    }]
  });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 2);
  const settings = tools.find(({ name }) => name === "native_settings_entry");
  assert.deepEqual(settings._meta.ui.visibility, ["app"]);
  assert.deepEqual(settings._meta["openai/ui"].entrypoints, [{ type: "settings" }]);
  const result = await client.callTool({ name: settings.name, arguments: {} });
  assert.deepEqual(result.structuredContent, { section: "connection", capabilities: { createConversation: false } });
  assert.deepEqual(calls, ["connection"]);
  const invalid = await client.callTool({ name: settings.name, arguments: { section: "unsupported" } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(calls, ["connection"]);
});

test("宿主扩展拒绝重复名称、错误提供者和无效元数据", () => {
  const create = (options) => createJiraTaskBoardMcpServer({ workbench, ...options });
  assert.throws(() => create({ additionalTools: [{ name: JIRA_TASK_BOARD_TOOL, handler() {} }] }), /工具 name 重复/);
  assert.throws(() => create({ additionalTools: [{ name: "extra" }] }), /handler 函数/);
  assert.throws(() => create({ additionalTools: {} }), /additionalTools 必须是数组/);
  assert.throws(() => create({ uiResources: {} }), /uiResources 必须是数组/);
  assert.throws(() => create({ uiResources: [{ name: "extra", uri: "ui://test/extra" }] }), /loadHtml 必须是函数/);
  assert.throws(() => create({ uiResources: [{ uri: "ui://test/extra", loadHtml() {} }] }), /非空 name/);
  assert.throws(() => create({ uiResources: [
    { name: "extra", uri: "ui://test/extra", loadHtml() {} },
    { name: "extra-two", uri: "ui://test/extra", loadHtml() {} }
  ] }), /uri 重复/);
  assert.throws(() => create({ uiResources: [{ name: "jira-workbench", uri: "ui://test/extra", loadHtml() {} }] }), /Resource name 重复/);
  assert.throws(() => create({ toolMetadata: {} }), /toolMetadata 必须是函数/);
  assert.throws(() => create({ invokeTool: {} }), /invokeTool 必须是函数/);
  assert.throws(() => create({ toolMetadata: () => [] }), /元数据对象/);
  assert.throws(() => create({ toolMetadata: () => ({ ui: [] }) }), /ui 必须是元数据对象/);
});

test("资源提供者必须返回 HTML 字符串", async () => {
  const client = await connectServer({
    uiResources: [{ uri: JIRA_TASK_BOARD_RESOURCE_URI, loadHtml: async () => ({ text: "not HTML" }) }]
  });
  await assert.rejects(client.readResource({ uri: JIRA_TASK_BOARD_RESOURCE_URI }), /loadHtml 必须返回字符串/);
});

test("宿主可跟踪真实工具生命周期，保留 extra 并在业务异常后释放计数", async () => {
  const observations = [];
  let active = 0;
  let handlerExtra;
  const client = await connectServer({
    additionalTools: [{
      name: "tracked_host_operation",
      inputSchema: { fail: z.boolean().optional().default(false) },
      handler: async ({ fail }, extra) => {
        handlerExtra = extra;
        if (fail) throw new Error("fixture business failure");
        return { content: [{ type: "text", text: "fixture operation completed" }] };
      }
    }],
    invokeTool: async (definition, args, extra) => {
      active++;
      observations.push({ name: definition.name, args, extra });
      try { return await definition.handler(args, extra); }
      finally { active--; }
    }
  });
  const success = await client.callTool({ name: "tracked_host_operation", arguments: {} });
  assert.equal(success.content[0].text, "fixture operation completed");
  assert.equal(active, 0);
  assert.equal(observations[0].name, "tracked_host_operation");
  assert.deepEqual(observations[0].args, { fail: false });
  assert.equal(observations[0].extra, handlerExtra);
  assert.equal(typeof handlerExtra.requestId, "number");
  assert.equal(handlerExtra.signal instanceof AbortSignal, true);
  const failure = await client.callTool({ name: "tracked_host_operation", arguments: { fail: true } });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /fixture business failure/);
  assert.equal(active, 0);
  assert.equal(observations.length, 2);
});
