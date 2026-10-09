    const NATIVE_TOOLS = Object.freeze({ status: "jira_codex_status", settings: "jira_codex_get_settings", saveSettings: "jira_codex_save_settings", settingsOptions: "jira_codex_list_settings_options" });
    let nativeStatus = null;
    let nativeSettingsSnapshot = null;
    let nativeSettingsDraft = null;
    let nativeSettingsBusy = false;
    let nativeActionResolver = null;
    let nativeOptionsBusy = false;
    let nativeSettingsOptions = null;
    let nativeAppliedSettingsRevision = null;
    const SVN_REVIEW_REFRESH_ON_FAILURE = new Set([TOOLS.svnConfirmReview, TOOLS.svnCommit]);

    function nativeSetNotice(text) {
      const notice = $("native-capability-notice");
      notice.textContent = String(text || "");
      notice.hidden = !text;
    }
    function nativeApplyHostContext(context) {
      if (!context || typeof context !== "object") return;
      if (["dark", "light"].includes(context.theme)) document.documentElement.dataset.theme = context.theme;
      for (const [key, value] of Object.entries(context.styles?.variables || {})) {
        if (key.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(key, value);
      }
    }
    function request(method, params = {}, { timeoutMs, nativeAutomatic = false } = {}) {
      if (method === "tools/call" && params.name === TOOLS.board && !nativeAutomatic) nativeInvalidateTaskRefresh();
      const id = requestId++;
      const budget = timeoutMs ?? (method === "tools/call" && params.name === NATIVE_TOOLS.settingsOptions ? 55_000
        : method === "tools/call" && /^(svn_|jira_codex_save_settings)/.test(params.name || "") ? 90_000 : 30_000);
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          const error = new Error("官方 MCP Apps 宿主响应超时。请重试；变更操作请先重新读取结果，避免重复提交。");
          error.code = "NATIVE_MCP_TIMEOUT";
          reject(error);
        }, budget);
        pending.set(id, {
          resolve(value) { window.clearTimeout(timer); resolve(value); },
          reject(error) { window.clearTimeout(timer); reject(error); }
        });
        try { window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); }
        catch (error) { pending.delete(id); window.clearTimeout(timer); reject(error); }
      });
    }
    function notify(method, params) { window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*"); }
    function notifyDesktopHost() { showError(new Error("当前原生宿主未提供此桌面操作，不会通过注入执行。")); }
    function openLink(url) { return request("ui/open-link", { url }); }
    function nativeConfirm(message) {
      if (nativeActionResolver) return Promise.resolve(false);
      $("native-action-description").textContent = String(message || "确认继续吗？");
      $("native-action-confirm").hidden = false;
      $("native-action-cancel").focus();
      return new Promise((resolve) => { nativeActionResolver = resolve; });
    }
    function nativeResolveConfirmation(confirmed) {
      if (!nativeActionResolver) return;
      const resolve = nativeActionResolver;
      nativeActionResolver = null;
      $("native-action-confirm").hidden = true;
      resolve(confirmed === true);
    }
    $("native-action-cancel").addEventListener("click", () => nativeResolveConfirmation(false));
    $("native-action-accept").addEventListener("click", () => nativeResolveConfirmation(true));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && nativeActionResolver) { event.preventDefault(); nativeResolveConfirmation(false); }
    });
    function nativeStructuredResult(result) {
      if (result?.isError) throw toolResultError(result);
      if (!result?.structuredContent || typeof result.structuredContent !== "object") throw new Error("工具没有返回结构化结果，操作未被确认成功。");
      return result.structuredContent;
    }
    async function loadCapabilities() {
      nativeStatus = nativeStructuredResult(await request("tools/call", { name: NATIVE_TOOLS.status, arguments: {} }));
      if (!Array.isArray(nativeStatus.availableTools)) throw new Error("宿主没有返回能力清单；无法安全判断可用操作。");
      availableTools = new Set(nativeStatus.availableTools.map(String));
      const notes = [];
      if (nativeStatus.message) notes.push(String(nativeStatus.message));
      if (!availableTools.has(TOOLS.createAnalysis)) notes.push("当前未提供项目内创建并绑定会话能力。");
      if (!availableTools.has(TOOLS.threads)) notes.push("当前未提供可关联的会话列表。");
      if (NATIVE_SURFACE === "thread") notes.push("官方视图未提供可验证的当前会话 ID；本面板不会猜测或自动关联当前会话。");
      nativeSetNotice(notes.join(" "));
      nativeApplySyncPolicy(nativeStatus.syncSettings);
    }
    function hasTool(name) { return availableTools instanceof Set && availableTools.has(name); }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          const error = new Error(String(message.error.message || "官方 MCP Apps 请求失败。"));
          error.code = message.error.code;
          error.data = message.error.data;
          entry.reject(error);
        } else entry.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/host-context-changed") nativeApplyHostContext(message.params);
      if (message.method === "ui/notifications/tool-result") {
        const output = message.params?.structuredContent;
        if (output?.view === "codexSettings") nativeAcceptSettings(output);
        else if (output?.view === "codexSettingsOptions") nativeAcceptSettingsOptions(output);
        else if (output && output.view !== "codexStatus") {
          // List rendering belongs to our confirmed reads. Passive host
          // notifications lack request order and could overwrite newer data.
          if (output.view === "board") return;
          acceptResult(output);
        }
      }
    }, { passive: true });

    function nativeFeedback(message, error = false) {
      $("native-settings-feedback").textContent = String(message || "");
      $("native-settings-feedback").style.color = error ? "var(--bug)" : "var(--muted)";
    }
    function nativeSetSettingsBusy(value) {
      nativeSettingsBusy = value;
      for (const id of ["native-settings-save", "native-settings-reload", "native-confirm-save"]) $(id).disabled = value;
      if (!value && !nativeSettingsSnapshot) $("native-settings-save").disabled = true;
    }
    function nativeAcceptSettings(snapshot) {
      if (!snapshot.config || typeof snapshot.config !== "object") throw new Error("设置工具未返回有效配置，未确认保存成功。");
      nativeSettingsSnapshot = snapshot;
      if (snapshot.revision !== nativeAppliedSettingsRevision) {
        nativeAppliedSettingsRevision = snapshot.revision;
        nativeInvalidateTaskRefresh();
        if (typeof cache !== "undefined") {
          cache.board = null; cache.sheets = null; cache.sheet = null;
          selectedSheet = null;
        }
      }
      nativeSettingsOptions = null;
      $("native-jira-projects").innerHTML = "";
      $("native-options-feedback").textContent = "点击读取 Jira 项目与 Filter；仅使用已保存连接。";
      const config = snapshot.config;
      $("native-base-url").value = config.baseUrl || "";
      $("native-token").value = "";
      $("native-credential-status").textContent = snapshot.credentialConfigured || config.hasToken ? "已有安全保存的 Token；留空不会清除。" : "尚未配置 Token。";
      $("native-project-key").value = config.boardSources?.projectKey || "";
      $("native-max-results").value = config.maxResults || 100;
      $("native-board-sources").innerHTML = `<div class="native-settings-columns">${["requirement", "bug"].map((kind) => {
        const source = config.boardSources?.[kind] || {};
        return `<div><h4>${kind === "bug" ? "Bug 面板" : "需求面板"}</h4><label>来源<select id="native-${kind}-mode">${[["builtin", "通用 JQL"], ["custom", "自定义 JQL"], ["filter", "Jira Filter"]].map(([value, label]) => `<option value="${value}" ${source.mode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label id="native-${kind}-jql-field" ${source.mode !== "custom" ? "hidden" : ""}>自定义 JQL<textarea id="native-${kind}-jql" rows="3">${esc(source.jql || "")}</textarea></label><div id="native-${kind}-filter-field" ${source.mode !== "filter" ? "hidden" : ""}><div id="native-${kind}-filter-choices"></div><label>已选 Filter ID（可手动补充，逗号分隔）<input id="native-${kind}-filters" value="${esc((source.filterIds || []).join(", "))}"></label></div></div>`;
      }).join("")}</div>`;
      $("native-prompt-templates").innerHTML = `<div class="native-settings-columns">${["requirement", "bug"].map((kind) => {
        const template = config.promptTemplates?.[kind] || {};
        return `<div><h4>${kind === "bug" ? "Bug 诊断" : "需求分析"}</h4><label class="native-check"><input id="native-${kind}-customized" type="checkbox" ${template.customized ? "checked" : ""}>使用自定义模板</label><label>模板内容<textarea id="native-${kind}-template" rows="8">${esc(template.content || "")}</textarea></label><small>Skill：${esc(template.skill?.name || "未绑定（现有设置会保留）")}</small></div>`;
      }).join("")}</div>`;
      $("native-sync-enabled").checked = config.syncSettings?.tasksEnabled !== false;
      $("native-sync-interval").value = config.syncSettings?.taskIntervalSeconds || 60;
      $("native-return-sync").checked = config.syncSettings?.syncOnPanelReturn !== false;
      nativeApplySyncPolicy(config.syncSettings);
    }
    async function nativeOpenSettings() {
      if (nativeSettingsDraft) delete nativeSettingsDraft.token;
      nativeSettingsDraft = null;
      $("native-settings-confirm").hidden = true;
      $("native-settings").hidden = false;
      nativeSettingsSnapshot = null;
      nativeSetSettingsBusy(true);
      nativeFeedback("正在读取已保存配置…");
      try {
        const snapshot = nativeStructuredResult(await request("tools/call", { name: NATIVE_TOOLS.settings, arguments: {} }));
        nativeAcceptSettings(snapshot);
        nativeFeedback("已读取安全配置。保存后由服务端校验并回写。");
      } catch (error) { nativeFeedback(error.message, true); throw error; }
      finally { nativeSetSettingsBusy(false); }
    }
    function nativeCollectSettings() {
      const prior = nativeSettingsSnapshot?.config || {};
      const config = {
        baseUrl: $("native-base-url").value.trim(),
        maxResults: Number($("native-max-results").value),
        boardSources: { ...prior.boardSources, projectKey: $("native-project-key").value.trim() },
        promptTemplates: {},
        syncSettings: { ...prior.syncSettings,
          tasksEnabled: $("native-sync-enabled").checked,
          taskIntervalSeconds: Number($("native-sync-interval").value),
          syncOnPanelReturn: $("native-return-sync").checked
        }
      };
      const token = $("native-token").value.trim();
      if (token) config.token = token;
      for (const kind of ["requirement", "bug"]) {
        const mode = $("native-" + kind + "-mode").value;
        config.boardSources[kind] = {
          mode,
          jql: mode === "custom" ? $("native-" + kind + "-jql").value.trim() : "",
          filterIds: mode === "filter" ? $("native-" + kind + "-filters").value.split(/[,，\s]+/).filter(Boolean) : []
        };
        config.promptTemplates[kind] = { ...prior.promptTemplates?.[kind], customized: $("native-" + kind + "-customized").checked, content: $("native-" + kind + "-template").value };
      }
      return config;
    }
    function nativeUpdateSourceFields(kind) {
      const mode = $("native-" + kind + "-mode").value;
      $("native-" + kind + "-jql-field").hidden = mode !== "custom";
      $("native-" + kind + "-filter-field").hidden = mode !== "filter";
    }
    function nativeRenderFilterChoices(kind) {
      const selected = new Set($("native-" + kind + "-filters").value.split(/[,，\s]+/).filter(Boolean));
      const filters = nativeSettingsOptions?.filters || [];
      $("native-" + kind + "-filter-choices").innerHTML = filters.length
        ? `<div role="group" aria-label="${kind === "bug" ? "Bug" : "需求"} Filter" style="max-height:220px;overflow:auto">${filters.map((item) => `<label class="native-check"><input type="checkbox" data-native-filter-kind="${kind}" data-native-filter-id="${esc(item.id)}" ${selected.has(item.id) ? "checked" : ""}><span>${esc(item.name || "Filter " + item.id)}<small style="display:block">#${esc(item.id)}${item.owner ? " · " + esc(item.owner) : ""}</small></span></label>`).join("")}</div>`
        : "<small>没有已读取的 Filter；可以点击上方读取，或手动填写 ID。</small>";
    }
    function nativeAcceptSettingsOptions(options) {
      if (!nativeSettingsSnapshot || options.revision !== nativeSettingsSnapshot.revision) return;
      nativeSettingsOptions = options;
      $("native-jira-projects").innerHTML = (options.projects || []).map((item) => `<option value="${esc(item.key)}">${esc(item.name)}</option>`).join("");
      for (const kind of ["requirement", "bug"]) nativeRenderFilterChoices(kind);
      $("native-options-feedback").textContent = `已读取 ${(options.projects || []).length} 个 Jira 项目、${(options.filters || []).length} 个可访问的 Filter。${(options.warnings || []).join(" ")} 已选 ID 不会因列表缺失而移除。`;
    }
    async function nativeLoadSettingsOptions() {
      if (nativeOptionsBusy || nativeSettingsBusy || !nativeSettingsSnapshot) return;
      nativeOptionsBusy = true;
      $("native-options-reload").disabled = true;
      $("native-options-feedback").textContent = "正在读取已保存连接的 Jira 项目与 Filter…";
      try {
        const options = nativeStructuredResult(await request("tools/call", {
          name: NATIVE_TOOLS.settingsOptions,
          arguments: { expectedRevision: nativeSettingsSnapshot.revision, projectKey: $("native-project-key").value.trim().toUpperCase() }
        }));
        nativeAcceptSettingsOptions(options);
      } catch (error) { $("native-options-feedback").textContent = error.message; }
      finally { nativeOptionsBusy = false; $("native-options-reload").disabled = false; }
    }
    $("native-options-reload").addEventListener("click", () => void nativeLoadSettingsOptions());
    $("native-board-sources").addEventListener("change", (event) => {
      const kind = event.target.dataset?.nativeFilterKind;
      if (["requirement", "bug"].includes(kind)) {
        const field = $("native-" + kind + "-filters");
        const ids = new Set(field.value.split(/[,，\s]+/).filter(Boolean));
        if (event.target.checked) ids.add(event.target.dataset.nativeFilterId);
        else ids.delete(event.target.dataset.nativeFilterId);
        field.value = [...ids].join(", ");
      }
      for (const sourceKind of ["requirement", "bug"]) {
        if (event.target.id === "native-" + sourceKind + "-mode") nativeUpdateSourceFields(sourceKind);
        if (event.target.id === "native-" + sourceKind + "-filters") nativeRenderFilterChoices(sourceKind);
      }
    });
    async function nativeSaveSettings() {
      if (nativeSettingsBusy || !nativeSettingsDraft) return;
      nativeSetSettingsBusy(true);
      nativeFeedback("正在安全保存配置…");
      const config = nativeSettingsDraft;
      nativeSettingsDraft = null;
      try {
        const snapshot = nativeStructuredResult(await request("tools/call", {
          name: NATIVE_TOOLS.saveSettings,
          arguments: { config, expectedRevision: nativeSettingsSnapshot?.revision, acknowledged: true }
        }));
        nativeAcceptSettings(snapshot);
        try {
          await loadCapabilities();
          nativeFeedback("保存成功，界面已回写服务端的实际配置。返回工作台后可读取任务。");
        } catch {
          nativeFeedback("设置已保存并回写；能力状态刷新失败，请重新读取设置后返回工作台。", true);
        }
      } catch (error) { nativeFeedback(error.message, true); }
      finally {
        delete config.token;
        $("native-token").value = "";
        $("native-settings-confirm").hidden = true;
        nativeSetSettingsBusy(false);
      }
    }
    function nativeNavigateSettings(event, link) {
      event.preventDefault();
      const target = document.getElementById(String(link.getAttribute("href") || "").replace(/^#/, ""));
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      for (const anchor of document.querySelectorAll(".native-settings-layout > nav a")) anchor.removeAttribute("aria-current");
      link.setAttribute("aria-current", "location");
    }
    for (const link of document.querySelectorAll(".native-settings-layout > nav a")) link.addEventListener("click", (event) => nativeNavigateSettings(event, link));
    $("native-settings-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (nativeSettingsBusy || !nativeSettingsSnapshot) return;
      nativeSettingsDraft = nativeCollectSettings();
      $("native-settings-confirm").hidden = false;
      $("native-confirm-save").focus();
    });
    $("native-confirm-save").addEventListener("click", () => void nativeSaveSettings());
    $("native-confirm-cancel").addEventListener("click", () => {
      if (nativeSettingsDraft) delete nativeSettingsDraft.token;
      nativeSettingsDraft = null;
      $("native-settings-confirm").hidden = true;
    });
    $("native-settings-reload").addEventListener("click", () => void nativeOpenSettings().catch(showError));
    $("native-settings-close").addEventListener("click", () => {
      if (nativeSettingsBusy) return;
      if (nativeSettingsDraft) delete nativeSettingsDraft.token;
      nativeSettingsDraft = null;
      $("native-settings-confirm").hidden = true;
      $("native-token").value = "";
      $("native-settings").hidden = true;
      if (nativeStatus?.configured !== false) {
        void selectTab(activeTab).then(() => nativeSyncPolicy.syncOnPanelReturn ? nativeRefreshTasks() : nativeScheduleTaskRefresh());
      }
      else nativeSetNotice("请先配置 Jira 连接。尚未发送 Jira 网络请求。");
    });

    /* NATIVE_TASK_SYNC_START */
    let nativeSyncPolicy = { tasksEnabled: false, taskIntervalSeconds: 60, syncOnPanelReturn: true };
    let nativeTaskRefreshTimer = null;
    let nativeTaskRefreshInFlight = false;
    let nativeTaskRefreshFailures = 0;
    let nativeSyncGeneration = 0;
    let nativeSyncDisposed = false;
    function nativeInvalidateTaskRefresh() { nativeSyncGeneration++; }
    function nativeApplySyncPolicy(policy = {}) {
      nativeSyncGeneration++;
      nativeSyncPolicy = {
        tasksEnabled: policy?.tasksEnabled !== false,
        taskIntervalSeconds: [30, 60, 300, 600].includes(Number(policy?.taskIntervalSeconds)) ? Number(policy.taskIntervalSeconds) : 60,
        syncOnPanelReturn: policy?.syncOnPanelReturn !== false
      };
      $("native-sync-status").textContent = nativeSyncPolicy.tasksEnabled
        ? `任务列表每 ${nativeSyncPolicy.taskIntervalSeconds} 秒刷新；操作期间暂停。`
        : "自动刷新已关闭；可使用顶部刷新。";
      nativeScheduleTaskRefresh();
    }
    function nativeTaskRefreshAllowed() {
      if (nativeSyncDisposed || nativeStatus?.configured !== true || nativeStatus?.capabilities?.taskAutoRefresh !== true
        || !nativeSyncPolicy.tasksEnabled || document.visibilityState === "hidden"
        || NATIVE_SURFACE === "settings" || busy || nativeSettingsBusy || nativeActionResolver
        || pending.size || !$("native-settings").hidden || !$("detail-view").hidden || !$("svn-view").hidden
        || $("board-view").hidden || !["active", "history"].includes(activeTab)) return false;
      // Never replace a list underneath text entry (including board filters).
      return !document.activeElement?.matches?.("input,select,textarea,[contenteditable=true]");
    }
    function nativeScheduleTaskRefresh() {
      if (nativeTaskRefreshTimer !== null) window.clearTimeout(nativeTaskRefreshTimer);
      nativeTaskRefreshTimer = null;
      if (nativeSyncDisposed || nativeTaskRefreshInFlight || nativeStatus?.configured !== true
        || nativeStatus?.capabilities?.taskAutoRefresh !== true || !nativeSyncPolicy.tasksEnabled
        || document.visibilityState === "hidden" || NATIVE_SURFACE === "settings") return;
      const delay = Math.max(nativeSyncPolicy.taskIntervalSeconds * 1000,
        Math.min(300000, nativeTaskRefreshFailures ? 60000 * 2 ** (nativeTaskRefreshFailures - 1) : 0));
      nativeTaskRefreshTimer = window.setTimeout(() => { nativeTaskRefreshTimer = null; void nativeRefreshTasks(); }, delay);
    }
    async function nativeRefreshTasks() {
      if (nativeTaskRefreshInFlight) return;
      if (!nativeTaskRefreshAllowed() || !hasTool(TOOLS.board)) { nativeScheduleTaskRefresh(); return; }
      const generation = nativeSyncGeneration, tab = activeTab;
      nativeTaskRefreshInFlight = true;
      try {
        const output = nativeStructuredResult(await request("tools/call", {
          name: TOOLS.board, arguments: { includeCompleted: true, limitPerType: 100 }
        }, { nativeAutomatic: true }));
        if (output.view !== "board") throw new Error("自动刷新未返回任务列表。");
        // A reply may arrive after the user opens detail/SVN/settings or changes
        // tab/configuration. Discard it instead of navigating them backwards.
        if (generation === nativeSyncGeneration && tab === activeTab && nativeTaskRefreshAllowed()) {
          acceptResult(output);
          nativeTaskRefreshFailures = 0;
          $("native-sync-status").textContent = "任务已自动刷新。";
        }
      } catch {
        nativeTaskRefreshFailures = Math.min(4, nativeTaskRefreshFailures + 1);
        $("native-sync-status").textContent = "自动刷新暂未成功；保留当前列表，稍后重试或手动刷新。";
      } finally { nativeTaskRefreshInFlight = false; nativeScheduleTaskRefresh(); }
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { nativeScheduleTaskRefresh(); return; }
      if (nativeSyncPolicy.syncOnPanelReturn) void nativeRefreshTasks();
      else nativeScheduleTaskRefresh();
    });
    window.addEventListener("pagehide", () => {
      nativeSyncDisposed = true;
      nativeSyncGeneration++;
      if (nativeTaskRefreshTimer !== null) window.clearTimeout(nativeTaskRefreshTimer);
      nativeTaskRefreshTimer = null;
    });
    window.addEventListener("pageshow", () => { nativeSyncDisposed = false; nativeScheduleTaskRefresh(); });
    /* NATIVE_TASK_SYNC_END */
