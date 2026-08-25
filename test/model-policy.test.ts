import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import registerCodexModelPolicy, {
  type CodexModelPolicyApi,
  type CodexModelPolicyContext,
  type CodexModelPolicyEvent,
} from "../extensions/openai-codex-compat/model-policy.ts";

type TestHandler = (
  event: CodexModelPolicyEvent | undefined,
  ctx: CodexModelPolicyContext,
) => Promise<void> | void;

function model(provider: string, id: string, api: Api): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  } satisfies Model<Api>;
}

const codexModel = model("openai-codex", "gpt-test", "openai-codex-responses");
const foreignModel = model("anthropic", "claude-test", "anthropic-messages");

function checkpointEntry(): SessionEntry {
  return {
    type: "compaction",
    id: "compact-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "marker",
    firstKeptEntryId: "compact-1",
    tokensBefore: 50_000,
    details: {
      kind: CHECKPOINT_ENTRY_TYPE,
      version: 1,
      modelId: codexModel.id,
      history: [{ type: "compaction", encrypted_content: "opaque-state" }],
    },
  } satisfies SessionEntry;
}

function createHarness(branch: SessionEntry[], initialModel: Model<Api>) {
  const handlers = new Map<string, TestHandler>();
  const notices: Array<{ message: string; level: string }> = [];
  const setModelCalls: Model<Api>[] = [];
  let activeTools = ["read", "edit", "write", "bash"];
  let selectedModel = initialModel;

  const context = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    get model() {
      return selectedModel;
    },
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify(message, level) {
        notices.push({ message, level: level ?? "info" });
      },
    },
  } satisfies CodexModelPolicyContext;

  const pi: CodexModelPolicyApi = {
    onModelSelect: (handler) =>
      handlers.set("model_select", (event, ctx) => {
        if (!event) throw new Error("model_select test event is missing.");
        return handler(event, ctx);
      }),
    onSessionStart: (handler) => handlers.set("session_start", (_event, ctx) => handler(ctx)),
    onSessionShutdown: (handler) => handlers.set("session_shutdown", () => handler()),
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    async setModel(nextModel: Model<Api>) {
      setModelCalls.push(nextModel);
      const previousModel = selectedModel;
      selectedModel = nextModel;
      await handlers.get("model_select")?.(
        {
          model: nextModel,
          previousModel,
          source: "set",
        },
        context,
      );
      return true;
    },
  };

  registerCodexModelPolicy(pi, () => DEFAULT_CONFIG);

  const select = async (nextModel: Model<Api>, source: CodexModelPolicyEvent["source"] = "set") => {
    const previousModel = selectedModel;
    selectedModel = nextModel;
    await handlers.get("model_select")?.({ model: nextModel, previousModel, source }, context);
  };

  return {
    activeTools: () => activeTools,
    handlers,
    notices,
    select,
    selectedModel: () => selectedModel,
    setModelCalls,
    context,
  };
}

test("activates extension tools only for OpenAI Codex models", async () => {
  const harness = createHarness([], codexModel);
  await harness.handlers.get("session_start")?.(undefined, harness.context);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "image_gen.imagegen",
  ]);

  await harness.select(foreignModel);
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "bash"]);

  await harness.select(codexModel);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "image_gen.imagegen",
  ]);

  await harness.handlers.get("session_shutdown")?.(undefined, harness.context);
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "bash"]);
});

test("rejects model switches while the active branch contains a native checkpoint", async () => {
  const harness = createHarness([checkpointEntry()], codexModel);
  await harness.handlers.get("session_start")?.(undefined, harness.context);

  await harness.select(foreignModel);

  assert.equal(harness.selectedModel(), codexModel);
  assert.deepEqual(harness.setModelCalls, [codexModel]);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "image_gen.imagegen",
  ]);
  assert.equal(harness.notices.at(-1)?.level, "warning");
  assert.match(harness.notices.at(-1)?.message ?? "", /Model switch rejected/);
});
