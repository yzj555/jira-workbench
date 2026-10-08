import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigStore } from "../../core/config-store.mjs";
import { installDshSettingsCompatibility } from "../lib/dsh-settings-compatibility.mjs";

function fixture({ storedBaseUrl = "https://jira.example", profileBaseUrl = "", recordExists = true } = {}) {
  const writes = [];
  const errors = [];
  const listeners = new Map();
  let selectedBaseUrl = profileBaseUrl;
  const stored = { baseUrl: storedBaseUrl, tokenProtected: "JIRA_WORKBENCH_TOKEN", boardSources: { projectKey: "CT" } };
  const fiber = { entry: { options: { id: "jira-workbench" } } };
  let configureDisposed = 0;
  let releaseLoader;
  const loaderReady = new Promise((resolve) => { releaseLoader = resolve; });
  const settings = {
    configure(presentation, owner) {
      assert.deepEqual(presentation, { auto: false });
      assert.equal(owner, fiber);
      return () => { configureDisposed += 1; };
    },
    async update(namespace, patch) {
      assert.equal(namespace, "jira-workbench");
      writes.push({ kind: "profile", ...patch });
      selectedBaseUrl = patch.baseUrl;
      void listeners.get("app-boot/config-reload")?.();
    }
  };
  const ctx = {
    fiber,
    root: { loader: { await: () => loaderReady } },
    get: (name) => name === "settings" ? settings : undefined,
    logger: { error: (message) => errors.push(message) },
    on(name, listener) {
      listeners.set(name, listener);
      return () => { listeners.delete(name); };
    }
  };
  const configStore = {
    configFile: "unused-fixture-config.json",
    getPublic: async () => ({ ...stored }),
    async updateCredentialReference({ baseUrl, tokenReference }) {
      writes.push({ kind: "core", baseUrl, tokenReference });
      stored.baseUrl = baseUrl;
    }
  };
  const installed = installDshSettingsCompatibility({
    ctx,
    config: { baseUrl: { get: () => selectedBaseUrl } },
    configStore,
    namespace: "jira-workbench",
    tokenReference: "JIRA_WORKBENCH_TOKEN",
    hasStoredConfiguration: async () => recordExists
  });
  return {
    installed, writes, stored, errors, configStore, settings,
    activate: () => { releaseLoader(); },
    reload: async (baseUrl) => {
      selectedBaseUrl = baseUrl;
      await listeners.get("app-boot/config-reload")?.();
    },
    disposedCount: () => configureDisposed
  };
}

test("新版 DSH 激活后迁移既有 Jira 地址，不改凭据引用与任务设置", async () => {
  const state = fixture();
  assert.equal(state.installed.mode, "forms");
  assert.deepEqual(state.writes, []);
  // A loader reload before ACTIVE must not try to edit an unavailable form.
  await state.reload("");
  assert.deepEqual(state.writes, []);
  state.activate();
  await state.installed.ready;
  assert.deepEqual(state.writes, [{ kind: "profile", baseUrl: "https://jira.example" }]);
  assert.equal(state.stored.tokenProtected, "JIRA_WORKBENCH_TOKEN");
  assert.deepEqual(state.stored.boardSources, { projectKey: "CT" });
  await state.reload("https://jira.example");
  assert.equal(state.writes.length, 1);
  state.installed.dispose();
  assert.equal(state.disposedCount(), 1);
});

test("新版 DSH volatile 地址变化与清空同步至 Jira，重复 reload 不重复写入", async () => {
  const state = fixture({ profileBaseUrl: "https://jira.example" });
  state.activate();
  await state.installed.ready;
  await state.reload("https://new-jira.example");
  await state.reload("");
  assert.deepEqual(state.writes, [
    { kind: "core", baseUrl: "https://new-jira.example", tokenReference: "JIRA_WORKBENCH_TOKEN" },
    { kind: "core", baseUrl: "", tokenReference: "JIRA_WORKBENCH_TOKEN" }
  ]);
  state.installed.dispose();
});

test("凭据暂不可用时保留原连接，同一地址的后续 reload 可重试", async () => {
  const state = fixture({ profileBaseUrl: "https://jira.example" });
  const write = state.configStore.updateCredentialReference;
  let fail = true;
  state.configStore.updateCredentialReference = async (input) => {
    if (fail) throw new Error("Token reference unavailable");
    return write(input);
  };
  state.activate();
  await state.installed.ready;
  await state.reload("https://new-jira.example");
  assert.equal(state.stored.baseUrl, "https://jira.example");
  assert.equal(state.errors.length, 1);
  fail = false;
  await state.reload("https://new-jira.example");
  assert.equal(state.stored.baseUrl, "https://new-jira.example");
  assert.equal(state.writes.length, 1);
  state.installed.dispose();
});

test("初始化以 Core 已保存新地址为准，不允许旧 profile 覆盖成功的面板保存", async () => {
  const state = fixture({ storedBaseUrl: "https://saved-jira.example", profileBaseUrl: "https://old-jira.example" });
  state.activate();
  await state.installed.ready;
  assert.deepEqual(state.writes, [{ kind: "profile", baseUrl: "https://saved-jira.example" }]);
  assert.equal(state.stored.baseUrl, "https://saved-jira.example");
  state.installed.dispose();
});

test("Core 明确保存空地址时清空 profile 镜像，不复活旧地址", async () => {
  const state = fixture({ storedBaseUrl: "", profileBaseUrl: "https://old-jira.example" });
  state.activate();
  await state.installed.ready;
  assert.deepEqual(state.writes, [{ kind: "profile", baseUrl: "" }]);
  assert.equal(state.stored.baseUrl, "");
  assert.equal(state.stored.tokenProtected, "JIRA_WORKBENCH_TOKEN");
  state.installed.dispose();
});

test("首次镜像失败保留 Core 新地址，未变化的原生旧值不会在 reload 时覆盖它", async () => {
  const state = fixture({ storedBaseUrl: "https://saved-jira.example", profileBaseUrl: "https://old-jira.example" });
  state.settings.update = async () => { throw new Error("profile is read-only"); };
  state.activate();
  await state.installed.ready;
  await state.reload("https://old-jira.example");
  assert.equal(state.stored.baseUrl, "https://saved-jira.example");
  assert.deepEqual(state.writes, []);
  assert.equal(state.errors.length, 1);
  state.installed.dispose();
});

test("仅 Core 配置不存在时首次导入 native 地址，导入失败不写空值", async () => {
  const state = fixture({ storedBaseUrl: "", profileBaseUrl: "https://profile-jira.example", recordExists: false });
  const write = state.configStore.updateCredentialReference;
  let fail = true;
  state.configStore.updateCredentialReference = async (input) => {
    if (fail) throw new Error("Token reference unavailable");
    return write(input);
  };
  state.activate();
  await state.installed.ready;
  assert.deepEqual(state.writes, []);
  assert.equal(state.stored.baseUrl, "");
  fail = false;
  await state.reload("https://profile-jira.example");
  assert.deepEqual(state.writes, [{
    kind: "core", baseUrl: "https://profile-jira.example", tokenReference: "JIRA_WORKBENCH_TOKEN"
  }]);
  state.installed.dispose();
});

test("Core 保存后的 profile 更新预检仍读旧快照时，不把已保存连接清空", async () => {
  const state = fixture({ storedBaseUrl: "", profileBaseUrl: "" });
  state.activate();
  await state.installed.ready;
  // The panel first commits its complete configuration to Core, then mirrors
  // the URL to native Config. ConfigEditor reloads the old profile before it
  // persists the new patch; that preflight is not a user clearing the URL.
  await state.configStore.updateCredentialReference({
    baseUrl: "https://saved-jira.example",
    tokenReference: "JIRA_WORKBENCH_TOKEN"
  });
  await state.reload("");
  assert.equal(state.stored.baseUrl, "https://saved-jira.example");
  await state.reload("https://saved-jira.example");
  assert.equal(state.writes.length, 1);
  state.installed.dispose();
});

test("等待 Loader 时卸载插件不回填配置且释放设置策略", async () => {
  const state = fixture();
  state.installed.dispose();
  state.installed.dispose();
  state.activate();
  await state.installed.ready;
  assert.deepEqual(state.writes, []);
  assert.equal(state.disposedCount(), 1);
});

test("真实 ConfigStore getPublic 不建文件：缺失首次导入，存在且空地址保持明确清空", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jira-dsh-settings-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, "config.json");
  const configStore = createConfigStore({
    configFile,
    secretStore: {
      mode: "credential-ref",
      protect: async () => "JIRA_WORKBENCH_TOKEN",
      unprotect: async () => "isolated-placeholder"
    }
  });
  assert.equal(configStore.configFile, configFile);
  await configStore.getPublic();
  await assert.rejects(stat(configFile), { code: "ENOENT" });

  let selected = "https://native-jira.example";
  const mirrored = [];
  const settings = {
    configure: () => () => {},
    async update(_namespace, patch) { selected = patch.baseUrl; mirrored.push(patch.baseUrl); }
  };
  const mount = () => installDshSettingsCompatibility({
    ctx: { get: () => settings },
    config: { baseUrl: { get: () => selected } },
    configStore,
    namespace: "jira-workbench",
    tokenReference: "JIRA_WORKBENCH_TOKEN"
  });
  const first = mount();
  await first.ready;
  first.dispose();
  assert.equal((await configStore.getPublic()).baseUrl, "https://native-jira.example");
  assert.deepEqual(mirrored, []);

  await configStore.updateCredentialReference({ baseUrl: "", tokenReference: "JIRA_WORKBENCH_TOKEN" });
  const restarted = mount();
  await restarted.ready;
  restarted.dispose();
  assert.deepEqual(mirrored, [""]);
  assert.equal((await configStore.getPublic()).baseUrl, "");
});
