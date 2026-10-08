/** Keep Jira's existing config store aligned with either DSH settings generation. */

import { stat } from "node:fs/promises";

async function configurationExists(configStore) {
  // ConfigStore exposes this exact absolute filename. Check presence without
  // parsing private persisted data or resolving its credential references.
  if (!configStore.configFile) throw new TypeError("configStore.configFile is required.");
  try {
    await stat(configStore.configFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function baseUrlValue(config) {
  const value = typeof config?.baseUrl?.get === "function"
    ? config.baseUrl.get()
    : config?.baseUrl;
  return String(value || "").trim();
}

function report(ctx, error) {
  // Do not stringify the settings/config object: it may contain credentials.
  const message = `jira-workbench: Jira 连接配置同步失败：${String(error?.message || error)}`;
  if (typeof ctx?.logger?.error === "function") ctx.logger.error(message);
  else console.error(message);
}

/**
 * Install the settings bridge without delaying a Cordis fiber's activation.
 * Native SettingsForms describes ACTIVE entries, so initial migration waits
 * for the loader outside apply() rather than awaiting it in the startup path.
 */
export function installDshSettingsCompatibility({
  ctx,
  ownerContext = ctx,
  config,
  configStore,
  namespace,
  tokenReference,
  legacySchema,
  hasStoredConfiguration = () => configurationExists(configStore)
}) {
  const settings = ctx.get?.("settings") || ctx.settings;
  let closed = false;
  let pending = Promise.resolve();
  const disposers = [];
  const serialize = (operation) => {
    const task = pending.then(() => closed ? undefined : operation());
    pending = task.catch((error) => { if (!closed) report(ctx, error); });
    return pending;
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const cleanup of disposers.reverse()) cleanup?.();
  };

  if (typeof settings?.register === "function") {
    const scope = settings.register(namespace, legacySchema);
    ctx.emit("settings/document-updated", namespace, 0);
    disposers.push(scope.watch((next, previous) => {
      if (next.baseUrl === previous.baseUrl) return;
      void serialize(() => configStore.updateCredentialReference({
        baseUrl: next.baseUrl,
        tokenReference
      }));
    }));
    const ready = serialize(async () => {
      const stored = await configStore.getPublic();
      if (!closed && !scope.get().baseUrl && stored.baseUrl) {
        await scope.update({ baseUrl: stored.baseUrl });
      }
    });
    return { mode: "namespace", ready, dispose };
  }

  if (typeof settings?.configure !== "function" || typeof settings?.update !== "function") {
    throw new Error("jira-workbench: 当前 DSH 设置服务不支持插件配置。请升级 Jira Workbench。");
  }
  const entryId = String(ownerContext?.fiber?.entry?.options?.id || namespace);
  disposers.push(settings.configure({ auto: false }, ownerContext.fiber));
  let initialized = false;
  let activated = false;
  let observedBaseUrl = "";
  const synchronize = async () => {
    const selectedBaseUrl = baseUrlValue(config);
    if (initialized && selectedBaseUrl === observedBaseUrl) return;
    const recordExists = initialized ? true : await hasStoredConfiguration();
    const stored = await configStore.getPublic();
    if (closed) return;
    if (!initialized && (recordExists || stored.baseUrl || stored.hasToken)) {
      // Core is the durable authority. A previous successful panel save may
      // have failed its best-effort profile mirror; restarting must never
      // overwrite that saved value, including an explicitly cleared URL.
      // Mark the existing native value as observed before attempting the
      // mirror so a mirror failure cannot replay it into Core on reload.
      observedBaseUrl = selectedBaseUrl;
      initialized = true;
      const savedBaseUrl = String(stored.baseUrl || "").trim();
      if (selectedBaseUrl !== savedBaseUrl) {
        await settings.update(entryId, { baseUrl: savedBaseUrl });
        if (!closed) observedBaseUrl = baseUrlValue(config);
      }
      return;
    }
    if (selectedBaseUrl !== String(stored.baseUrl || "").trim()) {
      await configStore.updateCredentialReference({ baseUrl: selectedBaseUrl, tokenReference });
    }
    observedBaseUrl = selectedBaseUrl;
    initialized = true;
  };

  const ready = Promise.resolve(ownerContext?.root?.loader?.await?.())
    .then(() => {
      activated = true;
      return serialize(synchronize);
    })
    .catch((error) => { if (!closed) report(ctx, error); });
  if (typeof ctx.on === "function") {
    disposers.push(ctx.on("app-boot/config-reload", () => activated ? serialize(synchronize) : undefined));
  }
  return { mode: "forms", ready, dispose };
}
