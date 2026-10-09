import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_SELECTOR, PREVIEW_MARKETPLACE, PREVIEW_PLUGIN, parseInstallArguments,
  validateInstallPaths, validateTarEntries, createPreviewCatalog, installCodexNativePreview
} from "../../../scripts/install-codex-native-preview.mjs";

async function fixture(context, revision = "fixture-one") {
  const root = await mkdtemp(join(tmpdir(), "jira-native-fresh-install-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package");
  const codexHome = join(root, "codex-home");
  const installRoot = join(root, "native-plugin");
  await mkdir(codexHome);
  const files = {
    "package.json": JSON.stringify({ name: "@jira-workbench/codex-client", version: "0.33.8" }),
    "plugin.json": JSON.stringify({ name: PREVIEW_PLUGIN, version: "0.33.8" }),
    ".codex-plugin/plugin.json": JSON.stringify({ name: PREVIEW_PLUGIN, version: "0.33.8" }),
    "mcp.json": JSON.stringify({ mcpServers: { [PREVIEW_PLUGIN]: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/dist/stdio-entry.mjs"] } } }),
    ".mcp.json": JSON.stringify({ mcpServers: { [PREVIEW_PLUGIN]: { command: "node", args: ["${PLUGIN_ROOT}/dist/stdio-entry.mjs"] } } })
  };
  for (const name of ["dist/stdio-entry.mjs", "dist/daemon.mjs", "dist/index.mjs", "dist/ui/task-board.html", "ui/core-task-board.html", "ui/native-runtime.js", "ui/native.css", "ui/settings.html"]) files[name] = revision;
  for (const [name, content] of Object.entries(files)) {
    const target = join(packageRoot, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  const archive = join(root, "preview.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"], { windowsHide: true });
  return { root, packageRoot, codexHome, installRoot, options: { package: archive, codexHome, installRoot } };
}

test("原生预览参数默认不安装，CLI 两种形式互斥且拒绝 update / force", () => {
  assert.equal(parseInstallArguments([]).install, false);
  assert.equal(parseInstallArguments(["--install"]).install, true);
  assert.throws(() => parseInstallArguments(["--package"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseInstallArguments(["--codex-module", "codex.js", "--codex-executable", "codex.exe"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseInstallArguments(["--force"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseInstallArguments(["--update"]), { code: "INVALID_ARGUMENT" });
});

test("专用路径、catalog 与 tar 安全校验拒绝越界/链接", () => {
  assert.throws(() => validateInstallPaths(process.cwd(), join(tmpdir(), "codex-home")), { code: "UNSAFE_PATH" });
  assert.throws(() => validateInstallPaths(join(tmpdir(), "codex-home", "plugin"), join(tmpdir(), "codex-home")), { code: "UNSAFE_PATH" });
  assert.throws(() => validateTarEntries("package/../escape\n", "-rw-r--r--\n"), { code: "INVALID_PACKAGE" });
  assert.throws(() => validateTarEntries("package/file\n", "lrwxrwxrwx file -> escape\n"), { code: "INVALID_PACKAGE" });
  const catalog = createPreviewCatalog("0.33.8-0123456789ab");
  assert.equal(catalog.name, PREVIEW_MARKETPLACE);
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].source.path, "./release/0.33.8-0123456789ab");
});

test("默认准备持久包与计划，不调用 CLI、不触碰 Codex 或 active catalog，可重复准备", async (context) => {
  const f = await fixture(context);
  const original = '[plugins."unrelated@other"]\nenabled = true\n';
  await writeFile(join(f.codexHome, "config.toml"), original);
  let cliCalls = 0;
  const dependencies = { runCli() { cliCalls++; throw new Error("must not call CLI"); } };
  const plan = await installCodexNativePreview(f.options, dependencies);
  assert.equal(plan.status, "prepared");
  assert.equal(plan.codexChanged, false);
  const detailUrl = new URL(plan.pluginDetailUrl);
  assert.equal(detailUrl.protocol, "codex:");
  assert.equal(detailUrl.hostname, "plugins");
  assert.equal(detailUrl.pathname, `/${PREVIEW_PLUGIN}`);
  assert.equal(detailUrl.searchParams.get("marketplacePath"), join(f.installRoot, ".agents", "plugins", "marketplace.json"));
  assert.match(plan.releaseRoot, /release[\\/]0\.33\.8-[a-f0-9]{12}$/);
  assert.equal(cliCalls, 0);
  assert.equal(await readFile(join(f.codexHome, "config.toml"), "utf8"), original);
  await assert.rejects(readFile(join(f.installRoot, ".agents/plugins/marketplace.json")), { code: "ENOENT" });
  const again = await installCodexNativePreview(f.options, dependencies);
  assert.equal(again.archiveHash, plan.archiveHash);
  assert.equal(again.sourceHash, plan.sourceHash);
});

test("显式首次安装只调用官方 add，备份配置并核验缓存，同 hash 重复执行不写 Codex", async (context) => {
  const f = await fixture(context);
  const original = '[plugins."unrelated@other"]\nenabled = true\n';
  await writeFile(join(f.codexHome, "config.toml"), original);
  const source = await installCodexNativePreview(f.options);
  const installedPath = join(f.codexHome, "plugins/cache", PREVIEW_MARKETPLACE, PREVIEW_PLUGIN, "0.33.8");
  const commands = [];
  let installed = false;
  const runCli = (args) => {
    commands.push(args.join(" "));
    if (args[0] === "--version") return "codex-cli 0.162.0-alpha.2";
    if (args.join(" ") === "plugin list --json") return JSON.stringify({ installed: installed ? [{ pluginId: PREVIEW_SELECTOR, installed: true, enabled: true }] : [] });
    if (args.join(" ") === "plugin marketplace list --json") return JSON.stringify({ marketplaces: [] });
    if (args[1] === "marketplace" && args[2] === "add") return "{}";
    if (args[1] === "add") { installed = true; return JSON.stringify({ installedPath }); }
    throw new Error(`Unexpected CLI command: ${args}`);
  };
  await cp(source.releaseRoot, installedPath, { recursive: true });
  const result = await installCodexNativePreview({ ...f.options, install: true }, { runCli });
  assert.equal(result.status, "installed");
  assert.equal(result.codexChanged, true);
  assert.equal(await readFile(join(result.backupPath, "config.toml"), "utf8"), original);
  assert.equal(await readFile(join(f.codexHome, "config.toml"), "utf8"), original);
  assert.ok(commands.includes(`plugin add ${PREVIEW_SELECTOR} --json`));
  assert.equal(commands.some((command) => /remove|upgrade/.test(command)), false);
  commands.length = 0;
  const again = await installCodexNativePreview({ ...f.options, install: true }, { runCli });
  assert.equal(again.status, "already-installed");
  assert.equal(again.codexChanged, false);
  assert.deepEqual(commands, ["--version", "plugin list --json"]);
});

test("已有未知/不同/禁用预览明确拒绝，不备份、不 add、不改其他插件", async (context) => {
  const f = await fixture(context);
  for (const enabled of [true, false]) {
    const commands = [];
    const runCli = (args) => {
      commands.push(args.join(" "));
      return args[0] === "--version" ? "codex-cli 0.162.0-alpha.2" : JSON.stringify({ installed: [{ pluginId: PREVIEW_SELECTOR, installed: true, enabled }] });
    };
    await assert.rejects(installCodexNativePreview({ ...f.options, install: true }, { runCli }), { code: "PREVIEW_ALREADY_PRESENT" });
    assert.deepEqual(commands, ["--version", "plugin list --json"]);
    assert.deepEqual(await readdir(f.codexHome), []);
  }
});

test("CLI失败保留独立 config backup，不覆盖用户同期修改也不自动 remove", async (context) => {
  const f = await fixture(context);
  await writeFile(join(f.codexHome, "config.toml"), "original configuration");
  const commands = [];
  let failOnAdd = false;
  const runCli = (args) => {
    commands.push(args.join(" "));
    if (args[0] === "--version") return "codex-cli fixture";
    if (args[1] === "list") return JSON.stringify({ installed: [] });
    if (args[2] === "list") return JSON.stringify({ marketplaces: [] });
    if (args[2] === "add") {
      failOnAdd = true;
      writeFileSync(join(f.codexHome, "config.toml"), "user edited concurrently");
      return "{}";
    }
    throw new Error("simulated official add failure");
  };
  await assert.rejects(installCodexNativePreview({ ...f.options, install: true }, { runCli }), /simulated official add failure/);
  assert.equal(failOnAdd, true);
  assert.equal(await readFile(join(f.codexHome, "config.toml"), "utf8"), "user edited concurrently");
  const backups = await readdir(join(f.codexHome, "recovery-backups"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.codexHome, "recovery-backups", backups[0], "config.toml"), "utf8"), "original configuration");
  assert.equal(commands.some((command) => /remove/.test(command)), false);
});

test("官方 add 后缓存文件被改变时拒绝宣称安装成功，不生成成功 receipt", async (context) => {
  const f = await fixture(context);
  const plan = await installCodexNativePreview(f.options);
  const installedPath = join(f.codexHome, "plugins/cache", PREVIEW_MARKETPLACE, PREVIEW_PLUGIN, "0.33.8");
  await cp(plan.releaseRoot, installedPath, { recursive: true });
  await writeFile(join(installedPath, "dist/stdio-entry.mjs"), "different cached runtime");
  let installed = false;
  const runCli = (args) => {
    if (args[0] === "--version") return "codex-cli fixture";
    if (args[1] === "list") return JSON.stringify({ installed: installed ? [{ pluginId: PREVIEW_SELECTOR, installed: true, enabled: true }] : [] });
    if (args[2] === "list") return JSON.stringify({ marketplaces: [] });
    if (args[1] === "add") { installed = true; return JSON.stringify({ installedPath }); }
    return "{}";
  };
  await assert.rejects(installCodexNativePreview({ ...f.options, install: true }, { runCli }), { code: "CACHE_MISMATCH" });
  await assert.rejects(readFile(join(f.installRoot, "install-receipt.json")), { code: "ENOENT" });
});
