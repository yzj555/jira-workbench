import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDescriptor } from "../packages/codex-client/lib/runtime-client.mjs";

// Installs only into a new temporary CODEX_HOME. It never enables a production
// plugin, reads production Jira credentials, or opens/restarts a desktop window.
const args = process.argv.slice(2);
const argument = (name) => { const index = args.indexOf(name); return index < 0 ? "" : args[index + 1]; };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const explicit = argument("--codex-module");
const executable = argument("--codex-executable");
if (explicit && executable) throw new Error("--codex-module 与 --codex-executable 只能选一个。");
const candidates = explicit ? [resolve(explicit)] : String(process.env.PATH || "").split(delimiter)
  .map((directory) => join(directory, "node_modules", "@openai", "codex", "bin", "codex.js"));
const codexModule = candidates.find(existsSync);
if (executable ? !existsSync(resolve(executable)) : !codexModule) {
  throw new Error("未找到官方 Codex CLI；请用 --codex-executable 提供宿主 CLI 路径，或 --codex-module 提供 codex.js 路径。");
}
const cliCommand = executable ? resolve(executable) : process.execPath;
const cliPrefix = executable ? [] : [codexModule];
const stage = await mkdtemp(join(tmpdir(), "jira-native-install-"));
try {
  const codexHome = join(stage, "codex-home");
  const sqliteHome = join(stage, "sqlite");
  const marketplace = join(stage, "marketplace");
  const npmrc = join(stage, "empty.npmrc");
  await Promise.all([codexHome, sqliteHome, marketplace].map((path) => mkdir(path)));
  await writeFile(npmrc, "", "utf8");
  const env = {
    ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome,
    NPM_CONFIG_CACHE: join(stage, "npm-cache"), NPM_CONFIG_USERCONFIG: npmrc,
    JIRA_WORKBENCH_NATIVE_DATA_DIR: join(stage, "data")
  };
  const archive = argument("--package");
  let tarball;
  if (archive) tarball = resolve(archive);
  else {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", join(root, "packages", "codex-client"), "--json", "--ignore-scripts", "--pack-destination", stage], {
      cwd: stage, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    }))[0];
    tarball = join(stage, packed.filename);
  }
  execFileSync("tar", ["-xf", tarball, "-C", marketplace], { windowsHide: true });
  const manifest = JSON.parse(await readFile(join(marketplace, "package", "plugin.json"), "utf8"));
  await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
  await writeFile(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "jira-native-isolated-test",
    interface: { displayName: "Jira 原生插件隔离验收" },
    plugins: [{
      name: manifest.name, source: { source: "local", path: "./package" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity"
    }]
  }), "utf8");
  const run = (command) => execFileSync(cliCommand, [...cliPrefix, ...command], {
    cwd: stage, env, encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"]
  });
  const version = run(["--version"]).trim();
  run(["plugin", "marketplace", "add", marketplace, "--json"]);
  const installed = JSON.parse(run(["plugin", "add", `${manifest.name}@jira-native-isolated-test`, "--json"]));
  const installedRoot = resolve(installed.installedPath);
  if (!installedRoot.startsWith(`${resolve(codexHome)}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("官方安装器没有返回隔离 CODEX_HOME 内的插件路径，拒绝启动。");
  }
  const mcp = JSON.parse(await readFile(join(installedRoot, "mcp.json"), "utf8"));
  const declaration = mcp.mcpServers?.[manifest.name];
  if (declaration?.type !== "stdio" || declaration.command !== "node" || !Array.isArray(declaration.args)) {
    throw new Error("已安装插件缺少预期的 STDIO 配置。");
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...declaration.args.map((value) => String(value).replaceAll("${PLUGIN_ROOT}", installedRoot)),
      "--idle-timeout-ms", "1000", "--lease-ttl-ms", "3000"],
    cwd: installedRoot, env, stderr: "pipe"
  });
  // Do not print startup stderr: a failed third-party environment can contain
  // user-specific paths or settings. The probe reports only its own metadata.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "jira-native-installed-probe", version: "1" });
  let surfaces;
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = (await client.listTools()).tools;
    surfaces = tools.flatMap((tool) => tool._meta?.["openai/ui"]?.entrypoints || []).map((entry) => entry.type).sort();
    if (JSON.stringify(surfaces) !== JSON.stringify(["global", "settings", "thread"])) {
      throw new Error("已安装插件没有返回完整的三个原生入口声明。");
    }
    const resources = (await client.listResources()).resources;
    if (resources.length !== 3) throw new Error("已安装插件 UI 资源数量错误。");
    for (const resource of resources) {
      const { contents } = await client.readResource({ uri: resource.uri });
      if (contents[0]?.mimeType !== "text/html;profile=mcp-app" || !contents[0]?.text?.includes("jira_codex_status")) {
        throw new Error("已安装插件 UI 资源不是完整的原生 MCP Apps 页面。");
      }
    }
    const status = await client.callTool({ name: "jira_codex_status", arguments: {} });
    if (status.isError || status.structuredContent?.configured !== false) {
      throw new Error("隔离插件未返回未配置状态，拒绝继续访问业务数据。");
    }
  } finally {
    await client.close().catch(() => {});
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && await readDescriptor(env.JIRA_WORKBENCH_NATIVE_DATA_DIR)) {
      await new Promise((complete) => setTimeout(complete, 100));
    }
  }
  if (await readDescriptor(env.JIRA_WORKBENCH_NATIVE_DATA_DIR)) {
    throw new Error("隔离 STDIO 关闭后本地运行时未在期限内回收。");
  }
  // No npm-source success claim: this is an extracted tarball installed using
  // a local catalog. Actual registry installation remains a separate gate.
  console.log(JSON.stringify({
    ok: true, cli: version, plugin: manifest.name, packageVersion: manifest.version,
    verified: "npm tarball → isolated local marketplace → official plugin add → cached STDIO entry → three UI resources",
    installedStdioVerified: true,
    declaredEntrypoints: surfaces,
    npmSourceInstallVerified: false,
    desktopRenderVerified: false,
    productionChanged: false,
    installed
  }, null, 2));
} finally {
  // Exact target was created above by mkdtemp, never a user workspace/root.
  await rm(stage, { recursive: true, force: true });
}
