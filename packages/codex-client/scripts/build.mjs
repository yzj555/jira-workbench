import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const file of ["plugin.json", ".codex-plugin/plugin.json"]) {
  const plugin = JSON.parse(await readFile(join(root, file), "utf8"));
  if (plugin.version !== manifest.version) throw new Error(`${file} 版本未与 npm 包同步。`);
}
await mkdir(join(root, "dist", "ui"), { recursive: true });
await mkdir(join(root, "ui"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { "stdio-entry": "bin/stdio-entry.mjs", daemon: "bin/daemon.mjs", index: "index.mjs" },
  outdir: "dist", outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", target: "node22", format: "esm",
  packages: "bundle", sourcemap: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }
});
// All runtime code (Core, MCP SDK and Zod) is bundled. Both the native loader
// and Core's compatibility resource resolve a real file after npm extraction.
const source = fileURLToPath(import.meta.resolve("@jira-workbench/core/mcp/ui/task-board.html"));
await copyFile(source, join(root, "ui", "core-task-board.html"));
await copyFile(source, join(root, "dist", "ui", "task-board.html"));
await copyFile(join(root, "..", "..", "LICENSE"), join(root, "LICENSE"));
console.log(`Codex 原生插件 v${manifest.version} 构建完成（自包含，不依赖安装脚本）。`);
