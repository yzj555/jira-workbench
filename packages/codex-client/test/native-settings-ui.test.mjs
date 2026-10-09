import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../ui/native-runtime.js", import.meta.url), "utf8");
function fixture() {
  const elements = new Map(), messages = [], listeners = {};
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, hidden: true, disabled: false,
      innerHTML: "", textContent: "", style: {}, handlers: {}, focus() {},
      addEventListener(name, handler) { this.handlers[name] = handler; } });
    return elements.get(id);
  };
  const parent = { postMessage(message) { messages.push(message); } };
  const context = vm.createContext({
    NATIVE_SURFACE: "global", TOOLS: {}, availableTools: null, requestId: 1, pending: new Map(), busy: false,
    cache: { board: null, sheets: null, sheet: null }, selectedSheet: null,
    $: element, esc: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    toolResultError: (result) => new Error(result.content?.[0]?.text || "failure"),
    acceptResult() {}, showError() {}, selectTab: async () => {}, activeTab: "active",
    document: { querySelectorAll: () => [], addEventListener() {}, getElementById: element },
    window: { parent, setTimeout: () => 1, clearTimeout() {}, addEventListener(name, handler) { listeners[name] = handler; } }
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  run('nativeAcceptSettings({view:"codexSettings",revision:"' + "a".repeat(64) + '",config:{baseUrl:"https://jira.example.test",hasToken:true,boardSources:{projectKey:"QA",requirement:{mode:"filter",filterIds:["11","99"]},bug:{mode:"builtin"}},syncSettings:{tasksEnabled:true,taskIntervalSeconds:60,syncOnPanelReturn:true,sheetsIntervalSeconds:600,updateCheckEnabled:false},promptTemplates:{}}})');
  // This minimal DOM does not parse innerHTML, so populate generated controls.
  for (const kind of ["requirement", "bug"]) { element(`native-${kind}-mode`).value = kind === "bug" ? "builtin" : "filter"; }
  element("native-requirement-filters").value = "11, 99";
  return { run, element, messages, context, notify(output) { listeners.message({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: output } } }); }, reply(message, result) { listeners.message({ source: parent, data: { jsonrpc: "2.0", id: message.id, result } }); } };
}

test("Jira选项只发送revision/项目Key，未保存PAT不发送也不被清空", async () => {
  const f = fixture(); f.element("native-token").value = "unsaved-fixture-pat";
  const operation = f.run("nativeLoadSettingsOptions()");
  const message = f.messages[0];
  assert.equal(message.params.name, "jira_codex_list_settings_options");
  assert.deepEqual(Object.keys(message.params.arguments).sort(), ["expectedRevision", "projectKey"]);
  assert.doesNotMatch(JSON.stringify(message), /unsaved-fixture-pat/);
  f.reply(message, { structuredContent: { view: "codexSettingsOptions", revision: "a".repeat(64), projects: [{ key: "QA", name: "Quality" }], filters: [{ id: "11", name: "QA Filter", owner: "Tester" }], warnings: [] } });
  await operation;
  assert.match(f.element("native-jira-projects").innerHTML, /Quality/);
  assert.match(f.element("native-requirement-filter-choices").innerHTML, /checked/);
  assert.equal(f.element("native-requirement-filters").value, "11, 99");
  assert.equal(f.element("native-token").value, "unsaved-fixture-pat");
  assert.equal(f.element("native-options-reload").disabled, false);
});

test("Filter选择与ID字段联动，目录未返回的已选项不丢失", () => {
  const f = fixture();
  const change = f.element("native-board-sources").handlers.change;
  change({ target: { checked: true, dataset: { nativeFilterKind: "requirement", nativeFilterId: "12" } } });
  assert.equal(f.element("native-requirement-filters").value, "11, 99, 12");
  change({ target: { checked: false, dataset: { nativeFilterKind: "requirement", nativeFilterId: "11" } } });
  assert.equal(f.element("native-requirement-filters").value, "99, 12");
});

test("来源模式切换只改变显隐，不提前清除Filter与自定义JQL草稿", () => {
  const f = fixture(); f.element("native-requirement-jql").value = "project = QA";
  f.element("native-requirement-mode").value = "custom";
  f.run('nativeUpdateSourceFields("requirement")');
  assert.equal(f.element("native-requirement-jql-field").hidden, false);
  assert.equal(f.element("native-requirement-filter-field").hidden, true);
  assert.equal(f.element("native-requirement-filters").value, "11, 99");
  f.element("native-requirement-mode").value = "filter";
  f.run('nativeUpdateSourceFields("requirement")');
  assert.equal(f.element("native-requirement-jql").value, "project = QA");
});

test("修改同步策略只保存支持字段，同时保留Sheets和更新策略", () => {
  const f = fixture();
  f.element("native-sync-enabled").checked = false;
  f.element("native-sync-interval").value = "300";
  f.element("native-return-sync").checked = false;
  const collected = JSON.parse(JSON.stringify(f.run("nativeCollectSettings()")));
  assert.deepEqual(collected.syncSettings, { tasksEnabled: false, taskIntervalSeconds: 300, syncOnPanelReturn: false, sheetsIntervalSeconds: 600, updateCheckEnabled: false });
});

test("迟到的旧配置选项不能覆盖新设置状态", () => {
  const f = fixture();
  f.element("native-jira-projects").innerHTML = "current selection";
  f.run('nativeAcceptSettingsOptions({revision:"old",projects:[{key:"OLD",name:"Old project"}],filters:[]})');
  assert.equal(f.element("native-jira-projects").innerHTML, "current selection");
});

test("关闭设置会丢弃待确认PAT和保存草稿，不会在下次打开执行旧保存", () => {
  const f = fixture(); f.element("native-token").value = "draft-fixture-pat";
  f.element("native-settings-form").handlers.submit({ preventDefault() {} });
  assert.equal(f.element("native-settings-confirm").hidden, false);
  f.element("native-settings-close").handlers.click();
  assert.equal(f.element("native-token").value, "");
  assert.equal(f.element("native-settings-confirm").hidden, true);
  assert.equal(f.run("nativeSettingsDraft"), null);
  assert.equal(f.messages.length, 0);
});

test("宿主迟到的board通知也不能覆盖详情、SVN或设置", () => {
  for (const visible of ["detail-view", "svn-view", "native-settings"]) {
    const f = fixture(); let accepted = 0;
    f.context.acceptResult = () => { accepted++; };
    f.element("board-view").hidden = false;
    f.element(visible).hidden = false;
    f.notify({ view: "board" });
    assert.equal(accepted, 0);
  }
});

test("被动board通知不覆盖已确认读取，列表只接受自身请求的返回", () => {
  const f = fixture(); let accepted = 0;
  f.context.acceptResult = () => { accepted++; };
  f.element("board-view").hidden = false;
  f.notify({ view: "board", fixture: "late-auto-notification" });
  assert.equal(accepted, 0);
});

test("配置revision变化清除旧连接列表和选中Sheet，即使关闭自动刷新", () => {
  const f = fixture();
  f.context.cache = { board: { old: true }, sheets: { old: true }, sheet: { old: true } };
  f.context.selectedSheet = { id: "old-site-sheet" };
  f.run('nativeAcceptSettings({revision:"' + "b".repeat(64) + '",config:{baseUrl:"https://new.example.test",syncSettings:{tasksEnabled:false}}})');
  assert.deepEqual(f.context.cache, { board: null, sheets: null, sheet: null });
  assert.equal(f.context.selectedSheet, null);
  assert.equal(f.messages.length, 0);
});
