/**
 * Compatibility boundary between Jira Workbench and DSH's Session API.
 *
 * DSH <= 0.1.1 exposed one `apiProxy` facade whose methods accepted
 * `{ rpcId, payload }` and returned an explicit result envelope. DSH 0.1.5
 * replaced that facade with Host-owned `sessionController` and
 * `sessionSkillCatalog` services. Jira Workbench keeps its existing internal
 * envelope at this boundary so the business flow does not depend on either
 * DSH generation.
 */

function success(request, value) {
  return { rpcId: request?.rpcId, result: { ok: true, value } };
}

function legacyErrorCode(value) {
  const code = String(value || "gateway/internal");
  const aliases = {
    "agent-preset/conflict": "agent-preset-conflict",
    "agent-preset/not-found": "agent-preset-not-found",
    "gateway/bad-request": "bad-request",
    "gateway/cancelled": "cancelled",
    "gateway/internal": "internal",
    "session/agent-busy": "agent-busy",
    "session/attachment-invalid": "attachment-error",
    "session/conflict": "session-conflict",
    "session/invalid-time-zone": "invalid-time-zone",
    "session/model-unavailable": "model-unavailable",
    "session/not-found": "session-not-found",
    "session/title-invalid": "title-invalid",
    "session/workspace-attach-failed": "workspace-attach-failed",
    "workspace/not-found": "workspace-not-found"
  };
  return aliases[code] || code.replaceAll("/", "-");
}

function failure(request, error) {
  return {
    rpcId: request?.rpcId,
    result: {
      ok: false,
      error: {
        code: legacyErrorCode(error?.code),
        message: String(error?.message || error || "DSH Host operation failed."),
        details: error?.details && typeof error.details === "object" ? error.details : {}
      }
    }
  };
}

async function enveloped(request, operation) {
  try {
    return success(request, await operation(request?.payload || {}));
  } catch (error) {
    return failure(request, error);
  }
}

function selection(value) {
  const provider = String(value?.provider || "").trim();
  const model = String(value?.model || "").trim();
  if (!provider || !model) return null;
  const reasoningEffort = String(value?.reasoningEffort || "").trim();
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function releaseObservation(observation) {
  if (!observation) return;
  if (typeof observation[Symbol.dispose] === "function") {
    observation[Symbol.dispose]();
    return;
  }
  if (typeof observation.dispose === "function") observation.dispose();
}

async function currentSelection(ctx, sessionId) {
  const query = ctx.get("sessionQuery");
  if (query && typeof query.observeSession === "function") {
    const observation = await query.observeSession(sessionId);
    try {
      const projected = observation?.projections?.values?.modelSelection;
      const selected = selection(projected?.next || projected?.pending || projected?.lastUsed);
      if (selected) return selected;
    } finally {
      releaseObservation(observation);
    }
  }

  const defaults = ctx.get("agentDefaultModel");
  const selected = selection(defaults?.currentSelection?.());
  if (selected) return selected;
  throw new Error(`DSH model selection is unavailable for session "${String(sessionId || "")}".`);
}

/**
 * Resolve the Session facade used by Jira Workbench.
 *
 * A supplied legacy `apiProxy` remains accepted by unit fixtures and older DSH
 * fixtures. Supported DSH 0.2.0-rc.2 uses only the official replacement services.
 */
export function resolveDshSessionGateway(ctx) {
  if (!ctx || typeof ctx.get !== "function") return null;
  const legacy = ctx.get("apiProxy");
  // Some consumers use only the model or Skill slice, and their unit fixtures
  // intentionally provide that narrow legacy surface.
  if (legacy && (legacy.sessions || legacy.skills)) return legacy;

  const controller = ctx.get("sessionController");
  if (!controller?.create || !controller?.prompt) return null;

  return {
    sessions: {
      create(request) {
        return enveloped(request, (payload) => controller.create(payload));
      },
      prompt(request) {
        return enveloped(request, (payload) => controller.prompt({
          ...payload,
          requestId: String(request?.rpcId || "")
        }, new AbortController().signal));
      },
      selectModel(request) {
        return enveloped(request, (payload) => controller.selectModel(payload));
      },
      rename(request) {
        return enveloped(request, (payload) => controller.rename(payload));
      },
      models(request) {
        return enveloped(request, async (payload) => {
          const [current, catalog] = await Promise.all([
            currentSelection(ctx, payload.sessionId),
            controller.modelCatalog()
          ]);
          return {
            current,
            routable: Array.isArray(catalog?.routableProviders)
              ? catalog.routableProviders.includes(current.provider)
              : true,
            groups: Array.isArray(catalog?.groups) ? catalog.groups : [],
            failures: Array.isArray(catalog?.failures) ? catalog.failures : []
          };
        });
      }
    },
    skills: {
      list(request) {
        return enveloped(request, (payload) => {
          const catalog = ctx.get("sessionSkillCatalog");
          if (!catalog || typeof catalog.list !== "function") {
            throw new Error("DSH Session Skill catalog is unavailable.");
          }
          return catalog.list(payload, new AbortController().signal);
        });
      }
    }
  };
}
