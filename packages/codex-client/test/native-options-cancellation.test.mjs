import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiraClient } from "@jira-workbench/core";
import { createNativeServices } from "../lib/native-services.mjs";

const CONFIG = {
  baseUrl: "https://jira.cancellation.example.test",
  deployment: "data_center",
  token: "fixture-pat-not-a-real-credential"
};

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function preventNetwork(context) {
  const network = context.mock.method(globalThis, "fetch", async () => {
    throw new Error("取消测试禁止真实联网。");
  });
  context.after(() => assert.equal(network.mock.callCount(), 0));
}

function waitForAbort(signal, onAbort = () => {}) {
  assert.ok(signal instanceof AbortSignal, "读取必须将取消信号传给实际 Jira 请求");
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(guard);
      signal.removeEventListener("abort", abort);
      onAbort();
      reject(signal.reason || new DOMException("fixture cancellation", "AbortError"));
    };
    const guard = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      reject(new Error("fixture request was not cancelled"));
    }, 1000);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function nativeFixture(context, {
  settingsOptionsTimeoutMs = 2000,
  onProjects = async () => ({ projects: [{ id: "1", key: "CT", name: "Fixture" }] }),
  onFilters = async () => ({ filters: [{ id: "2", name: "Fixture Filter" }] })
} = {}) {
  preventNetwork(context);
  const dataRoot = await mkdtemp(join(tmpdir(), "jira-native-options-cancel-"));
  const configFile = join(dataRoot, "config.json");
  await writeFile(configFile, JSON.stringify({ baseUrl: CONFIG.baseUrl, tokenProtected: "fixture-only" }));
  const initialBytes = await readFile(configFile);
  const expectedRevision = createHash("sha256").update(initialBytes).digest("hex");
  const calls = { projects: [], filters: [], writes: 0 };
  const core = {
    configStore: {
      configFile,
      getPublic: async () => ({ configured: true, hasToken: true, baseUrl: CONFIG.baseUrl }),
      load: async () => ({ ...CONFIG }),
      prepare: async () => { calls.writes++; throw new Error("取消测试不应准备配置写入"); },
      save: async () => { calls.writes++; throw new Error("取消测试不应保存配置"); }
    },
    jira: {
      fetchProjects: async (config, options = {}) => {
        const call = { config, ...options };
        calls.projects.push(call);
        return onProjects(call);
      },
      fetchFilters: async (config, options = {}) => {
        const call = { config, ...options };
        calls.filters.push(call);
        return onFilters(call);
      }
    },
    jiraWorkbench: { listTasks: async () => ({ issues: [], activeIssues: [], completedIssues: [], total: 0 }) },
    workspaceBindings: { get: async () => ({ revision: 0, binding: null }) },
    svnWorkbench: { context: async () => ({ changes: [], projectScopes: [] }) }
  };
  const services = createNativeServices({ dataRoot, core, settingsOptionsTimeoutMs });
  context.after(async () => {
    try {
      assert.equal(calls.writes, 0);
      assert.deepEqual(await readFile(configFile), initialBytes);
    } finally { await rm(dataRoot, { recursive: true, force: true }); }
  });
  return { services, calls, expectedRevision };
}

test("设置选项总超时取消项目与 Filter 的实际请求，不返回伪成功空目录", { timeout: 2000 }, async (context) => {
  let abortedProjects = 0, abortedFilters = 0;
  const f = await nativeFixture(context, {
    settingsOptionsTimeoutMs: 15,
    onProjects: ({ signal }) => waitForAbort(signal, () => { abortedProjects++; }),
    onFilters: ({ signal }) => waitForAbort(signal, () => { abortedFilters++; })
  });
  await assert.rejects(f.services.listSettingsOptions({ expectedRevision: f.expectedRevision, projectKey: "CT" }), (error) => {
    assert.match(String(error.code), /TIMEOUT/);
    assert.equal(String(error.message).includes(CONFIG.token), false);
    return true;
  });
  assert.equal(f.calls.projects.length, 1);
  assert.equal(f.calls.filters.length, 1);
  assert.equal(abortedProjects, 1);
  assert.equal(abortedFilters, 1);
  assert.equal(f.calls.projects[0].signal.aborted, true);
  assert.equal(f.calls.filters[0].signal.aborted, true);
});

test("相同 revision 和项目的并发设置读取单飞，重复点击不叠加 Jira 请求", { timeout: 2000 }, async (context) => {
  const entered = deferred(), release = deferred();
  context.after(() => release.resolve());
  const f = await nativeFixture(context, {
    onProjects: async () => { entered.resolve(); await release.promise; return { projects: [{ id: "1", key: "CT", name: "Fixture" }] }; },
    onFilters: async () => { await release.promise; return { filters: [{ id: "2", name: "Fixture Filter" }] }; }
  });
  const input = { expectedRevision: f.expectedRevision, projectKey: "CT" };
  const first = f.services.listSettingsOptions(input);
  const second = f.services.listSettingsOptions({ ...input });
  await entered.promise;
  const third = f.services.listSettingsOptions({ ...input });
  release.resolve();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(f.calls.projects.length, 1);
  assert.equal(f.calls.filters.length, 1);
  assert.ok(f.calls.projects[0].signal instanceof AbortSignal);
  assert.ok(f.calls.filters[0].signal instanceof AbortSignal);
});

test("不同项目或 revision 的进行中请求返回 BUSY，不启动额外 Jira 读取", { timeout: 2000 }, async (context) => {
  const entered = deferred(), release = deferred();
  context.after(() => release.resolve());
  const f = await nativeFixture(context, {
    onProjects: async () => { entered.resolve(); await release.promise; return { projects: [] }; },
    onFilters: async () => { await release.promise; return { filters: [] }; }
  });
  const first = f.services.listSettingsOptions({ expectedRevision: f.expectedRevision, projectKey: "CT" });
  await entered.promise;
  for (const input of [
    { expectedRevision: f.expectedRevision, projectKey: "OTHER" },
    { expectedRevision: "f".repeat(64), projectKey: "CT" }
  ]) {
    await assert.rejects(f.services.listSettingsOptions(input), { code: "NATIVE_OPTIONS_BUSY" });
  }
  assert.equal(f.calls.projects.length, 1);
  assert.equal(f.calls.filters.length, 1);
  release.resolve();
  await first;
});

test("取消完成后释放选项单飞锁，随后请求可正常读取新的结果", { timeout: 2000 }, async (context) => {
  let blocked = true;
  const f = await nativeFixture(context, {
    settingsOptionsTimeoutMs: 15,
    onProjects: ({ signal }) => blocked ? waitForAbort(signal) : { projects: [{ id: "3", key: "NEW", name: "New" }] },
    onFilters: ({ signal }) => blocked ? waitForAbort(signal) : { filters: [{ id: "4", name: "New Filter" }] }
  });
  await assert.rejects(f.services.listSettingsOptions({ expectedRevision: f.expectedRevision, projectKey: "CT" }));
  blocked = false;
  const result = await f.services.listSettingsOptions({ expectedRevision: f.expectedRevision, projectKey: "NEW" });
  assert.deepEqual(result.projects, [{ id: "3", key: "NEW", name: "New" }]);
  assert.equal(result.filters[0].id, "4");
  assert.deepEqual(result.warnings, []);
  assert.equal(f.calls.projects.length, 2);
  assert.equal(f.calls.filters.length, 2);
});

test("Core 项目和 Filter 对已取消的外部信号不发送任何请求", async (context) => {
  preventNetwork(context);
  const controller = new AbortController();
  controller.abort(new DOMException("fixture cancelled before dispatch", "AbortError"));
  const calls = [];
  const jira = createJiraClient({ fetchImpl: async (url, { signal }) => {
    calls.push(String(url));
    return waitForAbort(signal);
  } });
  await assert.rejects(jira.fetchProjects(CONFIG, { signal: controller.signal }));
  await assert.rejects(jira.fetchFilters(CONFIG, { projectKey: "CT", signal: controller.signal }));
  assert.deepEqual(calls, []);
});

test("Core 项目读取组合外部信号，取消能中止实际在途 fetch", { timeout: 2000 }, async (context) => {
  preventNetwork(context);
  const controller = new AbortController(), entered = deferred();
  const calls = [];
  let aborted = 0;
  const jira = createJiraClient({ timeoutMs: 5000, fetchImpl: (url, { signal }) => {
    calls.push({ url: String(url), signal });
    entered.resolve();
    return waitForAbort(signal, () => { aborted++; });
  } });
  const operation = jira.fetchProjects(CONFIG, { signal: controller.signal });
  const rejected = assert.rejects(operation);
  await entered.promise;
  controller.abort(new DOMException("fixture project cancellation", "AbortError"));
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(aborted, 1);
});

test("Core Filter 首个请求取消后不继续 my/favourite 或 HTML 回退", { timeout: 2000 }, async (context) => {
  preventNetwork(context);
  const controller = new AbortController(), entered = deferred();
  const calls = [];
  const jira = createJiraClient({ timeoutMs: 5000, fetchImpl: (url, { signal }) => {
    calls.push(String(url));
    entered.resolve();
    return waitForAbort(signal);
  } });
  const operation = jira.fetchFilters(CONFIG, { projectKey: "CT", signal: controller.signal });
  const rejected = assert.rejects(operation);
  await entered.promise;
  controller.abort(new DOMException("fixture filter cancellation", "AbortError"));
  await rejected;
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/filter\/search\?/);
});

test("Core Filter 分页中取消后不再翻页、读取其他来源或回退", { timeout: 2000 }, async (context) => {
  preventNetwork(context);
  const controller = new AbortController(), entered = deferred();
  const calls = [];
  const jira = createJiraClient({ timeoutMs: 5000, fetchImpl: (url, { signal }) => {
    signal.throwIfAborted();
    calls.push(String(url));
    if (calls.length === 1) return Promise.resolve(jsonResponse({ values: [{ id: "1", name: "Page 1" }], total: 3, maxResults: 1 }));
    entered.resolve();
    return waitForAbort(signal);
  } });
  const operation = jira.fetchFilters(CONFIG, { projectKey: "CT", signal: controller.signal });
  const rejected = assert.rejects(operation);
  await entered.promise;
  controller.abort(new DOMException("fixture pagination cancellation", "AbortError"));
  await rejected;
  assert.equal(calls.length, 2);
  assert.match(calls[1], /startAt=1/);
});

test("Core Filter HTML 回退读取中取消后不启动 Filter 详情请求", { timeout: 2000 }, async (context) => {
  preventNetwork(context);
  const controller = new AbortController(), entered = deferred();
  const calls = [];
  const jira = createJiraClient({ timeoutMs: 5000, fetchImpl: (url, { signal }) => {
    signal.throwIfAborted();
    calls.push(String(url));
    if (!String(url).includes("ManageFilters.jspa")) return Promise.resolve(jsonResponse({ errorMessages: ["fixture missing endpoint"] }, 404));
    entered.resolve();
    return waitForAbort(signal);
  } });
  const operation = jira.fetchFilters(CONFIG, { projectKey: "CT", signal: controller.signal });
  const rejected = assert.rejects(operation);
  await entered.promise;
  controller.abort(new DOMException("fixture HTML fallback cancellation", "AbortError"));
  await rejected;
  assert.equal(calls.length, 4);
  assert.match(calls.at(-1), /ManageFilters\.jspa/);
});
