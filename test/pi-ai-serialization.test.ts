import {
  requireJsonRecord,
  requireJsonRecords,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createSyntheticSourceInfo,
  createWriteTool,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SystemMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  convertResponsesMessages as referenceConvertResponsesMessages,
  convertResponsesTools as referenceConvertResponsesTools,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  activeResponsesTools,
  encodeSessionEntries,
} from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { IMAGE_GENERATION_PARAMETERS } from "../extensions/openai-codex-compat/image-generation-schema.ts";
import {
  CODEX_NAMESPACED_TOOL_NAMES,
  CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
  IMAGE_GENERATION_TOOL_NAME,
  WEB_RUN_TOOL_NAME,
} from "../extensions/openai-codex-compat/namespaced-tools.ts";
import {
  convertResponsesMessages as copiedConvertResponsesMessages,
  convertResponsesTools,
} from "../extensions/openai-codex-compat/vendor/pi-ai/openai-responses-serialization.ts";

const model: Model<Api> = {
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
  compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
};

const TEST_TOOL_SOURCE = createSyntheticSourceInfo("test-tool", {
  source: "pi-ai-serialization test",
});

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
  parameters: IMAGE_GENERATION_PARAMETERS,
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
} satisfies AssistantMessage;

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
    },
    { role: "system", content: "", toolsAdded: [deferredTool], timestamp: 3 },
  ],
  tools: [applyPatchTool],
};

const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);
const options = {
  includeSystemPrompt: false,
  grammarToolInputProperties: new Map([["apply_patch", "patch"]]),
  supportsMidConvoSystemMessages: true,
  supportsToolSearch: true,
  toolOptions: {
    strict: null,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
  },
};

test("copied Pi AI Responses serialization matches the dependency", () => {
  const reference = referenceConvertResponsesMessages(
    model,
    normalizeContext(context),
    allowedProviders,
    options,
  );
  const copied = copiedConvertResponsesMessages(model, context, allowedProviders, options);
  assert.deepEqual(copied, reference);
});

test("matches Pi 0.86 system sections and tool state without mutating the transcript", () => {
  const updates: SystemMessage[] = [
    { role: "system", content: "", sections: { rules: "new rules", cwd: null }, timestamp: 4 },
    { role: "system", content: "", toolsRemoved: [{ name: "deferred" }], timestamp: 5 },
    {
      role: "system",
      content: "",
      toolsAdded: [{ ...applyPatchTool, description: "Updated patch" }],
      timestamp: 6,
    },
  ];
  for (const update of updates) {
    for (const supportsMidConvoSystemMessages of [false, true]) {
      for (const supportsAdditionalTools of [false, true]) {
        const transcript = normalizeContext({
          messages: [
            {
              role: "system",
              content: "initial",
              sections: { rules: "old rules", cwd: "/old" },
              toolsAdded: [applyPatchTool],
              timestamp: 0,
            },
            ...context.messages,
            update,
            { ...assistantMessage, content: [{ type: "text", text: "reply without signature" }] },
          ],
        });
        const original = structuredClone(transcript);
        const serializationOptions = {
          ...options,
          includeSystemPrompt: true,
          supportsMidConvoSystemMessages,
          supportsAdditionalTools,
        };
        // Pi's serializer retains undefined optional keys. Compare the wire JSON.
        assert.deepEqual(
          copiedConvertResponsesMessages(model, transcript, allowedProviders, serializationOptions),
          JSON.parse(
            JSON.stringify(
              referenceConvertResponsesMessages(
                model,
                transcript,
                allowedProviders,
                serializationOptions,
              ),
            ),
          ),
        );
        assert.deepEqual(transcript, original);
      }
    }
  }
});

test("requires an explicit tool addition capability and supports additional_tools", () => {
  const withoutModeOptions = {
    includeSystemPrompt: options.includeSystemPrompt,
    grammarToolInputProperties: options.grammarToolInputProperties,
    supportsMidConvoSystemMessages: true,
    toolOptions: options.toolOptions,
  };
  const withoutMode = copiedConvertResponsesMessages(
    model,
    context,
    allowedProviders,
    withoutModeOptions,
  );
  assert.deepEqual(
    withoutMode,
    referenceConvertResponsesMessages(
      model,
      normalizeContext(context),
      allowedProviders,
      withoutModeOptions,
    ),
  );
  assert.equal(
    withoutMode.some(
      (item) => item["type"] === "additional_tools" || item["type"] === "tool_search_call",
    ),
    false,
  );

  const additionalToolsOptions = {
    ...options,
    supportsAdditionalTools: true,
    toolOptions: {
      ...options.toolOptions,
      strict: false,
    },
  };
  const additionalToolsHistory = copiedConvertResponsesMessages(
    model,
    context,
    allowedProviders,
    additionalToolsOptions,
  );
  assert.deepEqual(
    additionalToolsHistory,
    referenceConvertResponsesMessages(
      model,
      normalizeContext(context),
      allowedProviders,
      additionalToolsOptions,
    ),
  );
  const additionalTools = additionalToolsHistory.find(
    (item) => item["type"] === "additional_tools",
  );
  assert.deepEqual(additionalTools, {
    type: "additional_tools",
    role: "developer",
    tools: [
      {
        type: "function",
        name: deferredTool.name,
        description: deferredTool.description,
        parameters: deferredTool.parameters,
        strict: false,
      },
    ],
  });
});

test("configures image detail for image tool-result history", () => {
  const imageModel = { ...model, input: ["text", "image"] } satisfies Model<Api>;
  const imageAssistant = {
    ...assistantMessage,
    content: [
      {
        type: "toolCall",
        id: "call_image|fc_image",
        name: IMAGE_GENERATION_TOOL_NAME,
        arguments: { prompt: "Draw it" },
      },
    ],
  } satisfies AssistantMessage;
  const imageResult = {
    role: "toolResult" as const,
    toolCallId: "call_image|fc_image",
    toolName: IMAGE_GENERATION_TOOL_NAME,
    content: [
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "text" as const, text: "The generated image is already displayed." },
    ],
    isError: false,
    timestamp: 2,
  };
  const converted = copiedConvertResponsesMessages(
    imageModel,
    { messages: [imageAssistant, imageResult] },
    allowedProviders,
    {
      includeSystemPrompt: false,
      toolResultImageDetail: "original",
    },
  );

  assert.deepEqual(converted[1]?.["output"], [
    { type: "input_text", text: "The generated image is already displayed." },
    {
      type: "input_image",
      detail: "original",
      image_url: "data:image/png;base64,aW1hZ2U=",
    },
  ]);

  const entries = [
    {
      type: "message",
      id: "assistant-image",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: imageAssistant,
    },
    {
      type: "message",
      id: "result-image",
      parentId: "assistant-image",
      timestamp: new Date(2).toISOString(),
      message: imageResult,
    },
  ] satisfies SessionEntry[];
  const checkpointHistory = encodeSessionEntries({
    model: imageModel,
    entries,
    allTools: [],
    grammarToolInputProperties: new Map(),
    imageDetail: "low",
  });
  const checkpointOutput = checkpointHistory[1]?.["output"];
  assert.ok(Array.isArray(checkpointOutput));
  assert.equal(requireJsonRecord(checkpointOutput[1])["detail"], "low");
});

test("replays native assistant items by response id", () => {
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

test("serializes allowlisted dotted tools as Responses namespaces", () => {
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

test("round-trips namespaced calls and deferred namespaced definitions", () => {
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
  } satisfies AssistantMessage;
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
      },
      { role: "system", content: "", toolsAdded: [imageGenerationTool], timestamp: 3 },
    ],
    tools: [webRunTool],
  };

  const converted = copiedConvertResponsesMessages(model, namespacedContext, allowedProviders, {
    includeSystemPrompt: false,
    supportsMidConvoSystemMessages: true,
    supportsToolSearch: true,
    namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
    textContentItemToolResultNames: CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
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
  assert.deepEqual(converted[1], {
    type: "function_call_output",
    call_id: "call_web",
    output: [{ type: "input_text", text: "result" }],
  });
  assert.equal(converted[2]?.["type"], "tool_search_call");
  const toolSearchOutput = converted[3];
  assert.ok(toolSearchOutput);
  assert.deepEqual(requireJsonRecords(toolSearchOutput["tools"])[0], {
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

  const namespacedResult = namespacedContext.messages[1];
  assert.ok(namespacedResult);
  const entries = [
    {
      type: "message",
      id: "assistant-web",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: namespacedAssistant,
    },
    {
      type: "message",
      id: "result-web",
      parentId: "assistant-web",
      timestamp: new Date(2).toISOString(),
      message: namespacedResult,
    },
    {
      type: "message",
      id: "tools-update",
      parentId: "result-web",
      timestamp: new Date(3).toISOString(),
      message: { role: "system", content: "", toolsAdded: [imageGenerationTool], timestamp: 3 },
    },
  ] satisfies SessionEntry[];
  const checkpointTools = [
    {
      name: IMAGE_GENERATION_TOOL_NAME,
      description: imageGenerationTool.description,
      parameters: imageGenerationTool.parameters,
      sourceInfo: TEST_TOOL_SOURCE,
    } satisfies ToolInfo,
  ];
  const checkpointHistory = encodeSessionEntries({
    model,
    entries,
    allTools: checkpointTools,
    grammarToolInputProperties: new Map(),
  });
  assert.deepEqual(checkpointHistory[1], {
    type: "function_call_output",
    call_id: "call_web",
    output: [{ type: "input_text", text: "result" }],
  });
  assert.equal(checkpointHistory[2]?.["type"], "tool_search_call");
  assert.deepEqual(checkpointHistory[3]?.["tools"], [
    {
      type: "namespace",
      name: "image_gen",
      description: "Tools in the image_gen namespace.",
      tools: [
        {
          type: "function",
          name: "imagegen",
          description: imageGenerationTool.description,
          parameters: IMAGE_GENERATION_PARAMETERS,
          defer_loading: true,
          strict: false,
        },
      ],
    },
  ]);

  const additionalToolsCheckpoint = encodeSessionEntries({
    model: {
      ...model,
      compat: { ...model.compat, supportsAdditionalTools: true },
    },
    entries,
    allTools: checkpointTools,
    grammarToolInputProperties: new Map(),
  });
  assert.deepEqual(additionalToolsCheckpoint[2], {
    type: "additional_tools",
    role: "developer",
    tools: [
      {
        type: "namespace",
        name: "image_gen",
        description: "Tools in the image_gen namespace.",
        tools: [
          {
            type: "function",
            name: "imagegen",
            description: imageGenerationTool.description,
            parameters: IMAGE_GENERATION_PARAMETERS,
            strict: false,
          },
        ],
      },
    ],
  });
});

test("serializes active compaction tools with the same namespace contract", () => {
  assert.deepEqual(
    activeResponsesTools(
      [
        {
          name: "exec_command",
          description: "Run a command",
          parameters: Type.Object({ cmd: Type.String() }),
          sourceInfo: TEST_TOOL_SOURCE,
        } satisfies ToolInfo,
        {
          name: WEB_RUN_TOOL_NAME,
          description: webRunTool.description,
          parameters: webRunTool.parameters,
          sourceInfo: TEST_TOOL_SOURCE,
        } satisfies ToolInfo,
        {
          name: IMAGE_GENERATION_TOOL_NAME,
          description: imageGenerationTool.description,
          parameters: imageGenerationTool.parameters,
          sourceInfo: TEST_TOOL_SOURCE,
        } satisfies ToolInfo,
      ],
      ["exec_command", WEB_RUN_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME],
    ),
    [
      {
        type: "function",
        name: "exec_command",
        description: "Run a command",
        parameters: Type.Object({ cmd: Type.String() }),
        strict: false,
      },
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
      {
        type: "namespace",
        name: "image_gen",
        description: "Tools in the image_gen namespace.",
        tools: [
          {
            type: "function",
            name: "imagegen",
            description: imageGenerationTool.description,
            parameters: IMAGE_GENERATION_PARAMETERS,
            strict: false,
          },
        ],
      },
    ],
  );
});

test("strict JSON-schema tools serialize the strict schema subset exactly like Pi AI", () => {
  const builtinTools: Tool[] = [createReadTool, createBashTool, createEditTool, createWriteTool]
    .map((create) => create(process.cwd()))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling === undefined
        ? {}
        : { constrainedSampling: tool.constrainedSampling }),
    }));
  assert.ok(
    builtinTools.some(
      (tool) =>
        tool.constrainedSampling !== undefined &&
        tool.constrainedSampling !== false &&
        tool.constrainedSampling.type === "json_schema",
    ),
    "Pi's built-in tools request JSON-schema constrained sampling.",
  );
  const requireTool: Tool = {
    name: "strict_required",
    description: "Requires strict sampling",
    parameters: Type.Object({ value: Type.String(), note: Type.Optional(Type.String()) }),
    constrainedSampling: { type: "json_schema", strict: "require" },
  };
  // Object unions are outside the strict subset, so a "prefer" tool falls back to a
  // non-strict schema.
  const unsupportedPreferTool: Tool = {
    name: "loose_preferred",
    description: "Prefers strict sampling but cannot be made strict",
    parameters: Type.Object({
      value: Type.Union([Type.Object({ nested: Type.String() }), Type.Number()]),
    }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
  const tools = [...builtinTools, requireTool, unsupportedPreferTool, deferredTool];
  for (const supportsStrictMode of [true, false]) {
    if (!supportsStrictMode) {
      assert.throws(
        () => convertResponsesTools([requireTool], { strict: null, supportsStrictMode }),
        /requires JSON-schema constrained sampling/,
      );
      assert.throws(
        () => referenceConvertResponsesTools([requireTool], { strict: null, supportsStrictMode }),
        /requires JSON-schema constrained sampling/,
      );
    }
    const candidates = supportsStrictMode ? tools : tools.filter((tool) => tool !== requireTool);
    const copied = convertResponsesTools(candidates, { strict: null, supportsStrictMode });
    assert.deepEqual(
      copied,
      JSON.parse(
        JSON.stringify(
          referenceConvertResponsesTools(candidates, { strict: null, supportsStrictMode }),
        ),
      ),
    );
    if (!supportsStrictMode) continue;
    for (const item of copied) {
      if (item["type"] !== "function") continue;
      const parameters = requireJsonRecord(item["parameters"]);
      if (item["strict"] === true) {
        assert.equal(parameters["additionalProperties"], false, JSON.stringify(item["name"]));
        assert.deepEqual(
          parameters["required"],
          Object.keys(requireJsonRecord(parameters["properties"])),
        );
      } else {
        assert.equal(parameters["additionalProperties"], undefined, JSON.stringify(item["name"]));
      }
    }
    assert.equal(copied.find((item) => item["name"] === "read")?.["strict"], true);
    // The fallback keeps the request-level default, which Codex sends as null.
    assert.equal(copied.find((item) => item["name"] === "loose_preferred")?.["strict"], null);
  }
  // Conversion never mutates the caller's tool schemas.
  assert.equal(requireJsonRecord(requireTool.parameters)["additionalProperties"], undefined);
});
