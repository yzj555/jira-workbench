import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { loadNativeUi } from "../lib/native-ui.mjs";

const runtime = await readFile(new URL("../ui/native-runtime.js", import.meta.url), "utf8");

function harness(surface = "global") {
  const messages = [];
  const listeners = {};
  const documentListeners = {};
  const timers = new Map();
  const elements = new Map();
  let timerId = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, hidden: false, style: {}, dataset: {}, textContent: "", innerHTML: "", classList: { toggle() {}, add() {}, remove() {} }, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  };
  const parent = { postMessage(message) { messages.push(message); } };
  const context = vm.createContext({
    URL,
    NATIVE_SURFACE: surface,
    TOOLS: { createAnalysis: "create", threads: "threads", svnConfirmReview: "confirm", svnCommit: "commit" },
    availableTools: null,
    requestId: 1,
    pending: new Map(),
    $: element,
    esc: (value) => String(value ?? "").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    showError(error) { element("error").textContent = error.message; },
    toolResultError(result) { return new Error(result.content?.[0]?.text || "tool failed"); },
    acceptResult() {},
    selectTab() {},
    activeTab: "active",
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, body: { classList: { toggle() {}, add() {}, remove() {} } }, getElementById: element, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); } },
    window: { parent, addEventListener(type, fn) { listeners[type] = fn; }, requestAnimationFrame(fn) { fn(); }, setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); } }
  });
  vm.runInContext(runtime, context);
  const evaluate = (code) => vm.runInContext(code, context);
  const reply = (message, result, error) => listeners.message({ source: parent, data: { jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) } });
  return { context, evaluate, messages, listeners, documentListeners, timers, elements, element, parent, reply };
}

test("native surfaces reuse complete Core workbench with no HTTP or desktop injection transport", async () => {
  for (const surface of ["global", "thread", "settings"]) {
    const html = await loadNativeUi({ version: "1.2.3", surface });
    for (const id of ["board-view", "sheets-view", "detail-view", "svn-view", "native-settings"]) assert.ok(html.includes(`id="${id}"`));
    assert.ok(html.includes(`const NATIVE_SURFACE = "${surface}"`));
    assert.ok(html.includes('const APP_VERSION = "1.2.3"'));
    assert.doesNotMatch(html, /fetch\s*\(|http:\/\/127\.0\.0\.1|tools\/list|desktopBridgeRequest|remote-debugging-port|chrome\.debugger|window\.confirm\(|CDP/);
    assert.doesNotMatch(html, /openLink\(EFFECTIVE_SETTINGS_URL\)/);
    assert.ok(html.includes("nativeOpenSettings()"));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test("native UI escapes version script content and rejects unknown surfaces", async () => {
  const html = await loadNativeUi({ version: '</script><script>bad()</script>' });
  assert.ok(html.includes('\\u003c/script>'));
  await assert.rejects(loadNativeUi({ surface: "cdp" }), /Unknown native UI surface/);
});

test("official bridge rejects non-parent responses and resolves exact matching requests", async () => {
  const h = harness();
  const promise = h.evaluate('request("tools/call", {name:"safe",arguments:{}})');
  const message = h.messages[0];
  h.listeners.message({ source: {}, data: { jsonrpc: "2.0", id: message.id, result: { wrong: true } } });
  assert.equal(h.context.pending.size, 1);
  h.reply(message, { accepted: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await promise)), { accepted: true });
  assert.equal(h.context.pending.size, 0);
  assert.equal(h.timers.size, 0);
});

test("official bridge timeout is bounded and never retries mutation", async () => {
  const h = harness();
  const promise = h.evaluate('request("tools/call", {name:"svn_commit_issue_review",arguments:{}})');
  const rejected = assert.rejects(promise, /响应超时/);
  [...h.timers.values()][0]();
  await rejected;
  assert.equal(h.context.pending.size, 0);
  assert.equal(h.messages.length, 1);
});

test("capabilities come from status tool and explicitly disclose missing thread identity", async () => {
  const h = harness("thread");
  assert.equal(h.evaluate('hasTool("missing")'), false);
  const promise = h.evaluate("loadCapabilities()");
  assert.equal(h.messages[0].method, "tools/call");
  assert.equal(h.messages[0].params.name, "jira_codex_status");
  h.reply(h.messages[0], { structuredContent: { configured: false, availableTools: ["jira_get_issue"] } });
  await promise;
  assert.equal(h.evaluate('hasTool("jira_get_issue")'), true);
  assert.match(h.element("native-capability-notice").textContent, /未提供可验证的当前会话 ID/);
  assert.equal(h.evaluate('hasTool("threads")'), false);
});

test("native setting save requires separate confirmation and wipes submitted token", async () => {
  const h = harness();
  h.evaluate('nativeAcceptSettings({view:"codexSettings",revision:"r1",credentialConfigured:true,config:{baseUrl:"https://jira.example.com",maxResults:100,boardSources:{},promptTemplates:{},syncSettings:{}}})');
  h.element("native-token").value = "one-time-user-token";
  for (const kind of ["requirement", "bug"]) h.element(`native-${kind}-mode`).value = "builtin";
  h.element("native-settings-form").handlers.submit({ preventDefault() {} });
  assert.equal(h.messages.length, 0);
  assert.equal(h.element("native-settings-confirm").hidden, false);
  const promise = h.evaluate("nativeSaveSettings()");
  const saveMessage = h.messages[0];
  assert.equal(saveMessage.params.name, "jira_codex_save_settings");
  assert.equal(saveMessage.params.arguments.acknowledged, true);
  assert.equal(saveMessage.params.arguments.expectedRevision, "r1");
  assert.equal(saveMessage.params.arguments.config.token, "one-time-user-token");
  h.reply(saveMessage, { isError: true, content: [{ type: "text", text: "Revision changed; read settings again" }] });
  await promise;
  assert.equal(h.element("native-token").value, "");
  assert.equal(saveMessage.params.arguments.config.token, undefined);
  assert.match(h.element("native-settings-feedback").textContent, /Revision changed/);
  assert.doesNotMatch(h.element("native-settings-feedback").textContent, /保存成功/);
});

test("missing structured result cannot be accepted as setting save success", () => {
  const h = harness();
  assert.throws(() => h.evaluate('nativeStructuredResult({content:[{type:"text",text:"ok"}]})'), /未被确认成功/);
});

test("settings anchors scroll inside the sandbox without URL navigation", () => {
  const h = harness();
  let prevented = false, scrolled = false;
  h.element("native-sync").scrollIntoView = () => { scrolled = true; };
  h.context.qaAnchorEvent = { preventDefault() { prevented = true; } };
  h.context.qaAnchor = { getAttribute() { return "#native-sync"; }, setAttribute(name, value) { this[name] = value; } };
  h.evaluate("nativeNavigateSettings(qaAnchorEvent, qaAnchor)");
  assert.equal(prevented, true);
  assert.equal(scrolled, true);
  assert.equal(h.context.qaAnchor["aria-current"], "location");
  assert.equal(h.messages.length, 0);
});

test("native settings expose supported read-only sync controls and return their edited values", async () => {
  const h = harness();
  h.evaluate('nativeAcceptSettings({config:{baseUrl:"https://jira.example.com",syncSettings:{tasksEnabled:true,taskIntervalSeconds:300,syncOnPanelReturn:true}}})');
  h.element("native-sync-enabled").checked = false;
  h.element("native-sync-interval").value = "30";
  h.element("native-return-sync").checked = false;
  const settings = JSON.parse(JSON.stringify(h.evaluate("nativeCollectSettings()")));
  assert.deepEqual(settings.syncSettings, { tasksEnabled: false, taskIntervalSeconds: 30, syncOnPanelReturn: false });
  const html = await loadNativeUi();
  for (const id of ["native-sync-enabled", "native-sync-interval", "native-return-sync"]) assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]*disabled`));
  assert.match(html, /nativeScheduleTaskRefresh\(\);/);
});

test("business confirmation uses an explicit in-page action, without browser modal permissions", async () => {
  const h = harness();
  const confirmation = h.evaluate('nativeConfirm("Commit only reviewed paths?")');
  assert.equal(h.element("native-action-confirm").hidden, false);
  assert.equal(h.messages.length, 0);
  h.element("native-action-cancel").handlers.click();
  assert.equal(await confirmation, false);
  const accepted = h.evaluate('nativeConfirm("Confirm next action")');
  h.element("native-action-accept").handlers.click();
  assert.equal(await accepted, true);
  assert.equal(h.element("native-action-confirm").hidden, true);
});

test("full native startup initializes the official bridge and never loads Jira while unconfigured", async () => {
  const h = harness();
  const html = await loadNativeUi({ surface: "global" });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // A fresh context exercises the complete reused Core script, not just its helper functions.
  const { NATIVE_SURFACE, TOOLS, availableTools, requestId, pending, $, esc, showError, toolResultError, acceptResult, selectTab, activeTab, ...freshGlobals } = h.context;
  const fresh = vm.createContext(freshGlobals);
  vm.runInContext(script, fresh);
  assert.equal(h.messages[0].method, "ui/initialize");
  h.reply(h.messages[0], { hostContext: { theme: "dark" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages[1].method, "ui/notifications/initialized");
  assert.equal(h.messages[2].params.name, "jira_codex_status");
  h.reply(h.messages[2], { structuredContent: { configured: false, availableTools: [] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages[3].params.name, "jira_codex_get_settings");
  h.reply(h.messages[3], { structuredContent: { view: "codexSettings", config: { configured: false, baseUrl: "", hasToken: false }, revision: "empty" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages.length, 4);
  assert.equal(h.element("native-settings").hidden, false);
  assert.equal(h.element("version-status").textContent, "v0.33.8");
  assert.equal(fresh.document.documentElement.dataset.theme, "dark");
});

test("configured native detail opens normally without an optional host project catalog", async () => {
  const h = harness();
  const html = await loadNativeUi({ surface: "global" });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { NATIVE_SURFACE, TOOLS, availableTools, requestId, pending, $, esc, showError, toolResultError, acceptResult, selectTab, activeTab, ...freshGlobals } = h.context;
  const fresh = vm.createContext(freshGlobals);
  vm.runInContext(script, fresh);
  h.reply(h.messages[0], { hostContext: { theme: "light" } });
  await new Promise((resolve) => setImmediate(resolve));
  h.reply(h.messages[2], { structuredContent: { configured: true, availableTools: ["jira_list_my_tasks", "jira_get_issue", "jira_get_issue_workspaces"] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.messages[3], h.element("error").textContent);
  h.reply(h.messages[3], { structuredContent: { view: "board", fetchedAt: "2026-10-08", active: { requirements: [], bugs: [] }, completed: { requirements: [], bugs: [] } } });
  await new Promise((resolve) => setImmediate(resolve));
  const detail = vm.runInContext('openIssue("QA-101")', fresh);
  h.reply(h.messages[4], { structuredContent: { view: "issue", issueKey: "QA-101", issue: { key: "QA-101", title: "Mock native detail", summary: "Mock context", statusName: "Open", typeName: "Requirement", attachments: [], collaborators: [] } } });
  await new Promise((resolve) => setImmediate(resolve));
  h.reply(h.messages[5], { structuredContent: { view: "workspaceBindings", issueKey: "QA-101", binding: null } });
  await detail;
  assert.equal(h.element("detail-view").hidden, false);
  assert.match(h.element("detail-view").innerHTML, /Mock native detail/);
  assert.equal(h.element("error").textContent, "");
  assert.equal(h.messages.some((message) => message.params?.name === "jira_list_available_workspaces"), false);
  await vm.runInContext('callTool("explicitly_missing_action")', fresh);
  assert.match(h.element("error").textContent, /当前原生宿主未提供工具/);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function workbenchFixture() {
  const h = harness();
  const html = await loadNativeUi();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { NATIVE_SURFACE, TOOLS, availableTools, requestId, pending, $, esc, showError, toolResultError, acceptResult, selectTab, activeTab, ...globals } = h.context;
  const context = vm.createContext(globals);
  vm.runInContext(script, context);
  h.reply(h.messages[0], { hostContext: { theme: "light" } });
  await settle();
  h.reply(h.messages[2], { structuredContent: { configured: true, availableTools: [
    "jira_list_my_tasks", "jira_get_issue", "jira_preview_issue_attachment", "svn_inspect_issue_changes",
    "svn_get_issue_review", "svn_preview_issue_diff", "svn_open_issue_external_diff", "svn_commit_issue_review"
  ] } });
  await settle();
  h.reply(h.messages[3], { structuredContent: { view: "board", active: { requirements: [], bugs: [] }, completed: { requirements: [], bugs: [] } } });
  await settle();
  h.messages.length = 0;
  return { ...h, html, context, evaluate: (code) => vm.runInContext(code, context), accept(result) { context.fixtureResult = result; vm.runInContext("acceptResult(fixtureResult)", context); } };
}

function attachmentIssue() {
  return { view: "issue", issueKey: "QA-101", issue: { key: "QA-101", url: "https://jira.example.com/browse/QA-101", title: "Mock attachments", statusName: "Open", summary: "Mock context", attachments: [
    { id: "11", filename: "first.png", mimeType: "image/png", previewable: true },
    { id: "12", filename: "second.png", mimeType: "image/png", previewable: true },
    { id: "13", filename: "spec.pdf", mimeType: "application/pdf", previewable: false }
  ], parentIssue: { key: "QA-100", url: "https://jira.example.com/browse/QA-100", title: "Mock parent", attachments: [
    { id: "21", filename: "parent.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceIssueKey: "QA-100", previewable: false }
  ] } } };
}

function svnContext(issueKey = "QA-101", review = null) {
  return { view: "svnContext", issueKey, review, context: { changes: [], workingCopy: { root: "C:/fixture/project", scopeRoot: "C:/fixture/project", projectScopeId: "scope-a" } }, capabilities: { codexReview: false } };
}

test("native parent and document links use only the official open-link bridge", async () => {
  const h = await workbenchFixture();
  h.accept(attachmentIssue());
  const detail = h.element("detail-view").innerHTML;
  assert.doesNotMatch(detail, /<a\b|target="_blank"|file:\/\/|download=/);
  assert.match(detail, /data-native-open-url="https:\/\/jira\.example\.com\/browse\/QA-100"/);
  assert.match(detail, /在 Jira 中查看/);
  const target = { dataset: { nativeOpenUrl: "https://jira.example.com/browse/QA-100" }, closest(selector) { return selector === "[data-native-open-url]" ? this : null; } };
  let prevented = false;
  for (const handler of h.documentListeners.click) await handler({ target, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].method, "ui/open-link");
  assert.equal(h.messages[0].params.url, "https://jira.example.com/browse/QA-100");
  h.reply(h.messages[0], {});
  await settle();
  for (const value of ["file:///C:/private.txt", "http://127.0.0.1:1234/mcp", "http://localhost/mcp", "http://[::1]/", "javascript:alert(1)", "https://user:secret@jira.example.com/"]) {
    h.context.fixtureUrl = value;
    await assert.rejects(h.evaluate("nativeOpenExternalLink(fixtureUrl)"), /该地址/);
  }
  assert.equal(h.messages.length, 1);
});

test("native image preview deduplicates in-flight and repeated requests and retains original image data", async () => {
  const h = await workbenchFixture();
  h.accept(attachmentIssue());
  const first = h.evaluate('nativePreviewAttachment("11")');
  const concurrent = h.evaluate('nativePreviewAttachment("11")');
  assert.equal(h.messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", attachmentId: "11" });
  const preview = { view: "attachmentPreview", preview: { issueKey: "QA-101", attachmentId: "11", filename: "first.png", dataUrl: "data:image/png;base64,YQ==", thumbnail: false } };
  h.reply(h.messages[0], { structuredContent: preview });
  await Promise.all([first, concurrent]);
  await h.evaluate('nativePreviewAttachment("11")');
  assert.equal(h.messages.length, 1);
  assert.match(h.element("detail-view").innerHTML, /data:image\/png;base64,YQ==/);
  h.evaluate("attachmentLightboxOpen = true; renderDetail()");
  assert.match(h.element("detail-view").innerHTML, /data-native-image-size/);
  h.evaluate("nativeAttachmentOriginalSize = true; renderDetail()");
  assert.match(h.element("detail-view").innerHTML, /attachment-lightbox-stage native-original-size/);
  assert.match(h.html, /\.attachment-lightbox-stage\.native-original-size img \{[^}]*width: auto; height: auto;/);
  assert.doesNotMatch(h.html, /window\.open\(|window\.confirm\(|fetch\s*\(/);
});

test("native preview rejects mismatched and non-image results without rendering them", async () => {
  const h = await workbenchFixture();
  h.accept(attachmentIssue());
  const operation = h.evaluate('nativePreviewAttachment("12")');
  h.reply(h.messages[0], { structuredContent: { view: "attachmentPreview", preview: { issueKey: "QA-999", attachmentId: "12", dataUrl: "data:text/html;base64,YQ==" } } });
  await assert.rejects(operation, /不一致/);
  assert.equal(h.evaluate("nativeAttachmentCache.size"), 0);
  assert.equal(h.evaluate("cache.attachmentPreview"), null);
  await assert.rejects(h.evaluate('nativePreviewAttachment("13")'), /图片附件/);
  assert.equal(h.messages.length, 1);
});

test("native image cache is bounded and cannot render a late preview onto another task", async () => {
  const h = await workbenchFixture();
  const issue = attachmentIssue();
  issue.issue.attachments = [1, 2, 3, 4, 5].map((id) => ({ id: String(id), filename: `${id}.png`, previewable: true }));
  h.accept(issue);
  for (const id of [1, 2, 3, 4, 5]) {
    const operation = h.evaluate(`nativePreviewAttachment("${id}")`);
    h.reply(h.messages.at(-1), { structuredContent: { view: "attachmentPreview", preview: { issueKey: "QA-101", attachmentId: String(id), filename: `${id}.png`, dataUrl: "data:image/png;base64,YQ==" } } });
    await operation;
  }
  assert.equal(h.evaluate("nativeAttachmentCache.size"), 4);
  assert.equal(h.evaluate('nativeAttachmentCache.has("QA-101:1")'), false);
  const late = h.evaluate('nativePreviewAttachment("1")');
  h.accept({ view: "issue", issueKey: "QA-102", issue: { key: "QA-102", title: "Another task", attachments: [] } });
  h.reply(h.messages.at(-1), { structuredContent: { view: "attachmentPreview", preview: { issueKey: "QA-101", attachmentId: "1", filename: "old.png", dataUrl: "data:image/png;base64,YQ==" } } });
  await late;
  assert.doesNotMatch(h.element("detail-view").innerHTML, /old\.png/);
});

test("native SVN close returns to the list when no matching task detail was loaded", async () => {
  const h = await workbenchFixture();
  h.accept(svnContext());
  assert.equal(h.element("svn-view").hidden, false);
  h.evaluate("nativeCloseSvn()");
  await settle();
  assert.equal(h.element("svn-view").hidden, true);
  assert.equal(h.element("detail-view").hidden, true);
  assert.equal(h.element("board-view").hidden, false);
  assert.equal(h.messages.length, 0);
  h.accept(attachmentIssue());
  h.accept(svnContext());
  h.evaluate("nativeCloseSvn()");
  assert.equal(h.element("detail-view").hidden, false);
  assert.match(h.element("detail-view").innerHTML, /Mock attachments/);
});

test("direct SVN review UI hydrates only its explicit project scope using a read-only tool", async () => {
  const h = await workbenchFixture();
  const review = { id: "fixture-review", status: "manual_review", verdict: "pass", selectedPaths: [], workingCopy: { projectScopeId: "scope-a" } };
  h.accept({ view: "svnReview", issueKey: "QA-101", review });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].params.name, "svn_inspect_issue_changes");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", projectScopeId: "scope-a" });
  h.reply(h.messages[0], { structuredContent: svnContext("QA-101", review) });
  await settle();
  assert.equal(h.element("svn-view").hidden, false);
  assert.match(h.element("svn-view").innerHTML, /人工确认/);
  assert.equal(h.messages.length, 1);
});

test("native TortoiseSVN result needs explicit server success and never launches a browser", async () => {
  const h = await workbenchFixture();
  h.accept({ view: "svnExternalDiff", issueKey: "QA-101", result: { ok: true, path: "src/a.go" } });
  assert.match(h.element("meta").textContent, /TortoiseSVN/);
  h.accept({ view: "svnExternalDiff", issueKey: "QA-101", result: {} });
  assert.match(h.element("error").textContent, /工具未确认/);
  assert.equal(h.messages.length, 0);
});

test("native SVN commit keeps the confirmed review and token and does not repeat an unknown mutation", async () => {
  const h = await workbenchFixture();
  h.accept(svnContext());
  const review = { id: "fixture-review", status: "manual_review", selectedPaths: ["src/a.go"], message: "Mock commit text" };
  h.accept({ view: "svnCommitConfirmation", issueKey: "QA-101", review, confirmationToken: "fixture-one-use-token" });
  const operation = h.evaluate("nativeCommitSvn()");
  assert.equal(h.messages.length, 0);
  assert.match(h.element("native-action-description").textContent, /Mock commit text/);
  h.element("native-action-accept").handlers.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", reviewId: "fixture-review", confirmationToken: "fixture-one-use-token" });
  h.reply(h.messages[0], { structuredContent: { view: "svnCommitResult", issueKey: "QA-101", review: { ...review, status: "commit_unknown" } } });
  await operation;
  assert.equal(h.messages.filter((message) => message.params.name === "svn_commit_issue_review").length, 1);
  assert.match(h.element("svn-view").innerHTML, /提交结果未知/);
});

test("native parent image preview is scoped to the execution issue while preserving its source issue", async () => {
  const h = await workbenchFixture();
  const issue = attachmentIssue();
  issue.issue.parentIssue.attachments.push({ id: "22", sourceIssueKey: "QA-100", filename: "parent.png", mimeType: "image/png", previewable: true });
  h.accept(issue);
  const operation = h.evaluate('nativePreviewAttachment("22")');
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", attachmentId: "22" });
  h.reply(h.messages[0], { structuredContent: { view: "attachmentPreview", preview: { issueKey: "QA-101", sourceIssueKey: "QA-100", attachmentId: "22", filename: "parent.png", dataUrl: "data:image/png;base64,YQ==" } } });
  await operation;
  assert.equal(h.evaluate("cache.attachmentPreview.preview.sourceIssueKey"), "QA-100");
  assert.match(h.element("detail-view").innerHTML, /parent\.png/);
  assert.equal(h.element("error").textContent, "");
});

test("native failed SVN commit issues no automatic mutation retry", async () => {
  const h = await workbenchFixture();
  h.accept(svnContext());
  const review = { id: "fixture-review", status: "manual_review", verdict: "pass", selectedPaths: ["src/a.go"], message: "Mock commit" };
  h.accept({ view: "svnCommitConfirmation", issueKey: "QA-101", review, confirmationToken: "fixture-one-use-token" });
  const operation = h.evaluate("nativeCommitSvn()");
  h.element("native-action-accept").handlers.click();
  await settle();
  h.reply(h.messages[0], { isError: true, content: [{ type: "text", text: "Mock rejected stale confirmation" }] });
  await settle();
  h.reply(h.messages[1], { structuredContent: { view: "svnReview", issueKey: "QA-101", review: { ...review, status: "stale" } } });
  await settle();
  if (h.messages[2]) h.reply(h.messages[2], { structuredContent: { view: "svnReview", issueKey: "QA-101", review: { ...review, status: "stale" } } });
  await operation;
  assert.equal(h.messages.filter((message) => message.params.name === "svn_commit_issue_review").length, 1);
  assert.ok(h.messages.slice(1).every((message) => message.params.name === "svn_get_issue_review"));
  assert.equal(h.evaluate("cache.svnConfirmation"), null);
});

test("native SVN confirmation cancels safely on changed review or closed page", async () => {
  for (const changed of [true, false]) {
    const h = await workbenchFixture();
    h.accept(svnContext());
    h.accept({ view: "svnCommitConfirmation", issueKey: "QA-101", review: { id: "fixture-review", selectedPaths: ["a.go"], message: "Mock commit" }, confirmationToken: "fixture-token" });
    const operation = h.evaluate("nativeCommitSvn()");
    if (changed) {
      h.accept({ view: "svnReview", issueKey: "QA-101", review: { id: "changed-review", selectedPaths: ["b.go"] } });
      h.element("native-action-accept").handlers.click();
    } else h.evaluate("nativeCloseSvn()");
    await operation;
    assert.equal(h.messages.length, 0);
    assert.equal(h.element("native-action-confirm").hidden, true);
    if (changed) assert.match(h.element("error").textContent, /未执行提交/);
  }
});

test("native direct-review hydration cannot reopen SVN after a user navigates away or chooses another scope", async () => {
  for (const changedScope of [true, false]) {
    const h = await workbenchFixture();
    const review = { id: "old-review", selectedPaths: [], workingCopy: { projectScopeId: "scope-a" } };
    h.accept({ view: "svnReview", issueKey: "QA-101", review });
    const message = h.messages[0];
    if (changedScope) {
      const current = svnContext("QA-102");
      current.selectedProjectScopeId = "scope-b";
      h.accept(current);
    } else await h.evaluate('selectTab("active")');
    h.reply(message, { structuredContent: svnContext("QA-101", review) });
    await settle();
    if (changedScope) assert.equal(h.evaluate("cache.svnContext.issueKey"), "QA-102");
    else assert.equal(h.element("svn-view").hidden, true);
    assert.notEqual(h.evaluate("cache.svnReview?.id"), "old-review");
  }
});

test("native direct-review hydration refuses ambiguous scopes without executing another tool", async () => {
  const h = await workbenchFixture();
  h.accept({ view: "svnCommitConfirmation", issueKey: "QA-101", review: { id: "fixture-review" }, confirmationToken: "fixture-token" });
  h.reply(h.messages[0], { structuredContent: { view: "svnContext", issueKey: "QA-101", scopeSelectionRequired: true, projectScopes: [
    { id: "scope-a", projectLabel: "First project" }, { id: "scope-b", projectLabel: "Second project" }
  ] } });
  await settle();
  assert.match(h.element("error").textContent, /明确选择目录/);
  assert.match(h.element("svn-view").innerHTML, /选择本次操作范围/);
  assert.equal(h.evaluate("cache.svnConfirmation"), null);
  assert.equal(h.messages.length, 1);
});

test("native SVN file preview, double-click Tortoise and refresh keep explicit project scope", async () => {
  const h = await workbenchFixture();
  const context = svnContext();
  context.context.changes = [{ path: "src/a.go", kind: "file", item: "modified", recommended: true }];
  h.accept(context);
  const row = { dataset: { svnPreviewRow: "src/a.go", svnExternalDiff: "src/a.go" }, closest(selector) { return selector.includes(".svn-file") ? this : null; } };
  const event = { target: row, preventDefault() {} };
  h.context.fixtureEvent = event;
  assert.equal(h.evaluate("svnFileInteraction.click(fixtureEvent)"), true);
  [...h.timers.values()][0]();
  assert.equal(h.messages[0].params.name, "svn_preview_issue_diff");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", projectScopeId: "scope-a", path: "src/a.go" });
  h.reply(h.messages[0], { structuredContent: { view: "svnDiff", issueKey: "QA-101", preview: { path: "src/a.go", available: true, diff: "+fixture" } } });
  await settle();
  const timersBefore = h.timers.size;
  h.evaluate("svnFileInteraction.click(fixtureEvent)");
  assert.equal(h.timers.size, timersBefore);
  assert.equal(h.messages.length, 1);
  assert.equal(h.evaluate("svnFileInteraction.doubleClick(fixtureEvent)"), true);
  assert.equal(h.messages[1].params.name, "svn_open_issue_external_diff");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[1].params.arguments)), { issueKey: "QA-101", projectScopeId: "scope-a", path: "src/a.go" });
  h.reply(h.messages[1], { structuredContent: { view: "svnExternalDiff", issueKey: "QA-101", result: { ok: true } } });
  await settle();
  const refreshTarget = { closest(selector) { return selector === "#refresh-svn-workbench" ? this : null; }, matches() { return false; } };
  for (const handler of h.documentListeners.click) await handler({ target: refreshTarget, preventDefault() {} });
  assert.equal(h.messages[2].params.name, "svn_inspect_issue_changes");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[2].params.arguments)), { issueKey: "QA-101", projectScopeId: "scope-a" });
  h.reply(h.messages[2], { structuredContent: context });
  await settle();
  assert.match(h.element("svn-view").innerHTML, /src\/a.go/);
  assert.equal(h.messages.some((message) => message.method === "ui/open-link"), false);
});

test("same Jira review and confirmation for a different project scope hydrate the reviewed directory", async () => {
  for (const view of ["svnReview", "svnCommitConfirmation", "svnCommitResult"]) {
    const h = await workbenchFixture();
    h.accept(svnContext());
    const review = { id: "scope-b-review", status: "manual_review", verdict: "pass", selectedPaths: ["b.go"], workingCopy: { projectScopeId: "scope-b" } };
    h.accept({ view, issueKey: "QA-101", review, ...(view === "svnCommitConfirmation" ? { confirmationToken: "scope-b-token" } : {}) });
    assert.equal(h.messages.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].params.arguments)), { issueKey: "QA-101", projectScopeId: "scope-b" });
    assert.notEqual(h.evaluate("cache.svnReview?.id"), "scope-b-review");
    const scopeB = svnContext("QA-101", review);
    scopeB.selectedProjectScopeId = "scope-b";
    scopeB.context.workingCopy.projectScopeId = "scope-b";
    h.reply(h.messages[0], { structuredContent: scopeB });
    await settle();
    assert.equal(h.evaluate("activeSvnProjectScopeId()"), "scope-b");
    assert.equal(h.evaluate("cache.svnReview.id"), "scope-b-review");
    assert.equal(h.evaluate("svnScopedArguments({path:'b.go'}).projectScopeId"), "scope-b");
    if (view === "svnCommitConfirmation") assert.equal(h.evaluate("cache.svnConfirmation.confirmationToken"), "scope-b-token");
  }
});

test("SVN hydration refuses a response for the wrong directory even when the Jira key matches", async () => {
  const h = await workbenchFixture();
  h.accept(svnContext());
  h.accept({ view: "svnCommitConfirmation", issueKey: "QA-101", review: { id: "scope-b-review", workingCopy: { projectScopeId: "scope-b" }, selectedPaths: [] }, confirmationToken: "scope-b-token" });
  h.reply(h.messages[0], { structuredContent: svnContext() });
  await settle();
  assert.equal(h.evaluate("activeSvnProjectScopeId()"), "scope-a");
  assert.equal(h.evaluate("cache.svnConfirmation"), null);
  assert.match(h.element("error").textContent, /上下文尚未确认/);
  assert.equal(h.messages.length, 1);
});

test("tab ABA navigation and opening a detail invalidate old automatic-refresh generations", async () => {
  const h = await workbenchFixture();
  const initial = h.evaluate("nativeSyncGeneration");
  await h.evaluate('selectTab("history")');
  await h.evaluate('selectTab("active")');
  assert.equal(h.evaluate("nativeSyncGeneration"), initial + 2);
  const detail = h.evaluate('openIssue("QA-101")');
  assert.equal(h.evaluate("nativeSyncGeneration"), initial + 3);
  assert.equal(h.messages.length, 1);
  h.reply(h.messages[0], { structuredContent: attachmentIssue() });
  await detail;
  assert.equal(h.element("detail-view").hidden, false);
});
