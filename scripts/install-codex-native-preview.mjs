#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PREVIEW_MARKETPLACE = "jira-workbench-native-preview";
export const PREVIEW_PLUGIN = "jira-workbench-native";
export const PREVIEW_SELECTOR = `${PREVIEW_PLUGIN}@${PREVIEW_MARKETPLACE}`;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OWNER = "jira-workbench-native-preview-installer";
const REQUIRED = [
  "package.json", "plugin.json", ".codex-plugin/plugin.json", "mcp.json", ".mcp.json",
  "dist/stdio-entry.mjs", "dist/daemon.mjs", "dist/index.mjs", "dist/ui/task-board.html",
  "ui/core-task-board.html", "ui/native-runtime.js", "ui/native.css", "ui/settings.html"
];

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const samePath = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const inside = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };

export function parseInstallArguments(args) {
  const result = { install: false };
  const values = { "--package": "package", "--codex-module": "codexModule", "--codex-executable": "codexExecutable", "--codex-home": "codexHome", "--install-root": "installRoot" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--install") result.install = true;
    else if (flag === "--help") result.help = true;
    else if (values[flag]) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) fail("INVALID_ARGUMENT", `${flag} 必须提供路径。`);
      if (result[values[flag]]) fail("INVALID_ARGUMENT", `${flag} 不能重复。`);
      result[values[flag]] = resolve(args[++index]);
    } else fail("INVALID_ARGUMENT", `不支持参数 ${flag}；本命令只支持准备与首次安装，不支持更新、卸载或强制覆盖。`);
  }
  if (result.codexModule && result.codexExecutable) fail("INVALID_ARGUMENT", "--codex-module 与 --codex-executable 不能同时使用。");
  return result;
}

export function validateInstallPaths(installRoot, codexHome) {
  if (!isAbsolute(installRoot) || !isAbsolute(codexHome)) fail("UNSAFE_PATH", "安装根与 CODEX_HOME 必须为绝对路径。");
  for (const broad of [parse(installRoot).root, homedir(), ROOT, process.cwd(), process.env.LOCALAPPDATA, codexHome].filter(Boolean)) {
    if (samePath(installRoot, broad)) fail("UNSAFE_PATH", "安装根必须是专用子目录，不能使用工作区、用户根或 CODEX_HOME。");
  }
  if (inside(codexHome, installRoot) || inside(installRoot, codexHome)) fail("UNSAFE_PATH", "安装包路径与 CODEX_HOME 必须相互独立。");
}

async function rejectLinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) fail("UNSAFE_PATH", "安装路径不能经过符号链接或目录联接。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function validateTarEntries(names, details) {
  const entries = names.trim().split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 10000) fail("INVALID_PACKAGE", "插件包文件清单为空或过大。");
  for (const entry of entries) {
    if (!/^package(?:\/[A-Za-z0-9._/-]+)?\/?$/.test(entry) || entry.split("/").includes("..") || entry.includes("//")) {
      fail("INVALID_PACKAGE", "插件包包含不安全路径；未解包。");
    }
  }
  if (details.trim().split(/\r?\n/).some((line) => !/^[d-]/.test(line))) fail("INVALID_PACKAGE", "插件包不能包含链接或特殊文件；未解包。");
  return entries;
}

async function packageHashes(root) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("INVALID_PACKAGE", "插件包目录包含链接。");
      if (entry.isDirectory()) await walk(join(path, entry.name), name);
      else if (entry.isFile()) files[name] = hash(await readFile(join(path, entry.name)));
      else fail("INVALID_PACKAGE", "插件包目录包含特殊文件。");
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function validatePreviewPackage(root) {
  const files = await packageHashes(root);
  for (const name of REQUIRED) if (!files[name]) fail("INVALID_PACKAGE", `插件包缺少 ${name}；请先构建完整包。`);
  const manifest = await json(join(root, "package.json"));
  if (manifest.name !== "@jira-workbench/codex-client" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(manifest.version || "")) {
    fail("INVALID_PACKAGE", "不是有效的 Jira Codex 原生预览 npm 包。");
  }
  for (const name of ["plugin.json", ".codex-plugin/plugin.json"]) {
    const plugin = await json(join(root, name));
    if (plugin.name !== PREVIEW_PLUGIN || plugin.version !== manifest.version) fail("INVALID_PACKAGE", `${name} 身份或版本与 npm 包不一致。`);
  }
  for (const name of ["mcp.json", ".mcp.json"]) {
    const mcp = await json(join(root, name));
    const servers = mcp.mcpServers;
    const server = servers?.[PREVIEW_PLUGIN];
    if (Object.keys(servers || {}).length !== 1 || server?.command !== "node"
        || JSON.stringify(server.args) !== JSON.stringify(["${PLUGIN_ROOT}/dist/stdio-entry.mjs"])
        || (name === "mcp.json" && server.type !== "stdio")) fail("INVALID_PACKAGE", `${name} 没有预期的可移植 STDIO 声明。`);
  }
  return { version: manifest.version, files, sourceHash: hash(JSON.stringify(files)) };
}

export function createPreviewCatalog(releaseName) {
  if (!/^[A-Za-z0-9.+_-]+-[a-f0-9]{12}$/.test(releaseName)) fail("INVALID_PACKAGE", "发布目录名称无效。");
  return {
    name: PREVIEW_MARKETPLACE,
    interface: { displayName: "Jira 工作台 · 原生预览" },
    plugins: [{ name: PREVIEW_PLUGIN, source: { source: "local", path: `./release/${releaseName}` },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity" }]
  };
}

function makeCli(options, env, cwd) {
  let launcher = options.codexExecutable;
  let prefix = [];
  if (!launcher) {
    const candidates = options.codexModule ? [options.codexModule] : String(env.PATH || "").split(delimiter)
      .map((path) => join(path, "node_modules", "@openai", "codex", "bin", "codex.js"));
    const module = candidates.find(existsSync);
    if (!module) fail("MISSING_CLI", "未找到 Codex CLI。请用 --codex-executable 指定同桌面宿主的 exe，或 --codex-module 指定 codex.js。");
    launcher = process.execPath;
    prefix = [module];
  }
  return (args) => {
    try { return execFileSync(launcher, [...prefix, ...args], { env, cwd, encoding: "utf8", windowsHide: true, timeout: 45000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { fail("CODEX_CLI_FAILED", `官方 Codex CLI 执行失败：${args.slice(0, 3).join(" ")}。未自动回滚配置或清理缓存；请检查插件状态。`); }
  };
}

function installedEntry(report) {
  if (!Array.isArray(report?.installed)) fail("INVALID_CLI_RESULT", "Codex 没有返回可验证的 installed 清单，拒绝安装。");
  return report.installed.find((entry) => entry.pluginId === PREVIEW_SELECTOR);
}

async function verifyCache(installedRoot, source, codexHome) {
  if (typeof installedRoot !== "string" || !isAbsolute(installedRoot) || !inside(join(codexHome, "plugins", "cache"), installedRoot)) {
    fail("INVALID_CLI_RESULT", "官方 CLI 未返回 CODEX_HOME 插件缓存内的真实安装路径。");
  }
  await rejectLinks(installedRoot);
  const actual = await validatePreviewPackage(installedRoot);
  for (const [name, value] of Object.entries(source.files)) {
    if (actual.files[name] !== value) fail("CACHE_MISMATCH", `安装缓存中的 ${name} 与准备包不一致；不会自动覆盖。`);
  }
}

async function backupConfig(codexHome) {
  const config = join(codexHome, "config.toml");
  try { await lstat(config); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const path = join(codexHome, "recovery-backups", `jira-native-install-${Date.now()}-${randomUUID()}`);
  await rejectLinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await copyFile(config, join(path, "config.toml"));
  await chmod(join(path, "config.toml"), 0o600);
  return path;
}

export async function installCodexNativePreview(options = {}, dependencies = {}) {
  if (options.codexModule && options.codexExecutable) fail("INVALID_ARGUMENT", "两种 Codex CLI 启动方式不能同时使用。");
  const env = dependencies.env || process.env;
  const installRoot = resolve(options.installRoot || join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "jira-workbench", "codex-native-plugin"));
  const codexHome = resolve(options.codexHome || env.CODEX_HOME || join(homedir(), ".codex"));
  validateInstallPaths(installRoot, codexHome);
  await rejectLinks(installRoot);
  const ownerPath = join(installRoot, "preview-owner.json");
  if (existsSync(installRoot) && (await readdir(installRoot)).length) {
    let owner;
    try { owner = await json(ownerPath); } catch { fail("UNMANAGED_INSTALL_ROOT", "目标目录不是本预览安装器管理的目录，拒绝覆盖。"); }
    if (owner.owner !== OWNER) fail("UNMANAGED_INSTALL_ROOT", "目标目录归属不一致，拒绝覆盖。");
  }
  await mkdir(installRoot, { recursive: true });
  if (!existsSync(ownerPath)) await writeFile(ownerPath, JSON.stringify({ schemaVersion: 1, owner: OWNER }), { flag: "wx" });
  const stage = await mkdtemp(join(installRoot, ".prepare-"));
  let source, archiveHash, releaseName, releaseRoot;
  try {
    let archive = options.package && resolve(options.package);
    if (!archive) {
      const npmCli = env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", join(ROOT, "packages", "codex-client"), "--ignore-scripts", "--json", "--pack-destination", stage], {
        env, cwd: stage, encoding: "utf8", windowsHide: true, timeout: 45000, stdio: ["ignore", "pipe", "pipe"]
      }))[0];
      archive = join(stage, packed.filename);
    }
    archiveHash = hash(await readFile(archive));
    const tar = (args) => execFileSync("tar", args, { encoding: "utf8", windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
    validateTarEntries(tar(["-tf", archive]), tar(["-tvf", archive]));
    const extracted = join(stage, "extracted");
    await mkdir(extracted);
    tar(["-xf", archive, "-C", extracted]);
    const prepared = join(extracted, "package");
    source = await validatePreviewPackage(prepared);
    releaseName = `${source.version}-${archiveHash.slice(0, 12)}`;
    releaseRoot = join(installRoot, "release", releaseName);
    await rejectLinks(releaseRoot);
    await mkdir(dirname(releaseRoot), { recursive: true });
    if (existsSync(releaseRoot)) {
      const existing = await validatePreviewPackage(releaseRoot);
      if (existing.sourceHash !== source.sourceHash) fail("SOURCE_MISMATCH", "持久发布目录已有不同内容，拒绝覆盖。");
    } else await rename(prepared, releaseRoot);
  } finally { await rm(stage, { recursive: true, force: true }); }
  const catalog = createPreviewCatalog(releaseName);
  const plan = { schemaVersion: 1, selector: PREVIEW_SELECTOR, version: source.version, archiveHash, sourceHash: source.sourceHash,
    installRoot, releaseRoot, codexHome, catalog,
    pluginDetailUrl: `codex://plugins/${PREVIEW_PLUGIN}?marketplacePath=${encodeURIComponent(join(installRoot, ".agents", "plugins", "marketplace.json"))}`,
    status: "prepared", codexChanged: false };
  // A plan never rewrites the active catalog of an already registered source.
  const plansRoot = join(installRoot, "plans");
  await rejectLinks(plansRoot);
  await mkdir(plansRoot, { recursive: true });
  await writeFile(join(plansRoot, `${releaseName}.json`), JSON.stringify(plan, null, 2));
  if (!options.install) return plan;
  if (!existsSync(codexHome)) fail("MISSING_CODEX_HOME", "CODEX_HOME 必须事先存在；请先初始化或使用明确的测试目录。");
  await rejectLinks(codexHome);
  const cli = dependencies.runCli || makeCli(options, { ...env, CODEX_HOME: codexHome }, installRoot);
  const cliVersion = cli(["--version"]).trim();
  const before = installedEntry(JSON.parse(cli(["plugin", "list", "--json"])));
  const receiptPath = join(installRoot, "install-receipt.json");
  if (before) {
    let receipt;
    try { receipt = await json(receiptPath); } catch {}
    if (before.installed !== true || before.enabled !== true) fail("PREVIEW_ALREADY_PRESENT", "预览插件已有配置但未安装或启用；本命令不会修复或更新。请正常关闭后检查。");
    const cached = before.installedPath || receipt?.installedPath;
    try { await verifyCache(cached, source, codexHome); }
    catch { fail("PREVIEW_ALREADY_PRESENT", "已安装预览不是本次可验证的相同构建。请正常关闭预览并等待后台操作结束；本命令不会自动更新、移除或杀进程。"); }
    if (receipt?.selector !== PREVIEW_SELECTOR || receipt?.archiveHash !== archiveHash
        || receipt?.sourceHash !== source.sourceHash || !samePath(receipt?.codexHome || "", codexHome)) {
      fail("PREVIEW_ALREADY_PRESENT", "已安装预览的包 hash 不同或未知；拒绝覆盖，请单独规划正常关闭与更新。");
    }
    return { ...plan, status: "already-installed", installedPath: cached, cliVersion };
  }
  const marketplaceReport = JSON.parse(cli(["plugin", "marketplace", "list", "--json"]));
  if (!Array.isArray(marketplaceReport?.marketplaces)) fail("INVALID_CLI_RESULT", "Codex 没有返回可验证的 Marketplace 清单。");
  const marketplace = marketplaceReport.marketplaces.find((entry) => entry.name === PREVIEW_MARKETPLACE);
  if (marketplace && !samePath(marketplace.root || "", installRoot)) fail("MARKETPLACE_CONFLICT", "同名预览 Marketplace 已指向其他目录，拒绝修改。");
  const catalogPath = join(installRoot, ".agents", "plugins", "marketplace.json");
  await rejectLinks(catalogPath);
  if (existsSync(catalogPath)) {
    const existing = await json(catalogPath);
    if (existing.name !== PREVIEW_MARKETPLACE || existing.plugins?.length !== 1 || existing.plugins[0].name !== PREVIEW_PLUGIN) fail("MARKETPLACE_CONFLICT", "持久 Marketplace 包含其他插件，拒绝覆盖。");
  }
  const backupPath = await backupConfig(codexHome);
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  // Only official commands modify Codex; never restore an entire config after
  // failure, which could discard unrelated concurrent edits made by the user.
  cli(["plugin", "marketplace", "add", installRoot, "--json"]);
  const installed = JSON.parse(cli(["plugin", "add", PREVIEW_SELECTOR, "--json"]));
  const after = installedEntry(JSON.parse(cli(["plugin", "list", "--json"])));
  if (after?.installed !== true || after?.enabled !== true) fail("INSTALL_NOT_VERIFIED", "官方 CLI 尚未确认预览插件已安装并启用；未自动回滚配置。");
  const installedPath = installed.installedPath || after.installedPath;
  await verifyCache(installedPath, source, codexHome);
  const receipt = { ...plan, status: "installed", codexChanged: true, cliVersion, installedPath, backupPath };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseInstallArguments(process.argv.slice(2));
    if (options.help) console.log("准备：node scripts/install-codex-native-preview.mjs [--package 包.tgz]\n首次安装：追加 --install；可指定 --codex-executable / --codex-module（互斥）、--codex-home、--install-root。不会更新、卸载、重启或发布。");
    else console.log(JSON.stringify(await installCodexNativePreview(options), null, 2));
  } catch (error) {
    console.error(`${error.code || "PREVIEW_INSTALL_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}
