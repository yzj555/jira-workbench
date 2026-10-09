import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCodexNativeConfig, parseImportArguments, safeImportError } from "../../../scripts/import-codex-native-config.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(context, { targetBytes, initialConfigured = false, onDecrypt, onSave, missingInitial = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jira-native-import-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "legacy", "config.json");
  const dataRoot = join(root, "native");
  await mkdir(join(root, "legacy"));
  const record = {
    version: 3, baseUrl: "https://jira.example.test/", maxResults: 100,
    tokenProtected: "fixture-encrypted-pat", wecomWebhookProtected: "fixture-encrypted-webhook",
    boardSources: {
      projectKey: "GAME", collaboratorFieldId: "customfield_10600", collaboratorJqlName: "协同处理人",
      requirement: { mode: "filter", filterIds: ["42"] }, bug: { mode: "filter", filterIds: ["43"] }
    },
    promptTemplates: {
      requirement: { customized: true, content: "fixture requirement", skill: { name: "old skill", path: "F:/old/skill.md" } },
      bug: { customized: false, skill: { name: "old diagnostic skill" } }
    },
    syncSettings: { tasksEnabled: false, taskIntervalSeconds: 300 },
    codexProjectId: "old-project", codexProjectPath: "F:/old/project", bugMonitorEnabled: true,
    imageProcessing: { visionProvider: "old-vision-provider", visionModel: "old-vision-model" }
  };
  await writeFile(source, JSON.stringify(record));
  if (targetBytes !== undefined) {
    await mkdir(dataRoot);
    await writeFile(join(dataRoot, "config.json"), targetBytes);
  }
  const calls = [];
  const timeouts = [];
  const decrypts = [];
  let connected = 0;
  let closed = 0;
  const revision = hash(targetBytes || Buffer.alloc(0));
  const dependencies = {
    resolveCached: async () => ({ receipt: { installedPath: "fixture-cached-package" }, entry: "fixture-stdio-entry" }),
    connect: async (options) => {
      connected++;
      assert.equal(options.dataRoot, dataRoot);
      return {
        callTool: async (request, _schema, options) => {
          calls.push(structuredClone(request));
          timeouts.push(options?.timeout);
          if (request.name === "jira_codex_get_settings") return missingInitial ? { content: [] } : {
            structuredContent: { config: { configured: initialConfigured, hasToken: initialConfigured }, revision, credentialConfigured: initialConfigured }
          };
          if (onSave) return onSave(request);
          const config = structuredClone(request.arguments.config);
          delete config.token;
          return { structuredContent: { config: { ...config, configured: true, hasToken: true }, revision: "b".repeat(64), credentialConfigured: true } };
        },
        close: async () => { closed++; }
      };
    },
    unprotect: async (ciphertext, secret) => {
      decrypts.push([ciphertext, secret]);
      await onDecrypt?.({ source, dataRoot });
      return "fixture-plain-pat-never-log";
    }
  };
  return { root, source, dataRoot, options: { source, dataRoot, receipt: join(root, "fixture-receipt.json") }, calls, decrypts, timeouts,
    revision, dependencies, connected: () => connected, closed: () => closed };
}

test("导入默认dry-run，不连接、解密或写目标，只输出脱敏计划", async (context) => {
  const f = await fixture(context);
  const before = await readFile(f.source);
  const plan = await importCodexNativeConfig(f.options, f.dependencies);
  assert.equal(plan.status, "dry-run");
  assert.equal(plan.applied, false);
  assert.equal(f.connected(), 0);
  assert.equal(f.decrypts.length, 0);
  assert.deepEqual(await readFile(f.source), before);
  await assert.rejects(readdir(f.dataRoot), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(plan), /fixture-encrypted|fixture-plain|old-vision-provider|old skill/);
});

test("显式导入仅迁白名单，解密PAT不解Webhook，带revision保存且Skill清空", async (context) => {
  const f = await fixture(context);
  const result = await importCodexNativeConfig({ ...f.options, apply: true }, f.dependencies);
  assert.equal(result.applied, true);
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.decrypts, [["fixture-encrypted-pat", "token"]]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.timeouts, [20000, 20000]);
  const args = f.calls[1].arguments;
  assert.equal(args.acknowledged, true);
  assert.equal(args.expectedRevision, f.revision);
  assert.deepEqual(Object.keys(args.config).sort(), ["baseUrl", "token", "maxResults", "boardSources", "promptTemplates", "syncSettings"].sort());
  assert.equal(args.config.baseUrl, "https://jira.example.test");
  assert.equal(args.config.promptTemplates.requirement.skill, null);
  assert.equal(args.config.promptTemplates.bug.skill, null);
  assert.doesNotMatch(JSON.stringify(result), /fixture-encrypted|fixture-plain|old-vision-provider|old-project/);
});

test("已有原生连接拒绝覆盖，并且不解密旧PAT、不尝试保存", async (context) => {
  const f = await fixture(context, { initialConfigured: true });
  await assert.rejects(importCodexNativeConfig({ ...f.options, apply: true }, f.dependencies), { code: "TARGET_ALREADY_CONFIGURED" });
  assert.equal(f.decrypts.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed(), 1);
});

test("旧来源在读取后改变则拒绝保存，不自动重试", async (context) => {
  const f = await fixture(context, { onDecrypt: async ({ source }) => { await writeFile(source, '{"changed":true}'); } });
  await assert.rejects(importCodexNativeConfig({ ...f.options, apply: true }, f.dependencies), { code: "SOURCE_CHANGED" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed(), 1);
});

test("目标存在时只备份已有加密原字节，仍由MCP保存，不直接覆盖config", async (context) => {
  const original = JSON.stringify({ version: 6, baseUrl: "", tokenProtected: "" });
  const f = await fixture(context, { targetBytes: original });
  const result = await importCodexNativeConfig({ ...f.options, apply: true }, f.dependencies);
  assert.equal(await readFile(join(result.backupPath, "config.json"), "utf8"), original);
  assert.equal(await readFile(join(f.dataRoot, "config.json"), "utf8"), original);
  assert.equal(f.calls[1].arguments.expectedRevision, hash(original));
});

test("未返回结构化设置则明确失败；保存不确认时仅发送一次、不重试", async (context) => {
  const unreadable = await fixture(context, { missingInitial: true });
  await assert.rejects(importCodexNativeConfig({ ...unreadable.options, apply: true }, unreadable.dependencies), { code: "SETTINGS_NOT_CONFIRMED" });
  assert.equal(unreadable.decrypts.length, 0);
  const unconfirmed = await fixture(context, { onSave: async () => ({ content: [{ type: "text", text: "fixture-plain-pat-never-log" }] }) });
  await assert.rejects(importCodexNativeConfig({ ...unconfirmed.options, apply: true }, unconfirmed.dependencies), { code: "SETTINGS_NOT_CONFIRMED" });
  assert.equal(unconfirmed.calls.filter((call) => call.name === "jira_codex_save_settings").length, 1);
});

test("宿主错误和DPAPI错误不回显秘密或原异常body", async (context) => {
  const f = await fixture(context, { onSave: async () => { throw new Error("body includes fixture-plain-pat-never-log and webhook-secret"); } });
  try { await importCodexNativeConfig({ ...f.options, apply: true }, f.dependencies); assert.fail("must reject"); }
  catch (error) {
    assert.equal(error.code, "NATIVE_IMPORT_FAILED");
    assert.doesNotMatch(JSON.stringify(safeImportError(error)), /fixture-plain|webhook-secret|body includes/);
  }
  assert.equal(f.calls.filter((call) => call.name === "jira_codex_save_settings").length, 1);
});

test("导入参数拒绝强制覆盖，来源与目标不得复用", async (context) => {
  assert.equal(parseImportArguments([]).apply, false);
  assert.throws(() => parseImportArguments(["--force"]), { code: "INVALID_ARGUMENT" });
  const f = await fixture(context);
  await assert.rejects(importCodexNativeConfig({ ...f.options, dataRoot: join(f.source, "..") }, f.dependencies), { code: "UNSAFE_PATH" });
  await assert.rejects(importCodexNativeConfig({ ...f.options, dataRoot: f.root }, { ...f.dependencies, env: { LOCALAPPDATA: f.root } }), { code: "UNSAFE_PATH" });
});
