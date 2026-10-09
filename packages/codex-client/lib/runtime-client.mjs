import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, RUNTIME_PROTOCOL } from "./version.mjs";

export function defaultNativeDataRoot() {
  // Preview is intentionally isolated from both the legacy Codex and DSH data.
  return resolve(process.env.JIRA_WORKBENCH_NATIVE_DATA_DIR || join(
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
    "jira-workbench", "codex-native-preview"
  ));
}

export function runtimeIdentity(dataRoot) {
  const path = resolve(dataRoot);
  return createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex");
}

export function runtimePort(dataRoot) {
  // The listener is also the OS-owned single-writer lock. No stale lock files
  // are deleted and no other process is killed to recover it. Hash collisions
  // fail closed rather than launching a second state writer.
  return 42000 + Number.parseInt(runtimeIdentity(dataRoot).slice(0, 8), 16) % 20000;
}

export function descriptorPath(dataRoot) {
  return join(resolve(dataRoot), ".runtime", "endpoint.json");
}

export async function readDescriptor(dataRoot) {
  let descriptor;
  try { descriptor = JSON.parse(await readFile(descriptorPath(dataRoot), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  const expectedUrl = `http://127.0.0.1:${runtimePort(dataRoot)}`;
  if (descriptor.identity !== runtimeIdentity(dataRoot) || descriptor.url !== expectedUrl
      || !/^[a-f0-9]{64}$/.test(String(descriptor.token || ""))
      || !Number.isInteger(descriptor.pid) || descriptor.pid < 1) {
    throw new Error("原生服务地址记录无效；未连接任何未知本地服务。");
  }
  return descriptor;
}

export async function runtimeRequest(descriptor, path, { method = "GET", body, timeoutMs = 3000 } = {}) {
  const response = await fetch(`${descriptor.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error"
  });
  if (!response.ok) throw new Error(`原生服务请求失败（HTTP ${response.status}）。`);
  return response.json();
}

export async function probeRuntime(dataRoot, { version = VERSION } = {}) {
  const descriptor = await readDescriptor(dataRoot);
  if (!descriptor) return null;
  let health;
  try { health = await runtimeRequest(descriptor, "/health", { timeoutMs: 800 }); }
  catch { return null; }
  if (health.identity !== runtimeIdentity(dataRoot) || health.protocol !== RUNTIME_PROTOCOL
      || health.version !== version || descriptor.version !== version) {
    throw new Error("已运行的原生服务版本不一致，请关闭使用该插件的窗口后重试；不会启动第二个写入实例。");
  }
  if (health.closing) throw new Error("原生服务正在等待已开始的操作完成，请稍后重试；不会中断提交或启动第二个实例。");
  return descriptor;
}

export async function ensureNativeRuntime({
  dataRoot = defaultNativeDataRoot(), version = VERSION, startupTimeoutMs = 15000,
  daemonPath = fileURLToPath(existsSync(new URL("./daemon.mjs", import.meta.url))
    ? new URL("./daemon.mjs", import.meta.url) : new URL("../bin/daemon.mjs", import.meta.url)),
  idleTimeoutMs = 15000, leaseTtlMs = 45000
} = {}) {
  if (!isAbsolute(dataRoot)) throw new TypeError("原生服务数据目录必须为绝对路径。");
  const existing = await probeRuntime(dataRoot, { version });
  if (existing) return existing;
  let launchFailure = null;
  const child = spawn(process.execPath, [
    daemonPath, "--data-root", resolve(dataRoot),
    "--idle-timeout-ms", String(idleTimeoutMs), "--lease-ttl-ms", String(leaseTtlMs)
  ], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.once("error", (error) => { launchFailure = error; });
  child.unref();
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (launchFailure) throw new Error("无法启动原生服务，请检查 Node.js 与插件文件是否完整。", { cause: launchFailure });
    const descriptor = await probeRuntime(dataRoot, { version });
    if (descriptor) return descriptor;
    await new Promise((complete) => setTimeout(complete, 100));
  }
  throw new Error("原生服务未在限定时间内就绪。请检查插件产物、目录权限或端口占用；现有进程和数据未被修改。");
}
