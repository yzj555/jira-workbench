import assert from "node:assert/strict";
import test from "node:test";
import { resolveDshSessionGateway } from "../lib/dsh-session-gateway.mjs";

function request(id, payload) {
  return { rpcId: id, payload };
}

test("DSH 0.1.5 Session services retain the Jira Workbench result boundary", async () => {
  const calls = { create: [], prompt: [], selectModel: [], rename: [], skills: [] };
  let released = 0;
  const sessionController = {
    async create(payload) {
      calls.create.push(payload);
      return { sessionId: "session-new" };
    },
    async prompt(payload, signal) {
      calls.prompt.push({ payload, signal });
      return { accepted: true };
    },
    async selectModel(payload) {
      calls.selectModel.push(payload);
      return { selected: { provider: payload.provider, model: payload.model } };
    },
    async rename(payload) {
      calls.rename.push(payload);
      return { title: payload.title, seq: 7 };
    },
    async modelCatalog() {
      return {
        routableProviders: ["vision"],
        groups: [{ id: "vision", name: "Vision", models: [] }],
        failures: []
      };
    }
  };
  const sessionSkillCatalog = {
    async list(payload, signal) {
      calls.skills.push({ payload, signal });
      return { skills: [{ name: "jira-first-turn-analysis" }] };
    }
  };
  const ctx = {
    get(name) {
      if (name === "sessionController") return sessionController;
      if (name === "sessionSkillCatalog") return sessionSkillCatalog;
      if (name === "sessionQuery") {
        return {
          async observeSession() {
            return {
              projections: {
                values: {
                  modelSelection: {
                    lastUsed: { provider: "main", model: "chat" },
                    next: { provider: "vision", model: "image" }
                  }
                }
              },
              [Symbol.dispose]() { released += 1; }
            };
          }
        };
      }
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider: "fallback", model: "chat" }) };
      }
      return undefined;
    }
  };

  const gateway = resolveDshSessionGateway(ctx);
  assert.ok(gateway);

  assert.deepEqual(
    await gateway.sessions.create(request("create-id", { workspaceId: "workspace-1" })),
    { rpcId: "create-id", result: { ok: true, value: { sessionId: "session-new" } } }
  );
  assert.equal((await gateway.sessions.prompt(request("prompt-id", {
    sessionId: "session-new",
    mode: "queue",
    content: [{ type: "text", text: "analyse" }]
  }))).result.ok, true);
  assert.equal(calls.prompt[0].payload.requestId, "prompt-id");
  assert.equal(calls.prompt[0].signal.aborted, false);

  const models = await gateway.sessions.models(request("models-id", { sessionId: "session-new" }));
  assert.deepEqual(models.result.value.current, { provider: "vision", model: "image" });
  assert.equal(models.result.value.routable, true);
  assert.equal(released, 1);

  const skills = await gateway.skills.list(request("skills-id", { sessionId: "session-new" }));
  assert.equal(skills.result.value.skills[0].name, "jira-first-turn-analysis");
  assert.equal(calls.skills[0].signal.aborted, false);
});

test("DSH 0.1.5 Remote errors keep the legacy codes used by image fallback", async () => {
  const attachmentError = Object.assign(new Error("text-only model"), {
    code: "session/attachment-invalid",
    details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
  });
  const gateway = resolveDshSessionGateway({
    get(name) {
      if (name === "sessionController") {
        return {
          async create() { return { sessionId: "session-new" }; },
          async prompt() { throw attachmentError; }
        };
      }
      return undefined;
    }
  });

  const response = await gateway.sessions.prompt(request("prompt-id", {
    sessionId: "session-new",
    mode: "queue",
    content: [{ type: "image" }]
  }));
  assert.equal(response.result.ok, false);
  assert.equal(response.result.error.code, "attachment-error");
  assert.deepEqual(response.result.error.details, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
});

test("an existing apiProxy remains the compatibility source for old fixtures", () => {
  const legacy = { sessions: { create() {}, prompt() {} } };
  assert.equal(resolveDshSessionGateway({ get: () => legacy }), legacy);
});
