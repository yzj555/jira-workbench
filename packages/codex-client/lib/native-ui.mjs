import { readFile } from "node:fs/promises";

const surfaces = new Set(["global", "thread", "settings"]);

function replaceRequired(source, start, end, replacement) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Core UI integration marker is missing: ${start}`);
  return source.slice(0, from) + replacement + source.slice(to);
}

function replaceOnceRequired(source, original, replacement) {
  const offset = source.indexOf(original);
  if (offset < 0 || source.indexOf(original, offset + original.length) >= 0) {
    throw new Error(`Core UI integration fragment is missing or ambiguous: ${original.slice(0, 80)}`);
  }
  return source.slice(0, offset) + replacement + source.slice(offset + original.length);
}

// This layer owns sandbox presentation only. All attachment ownership checks,
// local executable launches and one-use SVN confirmation remain Core tools.
const nativeSandboxRuntime = String.raw`
    const nativeAttachmentCache = new Map();
    const nativeAttachmentRequests = new Map();
    let nativeAttachmentOriginalSize = false;
    let nativeSvnHydration = null;
    let nativeSvnNavigationRevision = 0;
    function nativeExternalUrl(value) {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
        || hostname === "localhost" || hostname.endsWith(".localhost")
        || /^127\./.test(hostname) || hostname === "[::1]" || hostname === "0.0.0.0") {
        throw new Error("该地址不适合由原生面板打开；请在 Jira 中查看附件。");
      }
      return url.href;
    }
    async function nativeOpenExternalLink(value) {
      const result = await openLink(nativeExternalUrl(value));
      if (result?.isError === true) throw new Error("宿主未能打开 Jira 页面，请重试。");
    }
    function nativeAttachmentHtml(items, task) {
      if (!items?.length) return '<div class="empty">无附件</div>';
      return items.map((item) => {
        const metadata = esc(item.mimeType) + " · " + fmtSize(item.size) + " · " + esc(item.author);
        if (item.previewable) return '<div class="attachment"><button type="button" data-preview-attachment="' + esc(item.id) + '"><strong>' + esc(item.filename) + '</strong><small>' + metadata + ' · 点击预览原图</small></button></div>';
        const source = item.sourceIssueKey === task.parentIssue?.key ? task.parentIssue : task;
        let link = "";
        try { link = nativeExternalUrl(source.url); } catch {}
        return '<div class="attachment native-document-attachment"><div><strong>' + esc(item.filename) + '</strong><small>' + metadata + '</small></div>'
          + (link ? '<button type="button" class="native-jira-link" data-native-open-url="' + esc(link) + '">在 Jira 中查看 ↗</button>' : '<small>请在 Jira 中查看</small>') + '</div>';
      }).join("");
    }
    function nativeValidateAttachment(result, issueKey, attachmentId) {
      const preview = result?.preview;
      if (result?.view !== "attachmentPreview" || preview?.issueKey !== issueKey
        || String(preview.attachmentId) !== attachmentId
        || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(String(preview.dataUrl || ""))) {
        throw new Error("附件预览结果与当前文件不一致，已拒绝显示。");
      }
      return result;
    }
    async function nativePreviewAttachment(value) {
      const attachmentId = String(value || "");
      const task = cache.issue?.issue;
      if (!task || ![...(task.attachments || []), ...(task.parentIssue?.attachments || [])]
        .some((item) => String(item.id) === attachmentId && item.previewable)) {
        throw new Error("请先选择属于当前任务的图片附件。");
      }
      const issueKey = task.key;
      const key = issueKey + ":" + attachmentId;
      let result = nativeAttachmentCache.get(key);
      if (!result) {
        let operation = nativeAttachmentRequests.get(key);
        if (!operation) {
          operation = (async () => {
            const output = await callTool(TOOLS.attachmentPreview, { issueKey, attachmentId }, { accept: false });
            if (!output) return null;
            nativeValidateAttachment(output, issueKey, attachmentId);
            nativeAttachmentCache.set(key, output);
            while (nativeAttachmentCache.size > 4) nativeAttachmentCache.delete(nativeAttachmentCache.keys().next().value);
            return output;
          })();
          nativeAttachmentRequests.set(key, operation);
        }
        try { result = await operation; }
        finally { if (nativeAttachmentRequests.get(key) === operation) nativeAttachmentRequests.delete(key); }
      }
      if (result && cache.issue?.issue?.key === issueKey) acceptCoreResult(result);
      return result;
    }
    function nativeCloseSvn() {
      nativeSvnNavigationRevision++;
      nativeResolveConfirmation(false);
      svnFileInteraction.cancel();
      stopSvnPolling();
      svnDedicatedMode = false;
      leaveSvnLayout();
      if (cache.issue?.issue?.key === cache.svnContext?.issueKey) {
        document.body.classList.add("detail-active");
        $("svn-view").hidden = true;
        $("detail-view").hidden = false;
        renderDetail();
      } else void selectTab(activeTab);
    }
    function nativeReviewProjectScope(result) {
      return String(result.review?.workingCopy?.projectScopeId || result.review?.workspaceContext?.projectScopeId || "");
    }
    function nativeContextProjectScope(context) {
      return String(context?.selectedProjectScopeId || context?.context?.workingCopy?.projectScopeId || "");
    }
    async function nativeHydrateSvnResult(result) {
      if (!result.issueKey || !hasTool(TOOLS.svnInspect)) {
        showError(new Error("无法读取此审核的项目上下文，请从任务详情重新打开 SVN 审核。"));
        return;
      }
      const navigationRevision = nativeSvnNavigationRevision;
      const operation = {};
      nativeSvnHydration = operation;
      const projectScopeId = nativeReviewProjectScope(result);
      const context = await callTool(TOOLS.svnInspect, { issueKey: result.issueKey, projectScopeId }, { accept: false });
      if (nativeSvnHydration !== operation || nativeSvnNavigationRevision !== navigationRevision) return;
      nativeSvnHydration = null;
      if (context?.view !== "svnContext" || context.issueKey !== result.issueKey || !context.context
        || (projectScopeId && nativeContextProjectScope(context) !== projectScopeId)) {
        if (context?.view === "svnContext" && !context.context) acceptCoreResult(context);
        showError(new Error("审核项目上下文尚未确认；请明确选择目录后重新读取审核。"));
        return;
      }
      acceptCoreResult(context);
      acceptCoreResult(result);
    }
    function acceptResult(result) {
      if (result?.view === "svnExternalDiff") {
        if (result.result?.ok === true) $("meta").textContent = "已交给 TortoiseSVN 进行只读比较。";
        else showError(new Error("工具未确认 TortoiseSVN 已打开；仍可使用内置差异预览。"));
        return;
      }
      if (["svnReview", "svnCommitConfirmation", "svnCommitResult"].includes(result?.view)
        && (cache.svnContext?.issueKey !== result.issueKey
          || (nativeReviewProjectScope(result) && nativeContextProjectScope(cache.svnContext) !== nativeReviewProjectScope(result)))) {
        void nativeHydrateSvnResult(result).catch(showError);
        return;
      }
      if (["issue", "board", "sheets", "svnContext"].includes(result?.view)) nativeSvnNavigationRevision++;
      if (result?.view === "attachmentPreview") {
        const issueKey = cache.issue?.issue?.key;
        if (!issueKey) return;
        try { nativeValidateAttachment(result, issueKey, String(result.preview?.attachmentId || "")); }
        catch (error) { showError(error); return; }
      }
      return acceptCoreResult(result);
    }
    async function nativeCommitSvn() {
      const review = cache.svnReview;
      const confirmation = cache.svnConfirmation;
      const issueKey = cache.svnContext?.issueKey;
      const revision = nativeSvnNavigationRevision;
      const reviewId = review?.id;
      const confirmationToken = confirmation?.confirmationToken;
      if (busy || !issueKey || !reviewId || !confirmationToken) return;
      const message = "这将真实提交 " + (review.selectedPaths?.length || 0) + " 个显式 SVN 路径。\n\n提交信息：\n" + (review.message || "") + "\n\n确认继续吗？";
      if (!await nativeConfirm(message)) return;
      if (busy || revision !== nativeSvnNavigationRevision || $("svn-view").hidden
        || cache.svnContext?.issueKey !== issueKey || cache.svnReview !== review
        || cache.svnConfirmation !== confirmation || cache.svnConfirmation?.confirmationToken !== confirmationToken) {
        showError(new Error("审核快照或页面已改变，请重新读取并确认；未执行提交。"));
        return;
      }
      const result = await callTool(TOOLS.svnCommit, { issueKey, reviewId, confirmationToken });
      if (!result) await callTool(TOOLS.svnGetReview, { issueKey, reviewId });
    }
`;

/** Reuse Core's business UI, with only the official MCP Apps transport enabled. */
export async function loadNativeUi({ version = "0.33.8", surface = "global" } = {}) {
  if (!surfaces.has(surface)) throw new TypeError(`Unknown native UI surface: ${surface}`);
  let coreHtml;
  try {
    coreHtml = await readFile(new URL("../ui/core-task-board.html", import.meta.url), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const coreResource = import.meta.resolve("@jira-workbench/core/mcp/ui/task-board.html");
    coreHtml = await readFile(new URL(coreResource), "utf8");
  }
  let html = coreHtml.replaceAll("\r\n", "\n");
  const [runtime, css, settings] = await Promise.all([
    readFile(new URL("../ui/native-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/native.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/settings.html", import.meta.url), "utf8")
  ]);
  // JSON serialization protects the script context even for externally supplied versions.
  html = html.replace('const APP_VERSION = "__JIRA_WORKBENCH_VERSION__";',
    `const APP_VERSION = ${JSON.stringify(String(version)).replaceAll("<", "\\u003c")};\n    const NATIVE_SURFACE = ${JSON.stringify(surface)};`);
  html = replaceRequired(html, "    // 设置入口是宿主相关地址。", "    const SESSION_HOST_NAME", '    const HOST_KIND = "codex";\n');
  html = replaceRequired(html, "    const LAUNCH_PARAMS =", "    const SHEET_COLUMNS", `    const DESKTOP_BRIDGE_TRANSPORT = false;
    const LOCAL_TRANSPORT = false;
    const EMBED_DETAIL_MODE = false;
    const WORKSPACE_EMBED_MODE = false;
    const CURRENT_HOST_SESSION_ID = "";
`);
  html = replaceOnceRequired(html, "    function acceptResult(result) {", "    function acceptCoreResult(result) {");
  html = replaceRequired(html, "    const RETRYABLE_LOCAL_TOOLS", "    function toolResultText", `${runtime}\n${nativeSandboxRuntime}\n`);
  html = replaceOnceRequired(html, "    async function selectTab(tab) {", "    async function selectTab(tab) {\n      nativeSvnNavigationRevision++;\n      nativeInvalidateTaskRefresh();");
  html = replaceOnceRequired(html, "    async function openIssue(key) {", "    async function openIssue(key) {\n      nativeSvnNavigationRevision++;\n      nativeInvalidateTaskRefresh();");
  html = replaceRequired(html, "      const attachmentHtml =", "      const attachments =", "      const attachmentHtml = (items) => nativeAttachmentHtml(items, task);\n");
  html = replaceOnceRequired(html, '<a href="${esc(parent.url)}" target="_blank" rel="noreferrer">${esc(parent.key)} ↗</a>', '<button type="button" class="native-jira-link" data-native-open-url="${esc(parent.url)}">${esc(parent.key)} ↗</button>');
  html = replaceOnceRequired(html, '<button type="button" id="close-attachment-lightbox"', '<button type="button" data-native-image-size aria-pressed="${nativeAttachmentOriginalSize}">${nativeAttachmentOriginalSize ? "适应窗口" : "原始尺寸"}</button><button type="button" id="close-attachment-lightbox"');
  html = replaceOnceRequired(html, '<div class="attachment-lightbox-stage">', '<div class="attachment-lightbox-stage ${nativeAttachmentOriginalSize ? "native-original-size" : ""}">');
  html = replaceRequired(html, '      if (attachment && cache.issue?.issue && !busy) {', '      if (event.target.closest("[data-open-attachment-lightbox]"', `      if (attachment && cache.issue?.issue && !busy) {
        void nativePreviewAttachment(attachment.dataset.previewAttachment).catch(showError);
        return;
      }
`);
  html = replaceRequired(html, '      if (event.target.closest("#back-from-svn")', '      if (event.target.closest("#refresh-svn-workbench")', `      if (event.target.closest("#back-from-svn") || event.target.closest("#close-svn-workbench")) {
        nativeCloseSvn();
        return;
      }
`);
  html = replaceRequired(html, '      if (event.target.closest("#commit-svn")', '      if (event.target.closest("#reconcile-svn")', `      if (event.target.closest("#commit-svn") && cache.svnReview && cache.svnConfirmation && !busy) {
        void nativeCommitSvn().catch(showError);
        return;
      }
`);
  html = replaceRequired(html, "    function saveState()", "    function statusTone", "    function saveState() {}\n");
  html = html.replace('if (!hasTool(name)) return null;', 'if (!hasTool(name)) { if (!options.silent) showError(new Error(`当前原生宿主未提供工具：${name}`)); return null; }');
  html = html.replace("if (notFound) return null;", "if (notFound) throw toolResultError(result);");
  html = replaceRequired(html, '      if (event.target.closest("#settings"))', '      if (event.target.closest("#local-close"))', `      if (event.target.closest("#settings")) void nativeOpenSettings().catch(showError);
`);
  html = replaceRequired(html, '    window.addEventListener("message", (event) => {\n      if (event.source !== window.parent) return;\n      const message = event.data;\n      if (event.origin', "    void initialize();", `    async function initialize() {
      document.documentElement.dataset.nativeSurface = NATIVE_SURFACE;
      $("version-status").textContent = "v" + APP_VERSION;
      $("settings").hidden = false;
      try {
        const initialized = await request("ui/initialize", {
          protocolVersion: "2025-11-21",
          appInfo: { name: "jira-workbench-codex", title: "Jira 工作台", version: APP_VERSION },
          appCapabilities: {}
        });
        nativeApplyHostContext(initialized?.hostContext);
        notify("ui/notifications/initialized", {});
        await loadCapabilities();
        if (NATIVE_SURFACE === "settings" || nativeStatus.configured === false) {
          await nativeOpenSettings();
        } else {
          await selectTab(activeTab);
        }
        nativeScheduleTaskRefresh();
        if (hasTool(TOOLS.automationStatus)) void callTool(TOOLS.automationStatus);
        else $("monitor").hidden = true;
      } catch (error) {
        showError(error);
        nativeSetNotice("原生连接尚未就绪，请重试。不会通过桌面注入或本地网页代替。");
      }
    }
`);
  // Core's unreachable DSH integration must not leak into the native resource.
  html = html.replace(/        if \(HOST_KIND === "dsh"\) \{\s*window\.parent\.postMessage\(\{[\s\S]*?\}\s*, window\.location\.origin\);\s*\} else \{\s*notifyDesktopHost\("close"\);\s*\}/g, '        nativeSetNotice("会话结果由官方服务返回；请在 Codex 会话列表中打开已关联会话。");');
  html = html.replace(/window\.parent\.postMessage\(\{\s*source: "jira-workbench-dsh",[\s\S]*?\}, window\.location\.origin\);/g, 'showError(new Error("原生宿主未提供此导航能力。"));');
  html = html.replaceAll("DSH 项目", "项目目录").replaceAll("DSH 会话", "Codex 会话").replaceAll("DSH 中", "当前宿主中").replaceAll("在 DSH 添加项目", "配置项目目录");
  html = replaceOnceRequired(html, 'document.addEventListener("click", (event) => {', `document.addEventListener("click", async (event) => {
      const externalLink = event.target.closest("[data-native-open-url]");
      if (externalLink) {
        event.preventDefault();
        void nativeOpenExternalLink(externalLink.dataset.nativeOpenUrl).catch(showError);
        return;
      }
      if (event.target.closest("[data-native-image-size]") && attachmentLightboxOpen) {
        nativeAttachmentOriginalSize = !nativeAttachmentOriginalSize;
        renderDetail({ patchSelectors: ["#attachment-preview-slot"] });
        return;
      }
`);
  html = html.replaceAll("window.confirm(", "await nativeConfirm(");
  html = html.replace("</style>", `${css}\n  </style>`);
  html = html.replace("  <script>", `  <div id="native-capability-notice" role="status" hidden></div>\n${settings}\n  <script>`);
  return html;
}
