import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const versionFixtureFiles = [
  "package.json", "package-lock.json", "README.md",
  "packages/core/package.json", "packages/core/bin/serve.mjs", "packages/core/index.mjs",
  "packages/codex/package.json", "packages/codex/server.mjs", "packages/codex/inject/client.js",
  "packages/codex/lib/github-update-checker.mjs",
  "packages/codex/scripts/set-version.mjs", "packages/codex/scripts/verify-release-version.mjs",
  "packages/codex/plugins/jira-workbench-assistant/.codex-plugin/plugin.json",
  "packages/codex-client/package.json", "packages/codex-client/plugin.json",
  "packages/codex-client/.codex-plugin/plugin.json",
  "packages/dsh/package.json", "packages/dsh/plugin.mjs", "packages/dsh/README.md",
  "packages/dsh-client/package.json"
];

async function createVersionFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "jira-workbench-version-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of versionFixtureFiles) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repositoryRoot, relative), target);
  }
  return root;
}

function runVersionScript(root, name, version) {
  return spawnSync(process.execPath, [join(root, "packages/codex/scripts", name), version], {
    cwd: root, encoding: "utf8", windowsHide: true
  });
}

async function readFixtureJson(root, relative) {
  return JSON.parse(await readFile(join(root, relative), "utf8"));
}

test("Release 工作流不会把已发布版本重新降为草稿", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /Create or update published GitHub Release/);
  assert.match(workflow, /gh release view \$tag --json isDraft/);
  assert.match(workflow, /if \(\$release\.isDraft\)/);
  assert.match(workflow, /gh release edit \$tag --draft=false --latest/);
  assert.match(workflow, /gh release create \$tag @assets --verify-tag --generate-notes --title \$tag --latest/);
  assert.doesNotMatch(workflow, /--draft=true/);
  assert.doesNotMatch(workflow, /gh release create[^\r\n]*--draft(?:\s|$)/);
});

test("set-version 同步全部 workspace、DSH 适配层与 Plugin cachebuster", async () => {
  const setVersion = await readFile(new URL("../scripts/set-version.mjs", import.meta.url), "utf8");
  const verifyVersion = await readFile(new URL("../scripts/verify-release-version.mjs", import.meta.url), "utf8");

  // core 独立服务的版本标记必须纳入同步与校验（否则 health 会报陈旧的 0.31.8）。
  assert.match(setVersion, /packages\/core\/bin\/serve\.mjs/);
  assert.match(setVersion, /packages\/core\/index\.mjs/);
  assert.match(verifyVersion, /packages\/core\/bin\/serve\.mjs/);
  assert.match(verifyVersion, /packages\/core\/index\.mjs/);
  assert.match(setVersion, /packages\/dsh-client\/package\.json/);
  assert.match(setVersion, /packages\/codex-client\/package\.json/);
  assert.match(setVersion, /packages\/codex-client\/plugin\.json/);
  assert.match(setVersion, /packages\/codex-client\/\.codex-plugin\/plugin\.json/);
  assert.match(setVersion, /packages\/dsh\/plugin\.mjs/);
  assert.match(verifyVersion, /packages\/dsh-client\/package\.json/);
  assert.match(verifyVersion, /packages\/codex-client\/package\.json/);
  assert.match(verifyVersion, /packages\/dsh\/plugin\.mjs/);

  // Plugin cachebuster 随版本同步到仓库，本地安装时 Codex 能识别新版本。
  assert.match(setVersion, /plugins\/jira-workbench-assistant\/\.codex-plugin\/plugin\.json/);
  assert.match(setVersion, /cachebusterPattern/);
  assert.match(setVersion, /\+codex\.v\$\{version\}/);
});

test("真实版本脚本同步原生包、精确 Core 依赖、lock 与两份 Plugin 清单", async (context) => {
  const root = await createVersionFixture(context);
  const version = "9.8.7-native-preview.1";
  const update = runVersionScript(root, "set-version.mjs", version);
  assert.equal(update.status, 0, update.stderr || update.stdout);
  for (const relative of [
    "package.json", "packages/core/package.json", "packages/codex/package.json",
    "packages/codex-client/package.json", "packages/codex-client/plugin.json",
    "packages/codex-client/.codex-plugin/plugin.json", "packages/dsh/package.json", "packages/dsh-client/package.json"
  ]) {
    assert.equal((await readFixtureJson(root, relative)).version, version, relative);
  }
  const native = await readFixtureJson(root, "packages/codex-client/package.json");
  const lock = await readFixtureJson(root, "package-lock.json");
  assert.equal(native.dependencies["@jira-workbench/core"], version);
  assert.equal(lock.packages["packages/codex-client"].version, version);
  assert.equal(lock.packages["packages/codex-client"].dependencies["@jira-workbench/core"], version);
  assert.equal(lock.packages["packages/codex"].version, version);
  const verify = runVersionScript(root, "verify-release-version.mjs", `v${version}`);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});

test("版本校验拒绝原生清单、Core 精确依赖与 lock 漂移", async (context) => {
  const root = await createVersionFixture(context);
  const version = "9.8.8";
  const update = runVersionScript(root, "set-version.mjs", version);
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const cases = [
    ["packages/codex-client/package.json", (manifest) => { manifest.version = "9.8.7"; }, /codex-client\/package\.json/],
    ["packages/codex-client/plugin.json", (manifest) => { manifest.version = "9.8.7"; }, /codex-client\/plugin\.json/],
    ["packages/codex-client/.codex-plugin/plugin.json", (manifest) => { manifest.version = "9.8.7"; }, /codex-client\/\.codex-plugin\/plugin\.json/],
    ["packages/codex-client/package.json", (manifest) => { manifest.dependencies["@jira-workbench/core"] = "^9.8.8"; }, /必须精确同步/],
    ["package-lock.json", (lock) => { lock.packages["packages/codex-client"].version = "9.8.7"; }, /package-lock\.json.*codex-client/],
    ["package-lock.json", (lock) => { lock.packages["packages/codex-client"].dependencies["@jira-workbench/core"] = "9.8.7"; }, /package-lock\.json.*codex-client/]
  ];
  for (const [relative, mutate, expectedError] of cases) {
    const original = await readFile(join(root, relative), "utf8");
    const manifest = JSON.parse(original);
    mutate(manifest);
    await writeFile(join(root, relative), JSON.stringify(manifest));
    const verify = runVersionScript(root, "verify-release-version.mjs", `v${version}`);
    assert.notEqual(verify.status, 0, relative);
    assert.match(verify.stderr, expectedError);
    await writeFile(join(root, relative), original);
  }
});

test("统一 Release 同时包含 Core、Codex 与 DSH 两侧适配包", async () => {
  const buildRelease = await readFile(new URL("../scripts/build-release.ps1", import.meta.url), "utf8");

  assert.match(buildRelease, /packages\\core/);
  assert.match(buildRelease, /packages\\codex/);
  assert.match(buildRelease, /packages\\dsh'/);
  assert.match(buildRelease, /packages\\dsh-client/);
  assert.match(buildRelease, /packages\\dsh\\plugin\.mjs/);
  assert.match(buildRelease, /packages\\dsh-client\\lib\\client\.js/);
  assert.match(buildRelease, /packages\\codex\\scripts\\codex-processes\.ps1/);
  assert.doesNotMatch(buildRelease, /Copy-ReleaseTree[^\r\n]*packages\\codex-client/);
});

test("Release 通过 Trusted Publishing 按 Core、Client、Host 顺序发布 npm 包", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
  const publishScript = await readFile(new URL("../../../scripts/publish-npm.mjs", import.meta.url), "utf8");
  const core = JSON.parse(await readFile(new URL("../../core/package.json", import.meta.url), "utf8"));
  const client = JSON.parse(await readFile(new URL("../../dsh-client/package.json", import.meta.url), "utf8"));
  const host = JSON.parse(await readFile(new URL("../../dsh/package.json", import.meta.url), "utf8"));

  assert.match(workflow, /publish-npm:/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm install --global npm@11/);
  assert.match(workflow, /release:npm:verify/);
  assert.match(workflow, /--if-missing --provenance/);
  assert.ok(publishScript.indexOf('name: "@jira-workbench/core"') < publishScript.indexOf('name: "@jira-workbench/dsh-client"'));
  assert.ok(publishScript.indexOf('name: "@jira-workbench/dsh-client"') < publishScript.indexOf('name: "@jira-workbench/dsh"'));
  assert.match(publishScript, /https:\/\/registry\.npmjs\.org\//);
  assert.match(publishScript, /mcp\/ui\/task-board\.html/);
  assert.match(publishScript, /lib\/client\.js/);
  assert.match(publishScript, /cordis\.patch\.yml/);
  // Native remains a preview: version alignment never opts it into production.
  assert.doesNotMatch(publishScript, /name: "@jira-workbench\/codex-client"/);
  assert.doesNotMatch(publishScript, /directory: "packages\/codex-client"/);

  for (const manifest of [core, client, host]) {
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/");
  }
  assert.equal(host.name, "@jira-workbench/dsh");
  assert.equal(host.dependencies["@jira-workbench/core"], host.version);
  assert.equal(host.dependencies["@jira-workbench/dsh-client"], host.version);
});
