import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDescriptor } from "../lib/runtime-client.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

test("npm 解包后的完整插件无 node_modules 仍可运行，双连接共用 Core，退出后服务回收", { timeout: 30000 }, async () => {
  assert.ok(existsSync(npmCli), "npm CLI path must be available for pack verification");
  const stage = await mkdtemp(join(tmpdir(), "jira-native-package-"));
  const clients = [];
  const dataRoot = join(stage, "data");
  try {
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", root, "--ignore-scripts", "--json", "--pack-destination", stage], {
      cwd: stage, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    }))[0];
    const files = new Set(packed.files.map((file) => file.path));
    for (const path of ["plugin.json", ".codex-plugin/plugin.json", "mcp.json", ".mcp.json", "dist/stdio-entry.mjs", "dist/daemon.mjs", "dist/index.mjs", "ui/core-task-board.html", "ui/native-runtime.js", "dist/ui/task-board.html"]) {
      assert.ok(files.has(path), `missing packed file: ${path}`);
    }
    assert.equal([...files].some((path) => path.startsWith("node_modules/")), false);
    const extract = join(stage, "extracted");
    await mkdir(extract);
    execFileSync("tar", ["-xf", join(stage, packed.filename), "-C", extract], { windowsHide: true });
    const packageRoot = join(extract, "package");
    assert.equal(existsSync(join(packageRoot, "node_modules")), false);
    const packedManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(packedManifest.scripts.postinstall, undefined);
    const open = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, "dist", "stdio-entry.mjs"), "--idle-timeout-ms", "1000", "--lease-ttl-ms", "3000"],
        cwd: packageRoot,
        env: { JIRA_WORKBENCH_NATIVE_DATA_DIR: dataRoot, CODEX_HOME: join(stage, "codex-home") },
        stderr: "pipe"
      });
      let errors = "";
      transport.stderr.on("data", (bytes) => { errors += bytes.toString(); });
      const client = new Client({ name: "native-package-smoke", version: "1" });
      clients.push(client);
      try { await client.connect(transport, { timeout: 15000 }); }
      catch (error) { throw new Error(`standalone native bundle failed: ${errors}`, { cause: error }); }
      return client;
    };
    const [first, second] = await Promise.all([open(), open()]);
    const owner = await readDescriptor(dataRoot);
    const status = await first.callTool({ name: "jira_codex_status", arguments: {} });
    assert.equal(status.structuredContent.configured, false);
    assert.equal(status.structuredContent.capabilities.conversationCreation, false);
    const tools = (await first.listTools()).tools;
    assert.equal(tools.filter((tool) => tool._meta?.["openai/ui"]?.entrypoints?.length).length, 3);
    assert.equal(tools.some((tool) => tool.name === "codex_create_and_bind_issue_analysis"), false);
    const resources = (await first.listResources()).resources;
    assert.equal(resources.length, 3);
    for (const resource of resources) {
      const { contents } = await first.readResource({ uri: resource.uri });
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.ok(contents[0].text.includes("jira_codex_status"));
      assert.equal(contents[0].text.includes("http://127.0.0.1:47823"), false);
    }
    await first.close();
    const settings = await second.callTool({ name: "jira_codex_get_settings", arguments: {} });
    assert.equal(settings.structuredContent.credentialConfigured, false);
    assert.equal(Object.hasOwn(settings.structuredContent.config, "token"), false);
    assert.equal((await readDescriptor(dataRoot)).pid, owner.pid);
    // A live bridge must refresh its lease even while the UI is idle.
    await new Promise((complete) => setTimeout(complete, 4200));
    assert.equal((await second.callTool({ name: "jira_codex_status", arguments: {} })).isError, undefined);
    await second.close();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && await readDescriptor(dataRoot)) {
      await new Promise((complete) => setTimeout(complete, 100));
    }
    assert.equal(await readDescriptor(dataRoot), null, "runtime must release its descriptor after last bridge closes");
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    // Only this test's concrete mkdtemp directory is removed.
    await rm(stage, { recursive: true, force: true });
  }
});
