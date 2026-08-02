import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { convertResponsesMessages as referenceConvertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { activeResponsesTools } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import {
  CODEX_NAMESPACED_TOOL_NAMES,
  IMAGE_GENERATION_TOOL_NAME,
  WEB_RUN_TOOL_NAME,
} from "../extensions/openai-codex-compat/namespaced-tools.ts";
import {
  convertResponsesMessages as copiedConvertResponsesMessages,
  convertResponsesTools,
} from "../extensions/openai-codex-compat/vendor/pi-ai/openai-responses-serialization.ts";

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

const webRunTool: Tool = {
  name: WEB_RUN_TOOL_NAME,
  description: "Browse the web",
  parameters: Type.Object({ query: Type.String() }),
};

const imageGenerationTool: Tool = {
  name: IMAGE_GENERATION_TOOL_NAME,
  description: "Generate an image",
  parameters: Type.Object({ prompt: Type.String() }),
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
      content: [
        {
          type: "text",
          text: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM example.txt\n",
        },
      ],
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

void test("replays native assistant items by response id", () => {
  const responseId = "resp_native";
  const nativeItem = {
    type: "web_search_call",
    id: "ws_native",
    status: "completed",
    action: { type: "search", query: "Pi" },
  };
  const nativeContext: Context = {
    messages: [
      {
        ...assistantMessage,
        responseId,
        content: [{ type: "text", text: "Native response" }],
      },
    ],
    tools: [applyPatchTool],
  };

  const converted = copiedConvertResponsesMessages(model, nativeContext, allowedProviders, {
    ...options,
    nativeAssistantItems: new Map([[responseId, [nativeItem]]]),
  });

  assert.deepEqual(converted, [nativeItem]);
});

void test("serializes allowlisted dotted tools as Responses namespaces", () => {
  assert.deepEqual(
    convertResponsesTools([webRunTool, imageGenerationTool], {
      strict: null,
      supportsStrictMode: true,
      namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
    }),
    [
      {
        type: "namespace",
        name: "web",
        description: "Tools in the web namespace.",
        tools: [
          {
            type: "function",
            name: "run",
            description: "Browse the web",
            parameters: webRunTool.parameters,
            strict: false,
          },
        ],
      },
      {
        type: "namespace",
        name: "image_gen",
        description: "Tools in the image_gen namespace.",
        tools: [
          {
            type: "function",
            name: "imagegen",
            description: "Generate an image",
            parameters: imageGenerationTool.parameters,
            strict: false,
          },
        ],
      },
    ],
  );
});

void test("round-trips namespaced calls and deferred namespaced definitions", () => {
  const namespacedAssistant = {
    ...assistantMessage,
    content: [
      {
        type: "toolCall",
        id: "call_web|fc_web",
        name: WEB_RUN_TOOL_NAME,
        arguments: { query: "Pi" },
      },
    ],
  } as AssistantMessage;
  const namespacedContext: Context = {
    messages: [
      namespacedAssistant,
      {
        role: "toolResult",
        toolCallId: "call_web|fc_web",
        toolName: WEB_RUN_TOOL_NAME,
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
        addedToolNames: [IMAGE_GENERATION_TOOL_NAME],
      },
    ],
    tools: [webRunTool, imageGenerationTool],
  };

  const converted = copiedConvertResponsesMessages(model, namespacedContext, allowedProviders, {
    includeSystemPrompt: false,
    deferredTools: new Map([[IMAGE_GENERATION_TOOL_NAME, imageGenerationTool]]),
    namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
    toolOptions: {
      strict: null,
      supportsStrictMode: true,
      namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
    },
  });

  assert.deepEqual(converted[0], {
    type: "function_call",
    id: "fc_web",
    call_id: "call_web",
    namespace: "web",
    name: "run",
    arguments: '{"query":"Pi"}',
  });
  assert.equal(converted[1]?.["type"], "function_call_output");
  assert.equal(converted[2]?.["type"], "tool_search_call");
  const toolSearchOutput = converted[3];
  assert.ok(toolSearchOutput);
  assert.deepEqual((toolSearchOutput["tools"] as Record<string, unknown>[])[0], {
    type: "namespace",
    name: "image_gen",
    description: "Tools in the image_gen namespace.",
    tools: [
      {
        type: "function",
        name: "imagegen",
        description: "Generate an image",
        parameters: imageGenerationTool.parameters,
        defer_loading: true,
        strict: false,
      },
    ],
  });
});

void test("serializes active compaction tools with the same namespace contract", () => {
  assert.deepEqual(
    activeResponsesTools(
      [
        {
          name: WEB_RUN_TOOL_NAME,
          description: webRunTool.description,
          parameters: webRunTool.parameters,
        } as ToolInfo,
      ],
      [WEB_RUN_TOOL_NAME],
    ),
    [
      {
        type: "namespace",
        name: "web",
        description: "Tools in the web namespace.",
        tools: [
          {
            type: "function",
            name: "run",
            description: webRunTool.description,
            parameters: webRunTool.parameters,
            strict: false,
          },
        ],
      },
    ],
  );
});
