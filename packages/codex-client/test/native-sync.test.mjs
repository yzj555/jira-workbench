import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const runtime = await readFile(new URL("../ui/native-runtime.js", import.meta.url), "utf8");
const source = runtime.split("/* NATIVE_TASK_SYNC_START */")[1].split("/* NATIVE_TASK_SYNC_END */")[0];

function fixture({ surface = "global", enabled = true, capable = true } = {}) {
  const timers = new Map(), elements = new Map(), calls = [], results = [], listeners = {};
  let nextTimer = 0, response;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: id !== "board-view", textContent: "" });
    return elements.get(id);
  };
  const context = vm.createContext({
    NATIVE_SURFACE: surface,
    nativeStatus: { configured: true, capabilities: { taskAutoRefresh: capable } },
    nativeSettingsBusy: false, nativeActionResolver: null, busy: false, pending: new Map(),
    activeTab: "active", TOOLS: { board: "jira_list_my_tasks" },
    $: element,
    document: { visibilityState: "visible", activeElement: null, addEventListener(name, handler) { listeners[name] = handler; } },
    window: {
      setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(name, handler) { listeners[name] = handler; }
    },
    hasTool: () => true,
    request(method, params) { calls.push({ method, params }); return new Promise((resolve, reject) => { response = { resolve, reject }; }); },
    nativeStructuredResult(value) { if (value.isError) throw new Error("fixture failure"); return value.structuredContent; },
    acceptResult(value) { results.push(value); }
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  run(`nativeApplySyncPolicy({tasksEnabled:${enabled},taskIntervalSeconds:30,syncOnPanelReturn:true})`);
  return { context, run, timers, elements, element, calls, results, listeners, reply: (value = { view: "board" }) => response.resolve({ structuredContent: value }), fail: () => response.reject(new Error("fixture network failure")) };
}

test("自动刷新只调用任务读取，保留页签且不用全页loading", async () => {
  const f = fixture();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 30000);
  const operation = f.run("nativeRefreshTasks()");
  assert.equal(f.calls[0].method, "tools/call");
  assert.equal(f.calls[0].params.name, "jira_list_my_tasks");
  f.reply(); await operation;
  assert.equal(f.results.length, 1);
  assert.equal(f.context.activeTab, "active");
  assert.equal(f.context.busy, false);
  assert.equal(f.timers.size, 1);
});

test("无宿主能力、关闭策略、独立设置surface不安排自动请求", async () => {
  for (const options of [{ capable: false }, { enabled: false }, { surface: "settings" }]) {
    const f = fixture(options);
    assert.equal(f.timers.size, 0);
    await f.run("nativeRefreshTasks()");
    assert.equal(f.calls.length, 0);
  }
});

test("详情、SVN、设置、用户输入和其他请求期间暂停自动刷新", async () => {
  for (const edit of [
    (f) => { f.element("detail-view").hidden = false; },
    (f) => { f.element("svn-view").hidden = false; },
    (f) => { f.element("native-settings").hidden = false; },
    (f) => { f.context.busy = true; },
    (f) => { f.context.pending.set(1, {}); },
    (f) => { f.context.nativeActionResolver = () => {}; },
    (f) => { f.context.document.activeElement = { matches: () => true }; },
    (f) => { f.context.activeTab = "sheets"; }
  ]) {
    const f = fixture(); edit(f);
    await f.run("nativeRefreshTasks()");
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.size, 1);
  }
});

test("飞行中的旧任务回复不能把用户从详情、SVN、设置或其他页签拉回", async () => {
  for (const edit of [
    (f) => { f.element("detail-view").hidden = false; },
    (f) => { f.element("svn-view").hidden = false; },
    (f) => { f.element("native-settings").hidden = false; },
    (f) => { f.context.activeTab = "history"; },
    (f) => { f.run("nativeApplySyncPolicy({tasksEnabled:false})"); }
  ]) {
    const f = fixture();
    const operation = f.run("nativeRefreshTasks()"); edit(f); f.reply(); await operation;
    assert.equal(f.results.length, 0);
  }
});

test("自动刷新单飞、网络失败指数退避且保留旧结果", async () => {
  const f = fixture();
  const operation = f.run("nativeRefreshTasks()");
  await f.run("nativeRefreshTasks()");
  assert.equal(f.calls.length, 1);
  f.fail(); await operation;
  assert.equal(f.results.length, 0);
  assert.equal([...f.timers.values()][0].delay, 60000);
  const second = f.run("nativeRefreshTasks()"); f.fail(); await second;
  assert.equal([...f.timers.values()][0].delay, 120000);
  assert.match(f.element("native-sync-status").textContent, /保留当前列表/);
});

test("隐藏/退出面板清除调度，恢复可见仅在策略开启时读取", async () => {
  const f = fixture();
  f.context.document.visibilityState = "hidden"; f.listeners.visibilitychange();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  f.context.document.visibilityState = "visible"; f.listeners.visibilitychange();
  assert.equal(f.calls.length, 1);
  f.listeners.pagehide(); f.reply();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.results.length, 0);
  assert.equal(f.timers.size, 0);
  f.listeners.pageshow(); assert.equal(f.timers.size, 1);
});

test("返回刷新关闭时仅恢复定时器，非法间隔使用安全默认值", () => {
  const f = fixture();
  f.run("nativeApplySyncPolicy({taskIntervalSeconds:1,syncOnPanelReturn:false})");
  f.listeners.visibilitychange();
  assert.equal(f.calls.length, 0);
  assert.equal([...f.timers.values()][0].delay, 60000);
});

test("较新的手动读取和同页签ABA导航使旧自动回复失效", async () => {
  for (const scenario of ["manual", "navigation"]) {
    const f = fixture();
    const operation = f.run("nativeRefreshTasks()");
    if (scenario === "manual") f.results.push({ view: "board", fixture: "new-manual" });
    else { f.context.activeTab = "history"; f.context.activeTab = "active"; }
    f.run("nativeInvalidateTaskRefresh()");
    f.reply({ view: "board", fixture: "old-auto" }); await operation;
    assert.equal(f.results.some((item) => item.fixture === "old-auto"), false);
    assert.equal(f.results.length, scenario === "manual" ? 1 : 0);
  }
});
