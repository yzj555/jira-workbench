import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeVersion } from "../lib/github-update-checker.mjs";

// 脚本位于 packages/codex/scripts/，仓库根为其上三级（dirname 需四次：文件→scripts→codex→packages→根）。
const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const tagVersion = normalizeVersion(process.argv[2] || process.env.GITHUB_REF_NAME || "");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = normalizeVersion(packageJson.version);
if (!tagVersion) throw new Error("必须提供 vX.Y.Z Release tag。");
if (tagVersion !== version) throw new Error(`Release tag v${tagVersion} 与 package.json v${version} 不一致。`);

for (const relative of [
  "packages/core/package.json",
  "packages/codex/package.json",
  "packages/codex-client/package.json",
  "packages/codex-client/plugin.json",
  "packages/codex-client/.codex-plugin/plugin.json",
  "packages/dsh/package.json",
  "packages/dsh-client/package.json"
]) {
  const manifest = JSON.parse(await readFile(join(root, relative), "utf8"));
  if (normalizeVersion(manifest.version) !== version) {
    throw new Error(`${relative} 没有同步到 v${version}。`);
  }
}
const nativeManifest = JSON.parse(await readFile(join(root, "packages/codex-client/package.json"), "utf8"));
if (nativeManifest.dependencies?.["@jira-workbench/core"] !== packageJson.version) {
  throw new Error(`packages/codex-client/package.json 的 @jira-workbench/core 必须精确同步到 v${version}。`);
}
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const nativeLock = lock.packages?.["packages/codex-client"];
if (nativeLock?.version !== nativeManifest.version
    || nativeLock?.dependencies?.["@jira-workbench/core"] !== nativeManifest.dependencies["@jira-workbench/core"]) {
  throw new Error("package-lock.json 的 packages/codex-client 版本或 Core 依赖与清单不一致。");
}
const dshManifest = JSON.parse(await readFile(join(root, "packages/dsh/package.json"), "utf8"));
for (const dependency of ["@jira-workbench/core", "@jira-workbench/dsh-client"]) {
  if (normalizeVersion(dshManifest.dependencies?.[dependency]) !== version) {
    throw new Error(`packages/dsh/package.json 的 ${dependency} 没有同步到 v${version}。`);
  }
}

const checks = [
  ["packages/codex/server.mjs", `const VERSION = "${version}";`],
  ["packages/codex/inject/client.js", `const VERSION = "${version}";`],
  ["packages/core/bin/serve.mjs", `const VERSION = "${version}";`],
  ["packages/core/index.mjs", `  version = "${version}"`],
  ["packages/dsh/plugin.mjs", `    version: config.version || "${version}"`],
  ["packages/dsh/README.md", `> 当前 Jira Workbench 版本：\`${version}\``],
  ["README.md", `> 当前版本：\`${version}\``]
];
for (const [relative, marker] of checks) {
  const content = await readFile(join(root, relative), "utf8");
  if (!content.includes(marker)) throw new Error(`${relative} 没有同步到 v${version}。`);
}
console.log(`Release v${version} 版本一致性检查通过。`);
