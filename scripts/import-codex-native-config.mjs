#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dpapiSecretStore, normalizeBoardSources, normalizeConfiguration } from "@jira-workbench/core/config-store.mjs";
import { PREVIEW_SELECTOR, validatePreviewPackage } from "./install-codex-native-preview.mjs";

const OWN_ERROR = Symbol("native-import-error");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fail(code, message) { throw Object.assign(new Error(message), { code, [OWN_ERROR]: true }); }
export function safeImportError(error) {
  return error?.[OWN_ERROR] ? { code: error.code, message: error.message }
    : { code: "NATIVE_IMPORT_FAILED", message: "配置导入未被确认成功；未自动重试或回滚。请检查脱敏状态，勿分享凭据或原始错误正文。" };
}
const samePath = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const inside = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };

export function parseImportArguments(args) {
  const result = { apply: false };
  const names = { "--source": "source", "--data-root": "dataRoot", "--receipt": "receipt" };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--apply") result.apply = true;
    else if (name === "--help") result.help = true;
    else if (names[name]) {
      if (!args[index + 1] || args[index + 1].startsWith("--") || result[names[name]]) fail("INVALID_ARGUMENT", "路径参数缺失或重复。");
      result[names[name]] = resolve(args[++index]);
    } else fail("INVALID_ARGUMENT", "仅支持 --source、--data-root、--receipt 和显式 --apply；不支持覆盖或强制导入。");
  }
  return result;
}

async function rejectLinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) fail("UNSAFE_PATH", "配置与备份路径不能经过符号链接或目录联接。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function selectImportPreferences(record) {
  const templates = {};
  for (const kind of ["requirement", "bug"]) {
    const entry = record.promptTemplates?.[kind];
    if (entry && typeof entry === "object") {
      templates[kind] = {
        ...(entry.customized !== undefined ? { customized: entry.customized } : {}),
        ...(entry.content !== undefined ? { content: entry.content } : {}),
        skill: null
      };
    }
  }
  // Normalize only selected public preferences. Never feed a complete old
  // record into load()/prepare(), which could decrypt unrelated Webhooks.
  const normalized = normalizeConfiguration({
    baseUrl: record.baseUrl,
    token: "normalization-placeholder-not-a-credential",
    maxResults: record.maxResults,
    boardSources: normalizeBoardSources(record.boardSources, {}, record.jql || ""),
    ...(Object.keys(templates).length ? { promptTemplates: templates } : {}),
    ...(typeof record.messageTemplate === "string" ? { messageTemplate: record.messageTemplate } : {}),
    syncSettings: record.syncSettings
  });
  for (const entry of Object.values(normalized.promptTemplates)) entry.skill = null;
  return {
    baseUrl: normalized.baseUrl,
    maxResults: normalized.maxResults,
    boardSources: normalized.boardSources,
    promptTemplates: normalized.promptTemplates,
    syncSettings: normalized.syncSettings
  };
}

async function cachedEntry(receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.status !== "installed" || receipt.selector !== PREVIEW_SELECTOR
      || !isAbsolute(receipt.installedPath || "") || !isAbsolute(receipt.codexHome || "")
      || !inside(join(receipt.codexHome, "plugins", "cache"), receipt.installedPath)) {
    fail("INVALID_INSTALL_RECEIPT", "没有可验证的原生预览安装回执，拒绝启动未知入口。");
  }
  await rejectLinks(receipt.installedPath);
  const actual = await validatePreviewPackage(receipt.installedPath);
  if (actual.version !== receipt.version || actual.sourceHash !== receipt.sourceHash) fail("INVALID_INSTALL_RECEIPT", "原生插件缓存版本或文件 hash 已改变，拒绝导入。");
  return { receipt, entry: join(receipt.installedPath, "dist", "stdio-entry.mjs") };
}

async function connectCached({ receipt, entry, dataRoot, env }) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: receipt.installedPath,
    env: { ...env, CODEX_HOME: receipt.codexHome, JIRA_WORKBENCH_NATIVE_DATA_DIR: dataRoot }, stderr: "pipe"
  });
  // Transport diagnostics can include third-party details; never expose them.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "jira-native-authorized-config-import", version: "1" });
  try { await client.connect(transport, { timeout: 15000 }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

function settingsResult(result) {
  if (result?.isError || !result?.structuredContent || !result.structuredContent.config
      || typeof result.structuredContent.config !== "object" || Array.isArray(result.structuredContent.config)
      || !/^[a-f0-9]{64}$/.test(result.structuredContent.revision || "")) {
    fail("SETTINGS_NOT_CONFIRMED", "原生设置工具没有返回可验证的结构化设置与 revision；未自动重试。");
  }
  return result.structuredContent;
}

export async function importCodexNativeConfig(options = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const localRoot = join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "jira-workbench");
  const source = resolve(options.source || join(localRoot, "config.json"));
  const dataRoot = resolve(options.dataRoot || join(localRoot, "codex-native-preview"));
  const target = join(dataRoot, "config.json");
  const receiptPath = resolve(options.receipt || join(localRoot, "codex-native-plugin", "install-receipt.json"));
  if (samePath(source, target) || samePath(dirname(source), dataRoot)
      || [parse(dataRoot).root, homedir(), process.cwd(), env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, env.SystemRoot]
        .filter(Boolean).some((path) => samePath(dataRoot, path))) {
    fail("UNSAFE_PATH", "旧配置与原生目标必须使用不同的专用目录，不能复用或直接覆盖旧配置。");
  }
  let client;
  let token;
  let payload;
  try {
    await rejectLinks(source);
    await rejectLinks(target);
    const sourceBytes = await readFile(source);
    const sourceHash = sha(sourceBytes);
    const record = JSON.parse(sourceBytes.toString("utf8"));
    if (typeof record.tokenProtected !== "string" || !record.tokenProtected.trim()) fail("SOURCE_CREDENTIAL_MISSING", "旧配置没有已保护的 PAT；请重新配置连接。");
    const preferences = selectImportPreferences(record);
    const plan = {
      status: "dry-run", source, target, sourceHash, applied: false,
      migratedFields: Object.keys(preferences), protectedCredentialPresent: true,
      omitted: ["项目与会话绑定", "SVN 状态", "Webhook", "自动化", "视觉模型路由", "Skill"],
      automaticRefreshEnabled: false
    };
    if (!options.apply) return plan;
    const cached = await (dependencies.resolveCached || cachedEntry)(receiptPath);
    client = await (dependencies.connect || connectCached)({ ...cached, dataRoot, env });
    const initial = settingsResult(await client.callTool({ name: "jira_codex_get_settings", arguments: {} }, undefined, { timeout: 20000 }));
    if (initial.config.configured || initial.config.hasToken || initial.credentialConfigured) fail("TARGET_ALREADY_CONFIGURED", "原生目标已经配置连接，拒绝覆盖；本命令仅用于首次导入。");
    token = await (dependencies.unprotect || dpapiSecretStore.unprotect)(record.tokenProtected, "token");
    if (typeof token !== "string" || !token.trim()) fail("SOURCE_CREDENTIAL_UNAVAILABLE", "旧 PAT 无法用于首次导入，请重新配置；未保存任何明文凭据。");
    if (sha(await readFile(source)) !== sourceHash) fail("SOURCE_CHANGED", "读取后旧配置已被其他操作修改，拒绝保存；请重新检查迁移计划。");
    let targetBytes;
    try { targetBytes = await readFile(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (sha(targetBytes || Buffer.alloc(0)) !== initial.revision) fail("TARGET_CHANGED", "读取后原生目标已经变化，拒绝保存；未自动重试。");
    let backupPath = null;
    if (targetBytes) {
      const targetRecord = JSON.parse(targetBytes.toString("utf8"));
      if (targetRecord.token || targetRecord.wecomWebhook) fail("UNSAFE_TARGET_BACKUP", "目标包含未经保护的凭据，拒绝生成备份或继续导入。");
      backupPath = join(dataRoot, "recovery-backups", `authorized-import-${Date.now()}-${randomUUID()}`);
      await rejectLinks(backupPath);
      await mkdir(backupPath, { recursive: true, mode: 0o700 });
      await writeFile(join(backupPath, "config.json"), targetBytes, { flag: "wx", mode: 0o600 });
    }
    // Re-check immediately before the single mutation. CAS additionally guards
    // the destination, whose only writer is the existing managed Core daemon.
    if (sha(await readFile(source)) !== sourceHash) fail("SOURCE_CHANGED", "保存前旧配置再次发生变化，拒绝导入；未自动重试。");
    payload = { ...preferences, token };
    const saved = settingsResult(await client.callTool({ name: "jira_codex_save_settings", arguments: {
      config: payload, expectedRevision: initial.revision, acknowledged: true
    } }, undefined, { timeout: 20000 }));
    if (saved.config.configured !== true || saved.config.hasToken !== true || saved.credentialConfigured !== true) fail("SAVE_NOT_CONFIRMED", "原生设置没有确认连接与保护凭据已保存；请先读取状态，不要重复提交。");
    if (saved.revision === initial.revision) fail("SAVE_NOT_CONFIRMED", "原生设置 revision 未改变，未确认保存完成；请先读取状态，不要重复提交。");
    for (const [name, expected] of Object.entries(preferences)) {
      if (JSON.stringify(saved.config[name]) !== JSON.stringify(expected)) fail("SAVE_NOT_CONFIRMED", "原生设置回读与迁移白名单不一致；请先检查状态，不要重复提交。");
    }
    return { ...plan, status: "imported", applied: true, credentialConfigured: true, backupPath };
  } catch (error) {
    const safe = safeImportError(error);
    fail(safe.code, safe.message);
  } finally {
    token = undefined;
    if (payload) delete payload.token;
    try { await client?.close(); } catch { /* Never expose transport errors or replay a mutation. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseImportArguments(process.argv.slice(2));
    if (options.help) console.log("仅计划：node scripts/import-codex-native-config.mjs [--source 旧配置] [--data-root 原生目录] [--receipt 安装回执]\n首次导入：显式追加 --apply；不支持覆盖、回滚、重试或迁移绑定/自动化。");
    else console.log(JSON.stringify(await importCodexNativeConfig(options), null, 2));
  } catch (error) {
    const safe = safeImportError(error);
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  }
}
