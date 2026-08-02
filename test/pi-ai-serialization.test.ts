import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { convertResponsesMessages as referenceConvertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertResponsesMessages as copiedConvertResponsesMessages } from "../extensions/openai-codex-compat/vendor/pi-ai/openai-responses-serialization.ts";

const model = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 100_000,
  maxTokens: 10_000,
  compat: { supportsOpenAIGrammarTools: true },
} as Model<any>;

const applyPatchTool: Tool = {
  name: "apply_patch",
  description: "Apply a patch",
  parameters: Type.Object({ patch: Type.String() }),
  constrainedSampling: {
    type: "grammar",
    variants: { openai_lark: "start: /.+/" },
  },
};

const deferredTool: Tool = {
  name: "deferred",
  description: "A deferred tool",
  parameters: Type.Object({ value: Type.String() }),
};

const assistantMessage = {
  role: "assistant",
  content: [
    {
      type: "thinking",
      thinking: "",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_test",
        summary: [],
        encrypted_content: "opaque",
      }),
    },
    {
      type: "text",
      text: "Applying the patch",
      textSignature: JSON.stringify({
        v: 1,
        id: "msg_test",
        phase: "commentary",
      }),
    },
    {
      type: "toolCall",
      id: "call_test|ctc_test",
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** End Patch" },
    },
  ],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "gpt-test",
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 1,
} as AssistantMessage;

const context: Context = {
  messages: [
    { role: "user", content: [{ type: "text", text: "Update it" }], timestamp: 0 },
    assistantMessage,
    {
      role: "toolResult",
      toolCallId: "call_test|ctc_test",
      toolName: "apply_patch",
      content: [{ type: "text", text: "Done!" }],
      isError: false,
      timestamp: 2,
      addedToolNames: ["deferred"],
    },
  ],
  tools: [applyPatchTool, deferredTool],
};

const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);
const options = {
  includeSystemPrompt: false,
  grammarToolInputProperties: new Map([["apply_patch", "patch"]]),
  deferredTools: new Map([["deferred", deferredTool]]),
  toolOptions: {
    strict: null,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
  },
};

void test("copied Pi AI Responses serialization matches the dependency", () => {
  const reference = referenceConvertResponsesMessages(model, context, allowedProviders, options);
  const copied = copiedConvertResponsesMessages(model, context, allowedProviders, options);
  assert.deepEqual(copied, reference);
});
