import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiraTaskBoardMcpHttpHandler } from "@jira-workbench/core";
import { createNativeServices } from "./native-services.mjs";
import { descriptorPath, runtimeIdentity, runtimePort } from "./runtime-client.mjs";
import { VERSION, RUNTIME_PROTOCOL } from "./version.mjs";

function send(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

async function smallBody(request) {
  let text = "";
  for await (const bytes of request) {
    text += bytes.toString("utf8");
    if (text.length > 4096) throw new Error("请求过大。");
  }
  return JSON.parse(text || "{}");
}

export async function startNativeRuntime({
  dataRoot, version = VERSION, services,
  idleTimeoutMs = 15000, leaseTtlMs = 45000, onIdle = () => {}, port
} = {}) {
  if (!dataRoot) throw new TypeError("必须指定原生服务数据目录。");
  dataRoot = resolve(dataRoot);
  const token = randomBytes(32).toString("hex");
  const identity = runtimeIdentity(dataRoot);
  const selectedPort = port ?? runtimePort(dataRoot);
  let native;
  let handleMcp;
  const leases = new Map();
  let activeRequests = 0;
  let toolOperations = 0;
  let lastActivity = Date.now();
  let closed = false;
  let closePromise;
  let endpoint;
  const server = createServer(async (request, response) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(String(request.headers.authorization || ""));
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${endpoint?.port}`
        || request.headers.origin || received.length !== expected.length
        || !timingSafeEqual(received, expected)) {
      return send(response, 403, { error: "仅允许已认证的本机插件连接。" });
    }
    activeRequests++;
    lastActivity = Date.now();
    response.once("close", () => { activeRequests--; lastActivity = Date.now(); });
    try {
      if (request.url === "/health" && request.method === "GET") {
        return send(response, 200, { identity, version, protocol: RUNTIME_PROTOCOL, pid: process.pid, closing: closed });
      }
      if (closed) return send(response, 503, { error: "服务正在等待已开始的操作完成，请稍后重试。" });
      if (request.url === "/lease" && request.method === "POST") {
        const { id, release } = await smallBody(request);
        if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) return send(response, 400, { error: "连接标识无效。" });
        if (release === true) leases.delete(id);
        else leases.set(id, Date.now());
        return send(response, 200, { accepted: true });
      }
      if (request.url === "/mcp") return await handleMcp(request, response);
      send(response, 404, { error: "接口不存在。" });
    } catch {
      // Never log request bodies or include credentials in failures.
      if (!response.headersSent) send(response, 500, { error: "原生服务请求失败。" });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  await new Promise((complete, fail) => {
    server.once("error", fail);
    server.listen(selectedPort, "127.0.0.1", complete);
  });
  endpoint = { port: server.address().port };
  const descriptor = { identity, version, protocol: RUNTIME_PROTOCOL, pid: process.pid,
    url: `http://127.0.0.1:${endpoint.port}`, token };
  const path = descriptorPath(dataRoot);
  try {
    // Only the process that owns the listener may construct a stateful Core.
    native = services || createNativeServices({ dataRoot, version });
    handleMcp = createJiraTaskBoardMcpHttpHandler({
      ...native.options,
      invokeTool: async (definition, args, extra) => {
        if (closed) throw new Error("服务正在正常退出，未开始新的业务操作。");
        toolOperations++;
        try { return await definition.handler(args, extra); }
        finally { toolOperations--; lastActivity = Date.now(); }
      }
    });
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(descriptor), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    server.closeAllConnections();
    await new Promise((complete) => server.close(complete));
    throw error;
  }
  const backgroundOperations = () => native?.core?.svnReviews?.getActiveOperations?.().length || 0;
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    clearInterval(idleTimer);
    closePromise = (async () => {
      // Keep the OS-owned listener until actual work finishes, even after the
      // originating HTTP connection disappears. Never interrupt an SVN commit
      // or release the single-writer lock while a write is still in flight.
      while (toolOperations || backgroundOperations()) await new Promise((complete) => setTimeout(complete, 100));
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (owner.pid === process.pid && owner.token === token) await unlink(path);
      } catch { /* Do not delete an unknown owner's record. */ }
      server.closeIdleConnections();
      await new Promise((complete) => server.close(complete));
    })();
    return closePromise;
  }
  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastSeen] of leases) if (now - lastSeen > leaseTtlMs) leases.delete(id);
    if (!closed && !leases.size && activeRequests === 0 && toolOperations === 0
        && backgroundOperations() === 0 && now - lastActivity > idleTimeoutMs) {
      void close().then(onIdle);
    }
  }, Math.min(1000, idleTimeoutMs));
  return { descriptor, native, close, server };
}
