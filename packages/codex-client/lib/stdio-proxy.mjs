import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ensureNativeRuntime, runtimeRequest } from "./runtime-client.mjs";
import { VERSION } from "./version.mjs";

/** Each host connection is a protocol bridge, never another state writer. */
export async function connectStdioProxy({
  dataRoot, daemonPath, idleTimeoutMs, leaseTtlMs,
  stdin = process.stdin, stdout = process.stdout
} = {}) {
  const descriptor = await ensureNativeRuntime({ dataRoot, daemonPath, idleTimeoutMs, leaseTtlMs });
  const leaseId = randomUUID();
  const lease = (release = false) => runtimeRequest(descriptor, "/lease", {
    method: "POST", body: { id: leaseId, release }, timeoutMs: 2000
  });
  await lease();
  const downstream = new Client({ name: "jira-workbench-native-bridge", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(`${descriptor.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${descriptor.token}` }, redirect: "error" }
  });
  try { await downstream.connect(transport); }
  catch (error) { await lease(true).catch(() => {}); throw error; }
  const capabilities = downstream.getServerCapabilities() || {};
  const server = new Server({ name: "jira-workbench-native", version: VERSION }, {
    capabilities: {
      tools: capabilities.tools || {}, resources: capabilities.resources || {},
      ...(capabilities.extensions ? { extensions: capabilities.extensions } : {})
    },
    instructions: `${downstream.getInstructions() || ""} 原生预览尚不支持创建或绑定 Codex 会话，也不提供原生项目目录与 Skill 列表；请通过能力状态工具确认可用功能。`
  });
  const options = (extra) => ({ signal: extra.signal, timeout: 120000 });
  server.setRequestHandler(ListToolsRequestSchema, (request, extra) => downstream.listTools(request.params, options(extra)));
  server.setRequestHandler(ListResourcesRequestSchema, (request, extra) => downstream.listResources(request.params, options(extra)));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) => downstream.listResourceTemplates(request.params, options(extra)));
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) => downstream.readResource(request.params, options(extra)));
  // No automatic replay: a failed mutation can have succeeded before transport
  // failure. Reconnection must never silently send that mutation a second time.
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => downstream.callTool(request.params, undefined, options(extra)));
  let closed = false;
  const heartbeat = setInterval(() => { void lease().catch(() => {}); }, Math.min(10000, Math.floor((leaseTtlMs || 45000) / 3)));
  heartbeat.unref();
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    stdin.off("end", onEnd);
    await lease(true).catch(() => {});
    await server.close();
    await downstream.close();
  }
  const onEnd = () => { void close(); };
  stdin.once("end", onEnd);
  try { await server.connect(new StdioServerTransport(stdin, stdout)); }
  catch (error) { await close(); throw error; }
  return { descriptor, server, downstream, close };
}
