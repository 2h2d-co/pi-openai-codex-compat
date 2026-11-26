import {
  requireJsonRecord,
  requireJsonRecords,
  requireResponsesInputItems,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  convertToLlm,
  SessionManager,
  type SessionEntry,
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
  prepareResponsesPrompt as referencePrepareResponsesPrompt,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  encodeSessionEntries,
  requestTools,
  withEffortBaseline,
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
import { isString } from "../extensions/openai-codex-compat/value-contracts.ts";

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

/**
 * Pi AI's serialization of a transcript without its leading system message. Since Pi AI 1.6.0 the
 * leading system message is always the first developer item; the copy's extension-owned
 * `includeSystemPrompt: false` omits it because Compat sends it from `instructions`.
 */
function referenceWithoutLeadingPrompt(
  ...args: Parameters<typeof referenceConvertResponsesMessages>
): unknown {
  return withoutLeadingPrompt(referenceConvertResponsesMessages(...args));
}

function withoutLeadingPrompt(input: unknown): unknown {
  const items: unknown = JSON.parse(JSON.stringify(input));
  assert.ok(Array.isArray(items));
  const index = items.findIndex(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      !("type" in item) &&
      "role" in item &&
      item.role === "developer",
  );
  assert.ok(index >= 0);
  return items.filter((_: unknown, position: number) => position !== index);
}
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

for (const scenario of [
  { name: "same-model function", itemId: "fc_test", grammar: false, source: "same", keepId: true },
  { name: "same-model grammar", itemId: "ctc_test", grammar: true, source: "same", keepId: true },
  { name: "function to grammar", itemId: "fc_test", grammar: true, source: "same", keepId: false },
  {
    name: "grammar to function",
    itemId: "ctc_test",
    grammar: false,
    source: "same",
    keepId: false,
  },
  { name: "foreign grammar", itemId: "ctc_test", grammar: true, source: "foreign", keepId: false },
  {
    name: "different-model grammar",
    itemId: "ctc_test",
    grammar: true,
    source: "model",
    keepId: false,
  },
  {
    name: "different-model function",
    itemId: "fc_test",
    grammar: false,
    source: "model",
    keepId: false,
  },
] as const) {
  test(`restored ${scenario.name} history preserves call pairing and matches Pi item IDs`, async (t) => {
    const source: AssistantMessage = {
      ...assistantMessage,
      provider: scenario.source === "foreign" ? "radius" : model.provider,
      api: scenario.source === "foreign" ? "pi-messages" : model.api,
      model: scenario.source === "same" ? model.id : "other-model",
      content: [
        {
          type: "toolCall",
          id: `call_test|${scenario.itemId}`,
          name: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** End Patch" },
        },
      ],
    };
    const transcript = normalizeContext({
      messages: [
        { role: "user", content: "Apply the synthetic patch.", timestamp: 0 },
        source,
        {
          role: "toolResult",
          toolCallId: `call_test|${scenario.itemId}`,
          toolName: "apply_patch",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    const directory = await mkdtemp(join(tmpdir(), "codex-replay-ids-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const manager = SessionManager.create(directory, directory);
    for (const message of transcript.messages) manager.appendMessage(message);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    // A cold resume must preserve the IDs persisted by the previous runtime.
    const restored = normalizeContext({
      messages: convertToLlm(SessionManager.open(sessionFile).buildSessionContext().messages),
    });
    const original = JSON.stringify(restored);
    const replayOptions = {
      ...options,
      grammarToolInputProperties: new Map(scenario.grammar ? [["apply_patch", "patch"]] : []),
    };
    const copied = copiedConvertResponsesMessages(model, restored, allowedProviders, replayOptions);
    const reference = referenceConvertResponsesMessages(
      model,
      restored,
      allowedProviders,
      replayOptions,
    );
    assert.deepEqual(copied, JSON.parse(JSON.stringify(reference)));
    const callType = scenario.grammar ? "custom_tool_call" : "function_call";
    const call = copied.find((item) => item.type === callType);
    const result = copied.find((item) => item.type === `${callType}_output`);
    assert.ok(call && result);
    assert.equal(call["id"], scenario.keepId ? scenario.itemId : undefined);
    assert.equal(call["call_id"], "call_test");
    assert.equal(result["call_id"], "call_test");
    assert.equal(
      JSON.stringify(restored),
      original,
      "Serialization must not rewrite saved history.",
    );
  });
}

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

test("holds a system message between a tool call and its results like Pi AI", () => {
  const [userMessage, toolCallMessage, toolResultMessage] = context.messages;
  assert.ok(userMessage && toolCallMessage && toolResultMessage);
  const held: SystemMessage = {
    role: "system",
    content: "",
    sections: { rules: "held rules" },
    timestamp: 2,
  };
  for (const answered of [true, false]) {
    const transcript = normalizeContext({
      messages: [
        { role: "system", content: "initial", toolsAdded: [applyPatchTool], timestamp: 0 },
        userMessage,
        toolCallMessage,
        held,
        ...(answered ? [toolResultMessage] : []),
        { role: "user", content: "next", timestamp: 4 },
      ],
    });
    const serializationOptions = { ...options, supportsMidConvoSystemMessages: true };
    const copied = copiedConvertResponsesMessages(
      model,
      transcript,
      allowedProviders,
      serializationOptions,
    );
    assert.deepEqual(
      copied,
      referenceWithoutLeadingPrompt(model, transcript, allowedProviders, serializationOptions),
    );
    // The update follows the (real or synthetic) tool result rather than
    // separating the call from its result.
    const types = copied.map((item) => item["type"] ?? item["role"]);
    const resultIndex = types.indexOf("custom_tool_call_output");
    assert.ok(resultIndex >= 0, JSON.stringify(types));
    assert.equal(types[resultIndex + 1], "developer");
    assert.equal(
      copied.filter((item) => item["role"] === "developer").length,
      1,
      JSON.stringify(copied),
    );
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
  // Every tool is declared in `additional_tools` items: the leading tools at the head of the input,
  // then each later addition after an incremental-update notice.
  const additionalToolsIndexes = additionalToolsHistory.flatMap((item, index) =>
    item["type"] === "additional_tools" ? [index] : [],
  );
  const [leadingIndex, addedIndex] = additionalToolsIndexes;
  assert.ok(leadingIndex !== undefined && addedIndex !== undefined);
  assert.equal(additionalToolsIndexes.length, 2);
  assert.deepEqual(
    requireJsonRecords(additionalToolsHistory[leadingIndex]?.["tools"]).map((tool) => tool["name"]),
    [applyPatchTool.name],
  );
  assert.match(
    JSON.stringify(additionalToolsHistory[addedIndex - 1]?.["content"]),
    /This is an incremental tools update/,
  );
  assert.deepEqual(additionalToolsHistory[addedIndex], {
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

test("sends a placeholder for whitespace-only tool output, as Pi AI does", () => {
  const whitespaceContext: Context = {
    ...context,
    messages: context.messages.map((message) =>
      message.role === "toolResult"
        ? { ...message, content: [{ type: "text", text: "\r\n" }] }
        : message,
    ),
  };
  const copied = copiedConvertResponsesMessages(
    model,
    whitespaceContext,
    allowedProviders,
    options,
  );
  assert.deepEqual(
    copied,
    referenceConvertResponsesMessages(
      model,
      normalizeContext(whitespaceContext),
      allowedProviders,
      options,
    ),
  );
  const outputs = copied.filter((item) => item["type"] === "custom_tool_call_output");
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.["output"], "(no tool output)");
});

test("replays a tool call name that Codex rejects as a stable placeholder, and other names like Pi AI", () => {
  // Another model put a shell command in a call's name field, and Pi answered the call "not found".
  // Codex accepts 1 to 128 letters, digits, `_`, `.`, and `-`.
  const names = [
    "ls -la src/ && cat package.json</arg_value>",
    "a".repeat(129),
    "a".repeat(128),
    "files.list",
    "lookup_value-2",
  ];
  const foreignContext: Context = {
    messages: [
      { role: "user", content: "List the project files.", timestamp: 0 },
      ...names.flatMap((name, index): Context["messages"] => [
        {
          ...assistantMessage,
          provider: "local-glm",
          api: "openai-completions",
          model: "glm-test",
          content: [{ type: "toolCall", id: `call_${String(index)}`, name, arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: `call_${String(index)}`,
          toolName: name,
          content: [{ type: "text", text: `Tool ${name} not found` }],
          isError: true,
          timestamp: 2,
        },
      ]),
    ],
    tools: [applyPatchTool],
  };
  const original = JSON.stringify(foreignContext);

  const copied = copiedConvertResponsesMessages(model, foreignContext, allowedProviders, options);
  const calls = copied.filter((item) => item["type"] === "function_call");
  const replayedNames = calls.map((call) => call["name"]);
  const [placeholder, longPlaceholder] = replayedNames;
  assert.ok(isString(placeholder) && isString(longPlaceholder));
  assert.match(placeholder, /^invalid_tool_name_[0-9a-z]+$/);
  assert.match(longPlaceholder, /^invalid_tool_name_[0-9a-z]+$/);
  assert.notEqual(placeholder, longPlaceholder);
  assert.deepEqual(replayedNames.slice(2), names.slice(2));
  // Each call still pairs with its "not found" result.
  assert.deepEqual(
    calls.map((call) => call["call_id"]),
    copied.filter((item) => item["type"] === "function_call_output").map((item) => item["call_id"]),
  );

  // The placeholders are the only difference from Pi AI, and they are the same on every request.
  const reference = requireJsonRecords(
    JSON.parse(
      JSON.stringify(
        referenceConvertResponsesMessages(
          model,
          normalizeContext(foreignContext),
          allowedProviders,
          options,
        ),
      ),
    ),
  );
  const placeholders = new Map([
    [names[0], placeholder],
    [names[1], longPlaceholder],
  ]);
  assert.deepEqual(
    copied,
    reference.map((item) =>
      item["type"] === "function_call" && isString(item["name"]) && placeholders.has(item["name"])
        ? { ...item, name: placeholders.get(item["name"]) }
        : item,
    ),
  );
  assert.deepEqual(
    copiedConvertResponsesMessages(model, foreignContext, allowedProviders, options),
    copied,
  );
  assert.equal(JSON.stringify(foreignContext), original);
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
    status: "completed",
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
  // Checkpoint history never carries tool declarations: the extension declares
  // every tool at the top level regardless of the model's compatibility flags.
  // A tool-only system update renders no inline text either.
  for (const compat of [
    model.compat ?? {},
    { ...model.compat, supportsToolSearch: true },
    { ...model.compat, supportsAdditionalTools: true },
    { ...model.compat, supportsMidConvoSystemMessages: true },
  ]) {
    const checkpointHistory = encodeSessionEntries({
      model: { ...model, compat },
      entries,
      grammarToolInputProperties: new Map(),
    });
    assert.deepEqual(
      checkpointHistory.map((item) => item["type"]),
      ["function_call", "function_call_output"],
    );
    assert.deepEqual(checkpointHistory[1], {
      type: "function_call_output",
      call_id: "call_web",
      output: [{ type: "input_text", text: "result" }],
    });
  }
});

test("declares Codex request tools with the namespace contract", () => {
  assert.deepEqual(
    requestTools(model, [
      {
        name: "exec_command",
        description: "Run a command",
        parameters: Type.Object({ cmd: Type.String() }),
      },
      webRunTool,
      imageGenerationTool,
    ]),
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

test("sends thinking levels as configuration updates like Pi AI", () => {
  const reply = (text: string, timestamp: number, overrides: Partial<AssistantMessage>) =>
    ({
      ...assistantMessage,
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp,
      ...overrides,
    }) satisfies AssistantMessage;
  const transcript = normalizeContext({
    messages: [
      { role: "system", content: "initial", timestamp: 0 },
      { role: "user", content: "first", timestamp: 1 },
      reply("high reply", 2, { providerThinkingLevel: "high" }),
      { role: "user", content: "second", timestamp: 3 },
      // Only replies of the same model replay their level.
      reply("other model reply", 4, { model: "gpt-other", providerThinkingLevel: "low" }),
      { role: "user", content: "third", timestamp: 5 },
      reply("unrecorded reply", 6, {}),
      { role: "user", content: "fourth", timestamp: 7 },
    ],
  });
  const updateOptions = { ...options, configurationUpdateEffort: "none" };
  const copied = copiedConvertResponsesMessages(model, transcript, allowedProviders, updateOptions);
  assert.deepEqual(
    copied,
    referenceWithoutLeadingPrompt(model, transcript, allowedProviders, updateOptions),
  );
  const updates = copied.flatMap((item, index) =>
    item["type"] === "configuration_update" ? [{ index, item }] : [],
  );
  assert.deepEqual(
    updates.map(({ item }) => item),
    [
      { type: "configuration_update", reasoning: { effort: "high" } },
      { type: "configuration_update", reasoning: { effort: "none" } },
    ],
  );
  // The recorded level precedes its reply, and the request's own level ends the input.
  assert.match(JSON.stringify(copied[(updates[0]?.index ?? 0) + 1]), /high reply/);
  assert.equal(updates[1]?.index, copied.length - 1);
  // Without the option no update is sent.
  assert.equal(
    copiedConvertResponsesMessages(model, transcript, allowedProviders, options).some(
      (item) => item["type"] === "configuration_update",
    ),
    false,
  );
});

test("starts reasoning effort at the first recorded level like Pi AI", () => {
  const reply = (text: string, timestamp: number, overrides: Partial<AssistantMessage>) =>
    ({
      ...assistantMessage,
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp,
      ...overrides,
    }) satisfies AssistantMessage;
  const user = (content: string, timestamp: number) =>
    ({ role: "user", content, timestamp }) as const;
  const initial = { role: "system", content: "initial", timestamp: 0 } as const;
  for (const scenario of [
    {
      name: "no earlier reply",
      messages: [initial, user("first", 1)],
      effort: "low",
      baseline: "low",
      updates: [],
    },
    {
      name: "unchanged level",
      messages: [
        initial,
        user("first", 1),
        reply("high reply", 2, { providerThinkingLevel: "high" }),
        user("second", 3),
      ],
      effort: "high",
      baseline: "high",
      updates: [],
    },
    {
      name: "changed levels",
      messages: [
        initial,
        user("first", 1),
        reply("first high reply", 2, { providerThinkingLevel: "high" }),
        user("second", 3),
        // Only replies of the same model replay their level.
        reply("other model reply", 4, { model: "gpt-other", providerThinkingLevel: "low" }),
        user("third", 5),
        reply("second high reply", 6, { providerThinkingLevel: "high" }),
        user("fourth", 7),
        reply("medium reply", 8, { providerThinkingLevel: "medium" }),
        user("fifth", 9),
      ],
      effort: "none",
      baseline: "high",
      updates: ["medium", "none"],
    },
  ]) {
    const transcript = normalizeContext({ messages: scenario.messages });
    const updateOptions = { ...options, configurationUpdateEffort: scenario.effort };
    const copied = withEffortBaseline(
      requireResponsesInputItems(
        copiedConvertResponsesMessages(model, transcript, allowedProviders, updateOptions),
      ),
    );
    const reference = referencePrepareResponsesPrompt(model, transcript, allowedProviders, {
      ...updateOptions,
      effortBaseline: "initial",
    });
    assert.deepEqual(copied.input, withoutLeadingPrompt(reference.input), scenario.name);
    assert.equal(copied.effortBaseline, reference.requestEffortBaseline, scenario.name);
    assert.equal(copied.effortBaseline, scenario.baseline, scenario.name);
    assert.deepEqual(
      copied.input.flatMap((item) =>
        item["type"] === "configuration_update" ? [requireJsonRecord(item["reasoning"])] : [],
      ),
      scenario.updates.map((effort) => ({ effort })),
      scenario.name,
    );
  }
});

test("replays the recorded thinking level before native reply items", () => {
  const nativeItem = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "native reply", annotations: [] }],
    status: "completed",
    id: "msg_native",
  };
  const transcript = normalizeContext({
    messages: [
      { role: "user", content: "first", timestamp: 1 },
      {
        ...assistantMessage,
        content: [{ type: "text", text: "native reply" }],
        stopReason: "stop",
        timestamp: 2,
        responseId: "resp_native",
        providerThinkingLevel: "medium",
      } satisfies AssistantMessage,
    ],
  });
  assert.deepEqual(
    copiedConvertResponsesMessages(model, transcript, allowedProviders, {
      ...options,
      configurationUpdateEffort: "low",
      nativeAssistantItems: new Map([["resp_native", [nativeItem]]]),
    }),
    [
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { type: "configuration_update", reasoning: { effort: "medium" } },
      nativeItem,
      { type: "configuration_update", reasoning: { effort: "low" } },
    ],
  );
});
