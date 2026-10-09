import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startNativeRuntime } from "../lib/runtime-server.mjs";
import {
  descriptorPath,
  ensureNativeRuntime,
  probeRuntime,
  readDescriptor,
  runtimeIdentity,
  runtimePort,
  runtimeRequest
} from "../lib/runtime-client.mjs";
import { RUNTIME_PROTOCOL, VERSION } from "../lib/version.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function getHttp(url, headers) {
  return new Promise((resolve, reject) => {
    const request = requestHttp(new URL(url), { headers }, (response) => {
      const chunks = [];
      response.on("data", (bytes) => chunks.push(bytes));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("fixture HTTP timeout")));
    request.end();
  });
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error("fixture wait timed out");
}

async function temporaryRoot() {
  const dataRoot = await mkdtemp(join(tmpdir(), "jira-native-runtime-test-"));
  cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  return dataRoot;
}

function fakeServices({ additionalTools = [], activeOperations = () => [] } = {}) {
  return {
    options: {
      loadIssues: async () => ({ issues: [], activeIssues: [], completedIssues: [], total: 0 }),
      additionalTools
    },
    core: { svnReviews: { getActiveOperations: activeOperations } },
    getActiveOperations: activeOperations
  };
}

async function startFixture(options = {}) {
  const dataRoot = options.dataRoot || await temporaryRoot();
  const runtime = await startNativeRuntime({
    dataRoot,
    port: 0,
    version: "fixture-version",
    services: fakeServices(),
    idleTimeoutMs: 10000,
    ...options
  });
  cleanup.push(() => runtime.close());
  return { dataRoot, runtime };
}

test("原生 daemon 只接受 bearer 认证的精确本机 Host，拒绝浏览器 Origin", async () => {
  const { runtime } = await startFixture();
  const { descriptor } = runtime;
  const url = `${descriptor.url}/health`;
  const authorization = `Bearer ${descriptor.token}`;
  for (const headers of [
    {},
    { authorization: "Bearer fixture-invalid-token" },
    { authorization, origin: "https://untrusted.example.test" },
    { authorization, origin: descriptor.url },
    { authorization, host: "localhost:12345" }
  ]) {
    // node:http preserves an explicitly supplied Host, unlike some Fetch
    // implementations that normalize it before the request reaches the server.
    const response = await getHttp(url, headers);
    assert.equal(response.status, 403);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(response.body, new RegExp(descriptor.token));
  }
  const health = await runtimeRequest(descriptor, "/health");
  assert.deepEqual(health, {
    identity: descriptor.identity,
    version: "fixture-version",
    protocol: RUNTIME_PROTOCOL,
    pid: process.pid,
    closing: false
  });
  assert.equal(health.token, undefined);
});

test("描述符仅记录已监听的服务，关闭时不删除其他所有者的记录", async () => {
  const { dataRoot, runtime } = await startFixture();
  const original = JSON.parse(await readFile(descriptorPath(dataRoot), "utf8"));
  assert.deepEqual(original, runtime.descriptor);
  const unknownOwner = { ...original, pid: original.pid + 1, token: "0".repeat(64) };
  await writeFile(descriptorPath(dataRoot), JSON.stringify(unknownOwner));
  await runtime.close();
  assert.deepEqual(JSON.parse(await readFile(descriptorPath(dataRoot), "utf8")), unknownOwner);
});

test("固定端口作为同数据目录的 OS 单实例锁，失败实例不覆盖描述符", async () => {
  const dataRoot = await temporaryRoot();
  const { runtime } = await startFixture({ dataRoot, port: runtimePort(dataRoot) });
  const before = await readFile(descriptorPath(dataRoot), "utf8");
  await assert.rejects(startNativeRuntime({
    dataRoot,
    version: "fixture-version",
    services: fakeServices(),
    idleTimeoutMs: 10000
  }), { code: "EADDRINUSE" });
  assert.equal(await readFile(descriptorPath(dataRoot), "utf8"), before);
  assert.deepEqual(await readDescriptor(dataRoot), runtime.descriptor);
  assert.equal((await probeRuntime(dataRoot, { version: "fixture-version" })).pid, process.pid);
  await assert.rejects(probeRuntime(dataRoot, { version: "other-version" }), /版本不一致/);
});

test("描述符验证拒绝未知服务地址、错误身份与无效认证 token", async () => {
  const { dataRoot, runtime } = await startFixture({ port: undefined });
  const path = descriptorPath(dataRoot);
  const original = runtime.descriptor;
  for (const patch of [
    { url: "https://untrusted.example.test" },
    { identity: "0".repeat(64) },
    { token: "fixture-plaintext-not-a-token" },
    { pid: -1 }
  ]) {
    await writeFile(path, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(readDescriptor(dataRoot), /地址记录无效/);
  }
  await writeFile(path, "{broken-json");
  assert.equal(await readDescriptor(dataRoot), null);
  await writeFile(path, JSON.stringify(original));
});

test("有效租约阻止空闲退出，释放或过期后再回收服务", async () => {
  for (const releaseExplicitly of [true, false]) {
    let idled = false;
    const { runtime } = await startFixture({
      idleTimeoutMs: 70,
      leaseTtlMs: releaseExplicitly ? 2000 : 350,
      onIdle: () => { idled = true; }
    });
    const id = randomUUID();
    await runtimeRequest(runtime.descriptor, "/lease", { method: "POST", body: { id } });
    await delay(170);
    assert.equal(idled, false);
    if (releaseExplicitly) {
      await runtimeRequest(runtime.descriptor, "/lease", { method: "POST", body: { id, release: true } });
    }
    await waitUntil(() => idled);
    assert.equal(runtime.server.listening, false);
  }
});

test("无效或过大租约请求被拒绝且错误不回显请求内容", async () => {
  const { runtime } = await startFixture();
  for (const body of [
    JSON.stringify({ id: "fixture-invalid-id" }),
    JSON.stringify({ id: randomUUID(), unknown: "fixture-secret-body".repeat(300) })
  ]) {
    const response = await fetch(`${runtime.descriptor.url}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.descriptor.token}`, "content-type": "application/json" },
      body
    });
    assert.equal([400, 413, 500].includes(response.status), true);
    assert.doesNotMatch(await response.text(), /fixture-secret-body/);
  }
});

test("客户端断线后实际工具仍运行时不会释放单实例锁或空闲退出", async () => {
  const entered = deferred();
  const release = deferred();
  let idled = false;
  const { runtime } = await startFixture({
    idleTimeoutMs: 50,
    onIdle: () => { idled = true; },
    services: fakeServices({ additionalTools: [{
      name: "fixture_slow_mutation",
      inputSchema: {},
      annotations: { readOnlyHint: false },
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { content: [{ type: "text", text: "fixture completed" }] };
      }
    }] })
  });
  const controller = new AbortController();
  const request = fetch(`${runtime.descriptor.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.descriptor.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture_slow_mutation", arguments: {} } }),
    signal: controller.signal
  }).catch((error) => error);
  try {
    await entered.promise;
    controller.abort();
    await request;
    await delay(180);
    assert.equal(idled, false, "响应已关闭不等于业务 handler 已结束");
    assert.equal(runtime.server.listening, true);
    assert.equal((await runtimeRequest(runtime.descriptor, "/health")).identity, runtime.descriptor.identity);
  } finally {
    controller.abort();
    release.resolve();
  }
  await waitUntil(() => idled);
});

test("活跃 Core 提交状态阻止空闲回收，状态清空后正常退出", async () => {
  let committing = true;
  let idled = false;
  const { runtime } = await startFixture({
    idleTimeoutMs: 50,
    onIdle: () => { idled = true; },
    services: fakeServices({ activeOperations: () => committing ? [{ kind: "svn_commit", status: "committing" }] : [] })
  });
  await delay(180);
  assert.equal(idled, false);
  assert.equal(runtime.server.listening, true);
  committing = false;
  await waitUntil(() => idled);
});

test("正常关闭在断线业务完成前保留监听锁，拒绝新写入且不删除描述符", async () => {
  const entered = deferred();
  const release = deferred();
  const { dataRoot, runtime } = await startFixture({
    services: fakeServices({ additionalTools: [{
      name: "fixture_draining_mutation",
      inputSchema: {},
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { content: [{ type: "text", text: "fixture drained" }] };
      }
    }] })
  });
  const controller = new AbortController();
  const request = fetch(`${runtime.descriptor.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.descriptor.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture_draining_mutation", arguments: {} } }),
    signal: controller.signal
  }).catch((error) => error);
  let closeCompleted = false;
  let closing;
  try {
    await entered.promise;
    controller.abort();
    await request;
    closing = runtime.close().then(() => { closeCompleted = true; });
    await delay(80);
    assert.equal(closeCompleted, false);
    assert.equal(runtime.server.listening, true);
    assert.equal((await runtimeRequest(runtime.descriptor, "/health")).closing, true);
    assert.equal(JSON.parse(await readFile(descriptorPath(dataRoot), "utf8")).token, runtime.descriptor.token);
    const rejected = await fetch(`${runtime.descriptor.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.descriptor.token}`, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(rejected.status, 503);
    await rejected.arrayBuffer();
    await assert.rejects(startNativeRuntime({
      dataRoot,
      port: Number(new URL(runtime.descriptor.url).port),
      services: fakeServices()
    }), { code: "EADDRINUSE" });
  } finally {
    controller.abort();
    release.resolve();
  }
  await closing;
  assert.equal(closeCompleted, true);
  assert.equal(runtime.server.listening, false);
  await assert.rejects(readFile(descriptorPath(dataRoot)), { code: "ENOENT" });
});

test("并行宿主启动复用同一个 daemon PID 和认证描述符", { timeout: 15000 }, async () => {
  const dataRoot = await temporaryRoot();
  let descriptor;
  // The spawned daemon has no Jira configuration and uses only this new test
  // directory. Wait for its normal idle exit before removing that directory.
  cleanup.push(async () => {
    if (!descriptor) return;
    await waitUntil(async () => {
      try { await readFile(descriptorPath(dataRoot)); return false; }
      catch (error) { if (error.code === "ENOENT") return true; throw error; }
    }, 5000);
  });
  const options = { dataRoot, version: VERSION, idleTimeoutMs: 1000, leaseTtlMs: 3000, startupTimeoutMs: 10000 };
  const [first, second] = await Promise.all([ensureNativeRuntime(options), ensureNativeRuntime(options)]);
  descriptor = first;
  assert.equal(first.identity, runtimeIdentity(dataRoot));
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.pid, process.pid);
  assert.deepEqual(first, second);
  assert.equal((await runtimeRequest(first, "/health")).protocol, RUNTIME_PROTOCOL);
});
