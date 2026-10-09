import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeUi } from "../lib/native-ui.mjs";

// Isolated mock-host rendering QA only. This does not install, launch, or validate Codex.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = join(root, "artifacts", "codex-native-preview");
const candidates = [
  process.env.JIRA_UI_QA_EDGE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);
let edge;
for (const candidate of candidates) {
  try { await access(candidate); edge = candidate; break; } catch {}
}
if (!edge) throw new Error("Edge is unavailable; visual QA was not performed.");

const settings = {
  view: "codexSettings", revision: "mock-r1", credentialConfigured: false,
  config: {
    configured: false, hasToken: false, baseUrl: "https://jira.example.com", maxResults: 100,
    boardSources: { projectKey: "PROJECT", requirement: { mode: "builtin", jql: "", filterIds: [] }, bug: { mode: "filter", jql: "", filterIds: ["10001"] } },
    promptTemplates: {
      requirement: { customized: false, content: "请基于 Jira 信息、附件和项目证据分析当前需求，明确区分事实、推断和建议。", skill: null },
      bug: { customized: true, content: "分析实际行为与预期行为、复现条件、证据与潜在影响。证据不足时明确指出信息缺口。", skill: null }
    },
    syncSettings: { tasksEnabled: true, taskIntervalSeconds: 60, syncOnPanelReturn: true }
  }
};

const task = {
  key: "QA-101", title: "[模拟] 需求上下文与工作目录", typeName: "需求", priority: "高", assignee: "模拟用户",
  statusName: "处理中", status: "inProgress", projectName: "模拟项目", fixVersions: ["Native Preview"],
  updated: "2026-10-08T00:00:00Z", summary: "这是固定假数据，用于检查原生工作台布局。\n没有访问 Jira、模型服务或实际项目。\n当前宿主未提供可验证的会话关联接口。",
  collaborators: [{ displayName: "模拟协作者" }], attachments: [], attachmentCount: 0
};
const mockTools = ["jira_codex_status", "jira_codex_get_settings", "jira_codex_save_settings", "jira_list_my_tasks", "jira_get_issue", "jira_get_issue_workspaces"];
const scenarios = [
  { name: "settings-wide", width: 1440, height: 980, surface: "settings", mode: "settings" },
  { name: "settings-narrow", width: 420, height: 860, surface: "settings", mode: "settings" },
  { name: "workbench-wide", width: 1440, height: 980, surface: "global", mode: "board" },
  { name: "task-detail-wide", width: 1440, height: 980, surface: "global", mode: "detail" },
  { name: "thread-narrow", width: 480, height: 900, surface: "thread", mode: "board", theme: "dark" }
];
const safeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
const settingsProbe = `<script>
  let qaAnchorNavigation,qaAnchorChecking=false;
  const qaProbe = () => {
    const frame = document.getElementById('native-settings');
    if (!frame || frame.hidden || !document.getElementById('native-base-url')?.value) return;
    const form = document.getElementById('native-settings-form');
    if(qaAnchorNavigation===undefined){
      if(qaAnchorChecking)return;
      qaAnchorChecking=true;
      form.style.scrollBehavior='auto';
      frame.querySelector('nav a:last-child').click();
      setTimeout(()=>{qaAnchorNavigation=form.scrollTop>0;form.scrollTop=0;qaProbe();},50);
      return;
    }
    const overflow = [...frame.querySelectorAll('input,select,textarea')].filter(el => {
      const rect = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
      return rect.width > parent.width + 2 || rect.left < parent.left - 2 || rect.right > innerWidth + 2;
    }).map(el => el.id);
    const anchors = [...frame.querySelectorAll('nav a')].map(el => ({href:el.getAttribute('href'),valid:Boolean(document.querySelector(el.getAttribute('href')))}));
    const footer=frame.querySelector('footer').getBoundingClientRect();
    window.parent.postMessage({source:'jira-native-qa',report:{viewport:{width:innerWidth,height:innerHeight},settingsVisible:!frame.hidden,inputOverflow:overflow,formCanScroll:form.scrollHeight>form.clientHeight,anchorNavigationWorked:qaAnchorNavigation,footerInViewport:footer.top>=0&&footer.bottom<=innerHeight+2,bodyHorizontalOverflow:document.documentElement.scrollWidth>innerWidth+2,anchors,theme:document.documentElement.dataset.theme,feedback:document.getElementById('native-settings-feedback').textContent,error:document.getElementById('error').textContent}},'*');
  };
  window.addEventListener('error', event => window.parent.postMessage({source:'jira-native-qa',error:String(event.message)},'*'));
  setInterval(qaProbe,250);
<\/script>`;
async function buildPage(scenario) {
  const baseHtml = await loadNativeUi({ version: "mock-preview", surface: scenario.surface });
  const probe = scenario.mode === "settings" ? settingsProbe : `<script>
    let qaDetailClicked=false;
    const qaProbe=()=>{
      const firstTask=document.querySelector('#requirements article[data-key="QA-101"]');
      if(!firstTask)return;
      if(${scenario.mode === "detail"}&&!qaDetailClicked){qaDetailClicked=true;firstTask.click();return;}
      const detail=document.getElementById('detail-view');
      if(${scenario.mode === "detail"}&&(detail.hidden||!detail.textContent.includes('需求上下文')))return;
      const notice=document.getElementById('native-capability-notice'),rect=notice.getBoundingClientRect();
      window.parent.postMessage({source:'jira-native-qa',report:{viewport:{width:innerWidth,height:innerHeight},view:${safeJson(scenario.mode)},taskRendered:true,taskDetailRendered:!detail.hidden,version:document.getElementById('version-status').textContent,noticeVisible:!notice.hidden&&rect.top>=0&&rect.bottom<=innerHeight+2,notice:notice.textContent,bodyHorizontalOverflow:document.documentElement.scrollWidth>innerWidth+2,theme:document.documentElement.dataset.theme,error:document.getElementById('error').textContent}},'*');
    };
    window.addEventListener('error',event=>window.parent.postMessage({source:'jira-native-qa',error:String(event.message)},'*'));
    setInterval(qaProbe,250);
  <\/script>`;
  const html = baseHtml.replace("</body>", `${probe}</body>`);
  const configured = scenario.mode !== "settings";
  return `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style><iframe id="app" sandbox="allow-scripts allow-forms"></iframe><script>
  const app=document.getElementById('app'),settings=${safeJson(settings)},task=${safeJson(task)},toolCalls=[];
  settings.config.configured=${configured};
  window.addEventListener('message',event=>{
    if(event.source!==app.contentWindow)return;
    const message=event.data;
    if(message?.source==='jira-native-qa'){if(message.report)message.report.toolCalls=toolCalls;document.body.dataset.qa=JSON.stringify(message);return;}
    if(message?.jsonrpc!=='2.0'||message.id===undefined)return;
    let result,error;
    if(message.method==='tools/call')toolCalls.push(message.params.name);
    if(message.method==='ui/initialize')result={protocolVersion:'2025-11-21',hostInfo:{name:'isolated-mock-host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:${safeJson(scenario.theme || "light")}}};
    else if(message.method==='tools/call'&&message.params.name==='jira_codex_status')result={structuredContent:{view:'codexStatus',configured:${configured},availableTools:${safeJson(mockTools)},message:'模拟宿主：以下任务为固定假数据，不代表实际 Codex 验收。'}};
    else if(message.method==='tools/call'&&message.params.name==='jira_codex_get_settings')result={structuredContent:settings};
    else if(message.method==='tools/call'&&message.params.name==='jira_list_my_tasks')result={structuredContent:{view:'board',fetchedAt:'2026-10-08T00:00:00Z',active:{requirements:[task],bugs:[{...task,key:'QA-102',title:'[模拟] 附件预览与状态提示',typeName:'Bug',priority:'中',statusName:'待修复'}]},completed:{requirements:[],bugs:[]}}};
    else if(message.method==='tools/call'&&message.params.name==='jira_get_issue')result={structuredContent:{view:'issue',issueKey:'QA-101',issue:task,bindingsRevision:1}};
    else if(message.method==='tools/call'&&message.params.name==='jira_get_issue_workspaces')result={structuredContent:{view:'workspaceBindings',issueKey:'QA-101',binding:null}};
    else if(message.method==='tools/call'&&message.params.name==='jira_list_available_workspaces')result={structuredContent:{view:'availableWorkspaces',workspaces:[]}};
    else error={code:-32601,message:'Mock QA does not execute real tools'};
    app.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,...error?{error}:{result}},'*');
  });
  app.srcdoc=${safeJson(html)};
</script></html>`;
}
const pages = new Map(await Promise.all(scenarios.map(async (scenario) => [`/${scenario.name}`, await buildPage(scenario)])));
await mkdir(output, { recursive: true });
const server = createServer((req, res) => {
  const page = pages.get(req.url);
  if (!page) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
try {
  for (const scenario of scenarios) {
    const { name, width, height } = scenario;
    const profile = await mkdtemp(join(tmpdir(), "jira-native-ui-qa-"));
    const screenshot = join(output, `${name}.png`);
    // Bare --headless is compatible with the locally available older Edge headless shell.
    const args = ["--headless", "--disable-gpu", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--hide-scrollbars", `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "--virtual-time-budget=4000", `--screenshot=${screenshot}`, "--dump-dom", url + name];
    let stdout, browserExited = false;
    try { stdout = await new Promise((resolve, reject) => {
      const child = spawn(edge, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let data = "", errors = "";
      child.stdout.on("data", (chunk) => { data += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      let timeoutError, terminationTimer;
      const timer = setTimeout(() => {
        timeoutError = new Error(`Headless QA timed out: ${name}; ${errors.slice(-800)}`);
        child.kill();
        terminationTimer = setTimeout(() => reject(timeoutError), 2_000);
      }, 35_000);
      child.once("error", (error) => { browserExited = !child.pid; clearTimeout(timer); clearTimeout(terminationTimer); reject(error); });
      child.once("exit", (code) => {
        browserExited = true;
        clearTimeout(timer); clearTimeout(terminationTimer);
        if (timeoutError) reject(timeoutError);
        else code === 0 ? resolve(data) : reject(new Error(`Headless QA failed (${code}): ${errors.slice(-800)}`));
      });
    }); } finally {
      // Only delete this run's exact temp profile, after its owned browser has exited.
      const absoluteProfile = resolve(profile);
      if (dirname(absoluteProfile) !== resolve(tmpdir()) || !basename(absoluteProfile).startsWith("jira-native-ui-qa-")) throw new Error("Refusing an unexpected QA profile cleanup target");
      if (!browserExited) console.warn(`Temporary QA profile retained because browser exit was not confirmed: ${absoluteProfile}`);
      else {
        try { await rm(absoluteProfile, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
        catch (error) { console.warn(`Temporary QA profile retained (${error.code}): ${absoluteProfile}`); }
      }
    }
    await access(screenshot);
    const reportMatch = stdout.match(/data-qa="([^"]+)"/);
    if (!reportMatch) throw new Error(`The sandbox mock did not render: ${name}`);
    const report = JSON.parse(reportMatch[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
    const failed = report.error || report.report?.error || report.report?.bodyHorizontalOverflow
      || (scenario.mode === "settings" ? report.report?.inputOverflow?.length || !report.report?.anchorNavigationWorked || !report.report?.footerInViewport
        : !report.report?.taskRendered || !report.report?.noticeVisible || report.report?.version !== "vmock-preview" || !report.report?.notice?.includes("未提供项目内创建并绑定会话能力")
          || (scenario.surface === "thread" && !report.report?.notice?.includes("未提供可验证的当前会话 ID"))
          || (scenario.mode === "detail" && !report.report?.taskDetailRendered));
    if (failed) throw new Error(`Visual QA layout error: ${JSON.stringify(report)}`);
    console.log(JSON.stringify({ screenshot, ...report }));
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
