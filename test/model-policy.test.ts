import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import registerCodexModelPolicy from "../extensions/openai-codex-compat/model-policy.ts";

type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;

function model(provider: string, id: string, api: string): Model<any> {
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
  } as Model<any>;
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
  } as SessionEntry;
}

function createHarness(branch: SessionEntry[], initialModel: Model<any>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const notices: Array<{ message: string; level: string }> = [];
  const setModelCalls: Model<any>[] = [];
  let activeTools = ["read", "edit", "write"];
  let selectedModel = initialModel;

  const context = {
    get model() {
      return selectedModel;
    },
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify(message: string, level: string) {
        notices.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    getActiveTools: () => activeTools,
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    async setModel(nextModel: Model<any>) {
      setModelCalls.push(nextModel);
      const previousModel = selectedModel;
      selectedModel = nextModel;
      await handlers.get("model_select")?.(
        {
          type: "model_select",
          model: nextModel,
          previousModel,
          source: "set",
        } satisfies ModelSelectEvent,
        context,
      );
      return true;
    },
  } as unknown as ExtensionAPI;

  registerCodexModelPolicy(pi, () => DEFAULT_CONFIG);

  const select = async (nextModel: Model<any>, source: ModelSelectEvent["source"] = "set") => {
    const previousModel = selectedModel;
    selectedModel = nextModel;
    await handlers.get("model_select")?.(
      { type: "model_select", model: nextModel, previousModel, source },
      context,
    );
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

void test("activates extension tools only for OpenAI Codex models", async () => {
  const harness = createHarness([], codexModel);
  await harness.handlers.get("session_start")?.({}, harness.context);
  assert.deepEqual(harness.activeTools(), ["read", "apply_patch", "image_gen.imagegen"]);

  await harness.select(foreignModel);
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write"]);

  await harness.select(codexModel);
  assert.deepEqual(harness.activeTools(), ["read", "apply_patch", "image_gen.imagegen"]);
});

void test("rejects model switches while the active branch contains a native checkpoint", async () => {
  const harness = createHarness([checkpointEntry()], codexModel);
  await harness.handlers.get("session_start")?.({}, harness.context);

  await harness.select(foreignModel);

  assert.equal(harness.selectedModel(), codexModel);
  assert.deepEqual(harness.setModelCalls, [codexModel]);
  assert.deepEqual(harness.activeTools(), ["read", "apply_patch", "image_gen.imagegen"]);
  assert.equal(harness.notices.at(-1)?.level, "warning");
  assert.match(harness.notices.at(-1)?.message ?? "", /Model switch rejected/);
});
