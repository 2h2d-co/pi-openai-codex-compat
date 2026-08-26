import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  EXEC_COMMAND_DESCRIPTION,
  EXEC_COMMAND_PARAMETERS,
  UNIFIED_EXEC_OUTPUT_SCHEMA,
  WRITE_STDIN_DESCRIPTION,
  WRITE_STDIN_PARAMETERS,
} from "../../extensions/openai-codex-compat/command-tool-contract.ts";
import {
  assert,
  test,
  Type,
  IMAGE_GENERATION_PARAMETERS,
  NATIVE_RESPONSE_ENTRY_TYPE,
  IMAGE_GENERATION_TOOL_NAME,
  codexModel,
  userEntry,
  textEvents,
  accessToken,
  createHarness,
  type AssistantMessage,
  type Context,
  type Tool,
  type JsonRecord,
} from "./codex-provider-harness.ts";

test("transports the official unified exec output schemas", async () => {
  const user = userEntry("user-1", "run a command");
  const harness = createHarness([user]);
  let request: JsonRecord | undefined;
  harness.runtime.transport.request = async function* (_model, body) {
    request = structuredClone(requireJsonRecord(body));
    yield* textEvents("done");
  };
  const execCommand: Tool = {
    name: "exec_command",
    description: EXEC_COMMAND_DESCRIPTION,
    parameters: EXEC_COMMAND_PARAMETERS,
  };
  const writeStdin: Tool = {
    name: "write_stdin",
    description: WRITE_STDIN_DESCRIPTION,
    parameters: WRITE_STDIN_PARAMETERS,
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [execCommand, writeStdin],
      },
      {
        apiKey: accessToken(),
        transport: "sse",
      },
    )
    .result();

  assert.ok(request);
  const tools = requireJsonRecords(request.tools);
  assert.deepEqual(tools[0]?.["output_schema"], UNIFIED_EXEC_OUTPUT_SCHEMA);
  assert.deepEqual(tools[1]?.["output_schema"], UNIFIED_EXEC_OUTPUT_SCHEMA);
});

test("transports dotted Pi tools as native Responses namespaces", async () => {
  const user = userEntry("user-1", "search");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield { type: "response.created", response: { id: "resp_web" } };
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_web",
        call_id: "call_web",
        namespace: "web",
        name: "run",
        arguments: "",
      },
    };
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_web",
        call_id: "call_web",
        namespace: "web",
        name: "run",
        arguments: '{"search_query":[{"q":"Pi"}]}',
      },
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_web",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    };
  };
  const webRun: Tool = {
    name: "web.run",
    description: "Browse the web",
    parameters: Type.Object({
      search_query: Type.Array(Type.Object({ q: Type.String() })),
    }),
  };
  const imageGeneration: Tool = {
    name: IMAGE_GENERATION_TOOL_NAME,
    description: "Generate an image",
    parameters: IMAGE_GENERATION_PARAMETERS,
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [webRun, imageGeneration],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  const firstRequest = requests[0];
  assert.ok(firstRequest);
  assert.deepEqual(requireJsonRecords(firstRequest.tools)[0], {
    type: "namespace",
    name: "web",
    description: "Tools in the web namespace.",
    tools: [
      {
        type: "function",
        name: "run",
        description: "Browse the web",
        parameters: webRun.parameters,
        strict: false,
      },
    ],
  });
  assert.deepEqual(requireJsonRecords(firstRequest.tools)[1], {
    type: "namespace",
    name: "image_gen",
    description: "Tools in the image_gen namespace.",
    tools: [
      {
        type: "function",
        name: "imagegen",
        description: "Generate an image",
        parameters: IMAGE_GENERATION_PARAMETERS,
        strict: false,
      },
    ],
  });
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.equal(toolCall?.name, "web.run");
  assert.equal(harness.customEntries.length, 0);
});

test("selects the model-compatible deferred tool representation", async () => {
  const user = userEntry("user-1", "load more tools");
  const loader: Tool = {
    name: "loader",
    description: "Load tools",
    parameters: Type.Object({ query: Type.String() }),
  };
  const deferred: Tool = {
    name: "deferred",
    description: "A deferred tool",
    parameters: Type.Object({ value: Type.String() }),
  };
  const assistant = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_loader|fc_loader",
        name: loader.name,
        arguments: { query: deferred.name },
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
  const context = {
    messages: [
      user.message,
      assistant,
      {
        role: "toolResult",
        toolCallId: "call_loader|fc_loader",
        toolName: loader.name,
        content: [{ type: "text", text: "loaded" }],
        isError: false,
        timestamp: 2,
        addedToolNames: [deferred.name],
      },
    ],
    tools: [loader, deferred],
  } satisfies Context;
  const cases = [
    {
      name: "additional-tools",
      compat: { supportsAdditionalTools: true, supportsToolSearch: true },
      expectedInputType: "additional_tools",
      expectedDeferredFlag: undefined,
    },
    {
      name: "tool-search",
      compat: { supportsToolSearch: true },
      expectedInputType: "tool_search_output",
      expectedDeferredFlag: true,
    },
    {
      name: "top-level",
      compat: {},
      expectedInputType: undefined,
      expectedDeferredFlag: undefined,
    },
  ] as const;

  for (const testCase of cases) {
    const harness = createHarness([user]);
    let request: JsonRecord | undefined;
    harness.runtime.transport.request = async function* (_model, body) {
      request = structuredClone(requireJsonRecord(body));
      yield* textEvents("done");
    };
    const baseModel = codexModel();
    const selectedModel = {
      ...baseModel,
      compat: {
        ...baseModel.compat,
        ...testCase.compat,
      },
    };

    await harness.runtime
      .streamSimple(selectedModel, context, {
        apiKey: accessToken(),
        transport: "sse",
      })
      .result();

    assert.ok(request, testCase.name);
    const topLevelTools = requireJsonRecords(request.tools);
    assert.deepEqual(
      topLevelTools.map((tool) => tool["name"]),
      testCase.name === "top-level" ? [loader.name, deferred.name] : [loader.name],
      testCase.name,
    );
    const input = requireJsonRecords(request.input);
    const deferredItem = input.find((item) => item["type"] === testCase.expectedInputType);
    if (testCase.expectedInputType === undefined) {
      assert.equal(
        input.some(
          (item) =>
            item["type"] === "additional_tools" ||
            item["type"] === "tool_search_call" ||
            item["type"] === "tool_search_output",
        ),
        false,
        testCase.name,
      );
      continue;
    }
    assert.ok(deferredItem, testCase.name);
    const deferredDefinition = requireJsonRecords(deferredItem["tools"])[0];
    assert.equal(deferredDefinition?.["name"], deferred.name, testCase.name);
    assert.equal(
      deferredDefinition?.["defer_loading"],
      testCase.expectedDeferredFlag,
      testCase.name,
    );
  }
});

test("persists native output only when Pi cannot round-trip it", async () => {
  const user = userEntry("user-1", "search");
  const harness = createHarness([user]);
  const nativeItem = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "Pi" },
  };
  let replayItems: readonly JsonRecord[] | undefined;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    yield { type: "response.created", response: { id: "resp_search" } };
    yield {
      type: "response.output_item.done",
      item: nativeItem,
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_search",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    };
    options.onContinuationReady?.({
      responseId: "resp_search",
      replaceResponseItems(items) {
        replayItems = structuredClone(items);
        return true;
      },
    });
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  assert.equal(message.responseId, "resp_search");
  assert.equal(harness.customEntries.length, 1);
  assert.equal(harness.customEntries[0]?.customType, NATIVE_RESPONSE_ENTRY_TYPE);
  assert.match(JSON.stringify(harness.customEntries[0]?.data), /web_search_call/);
  assert.equal(JSON.stringify(replayItems), JSON.stringify([nativeItem]));
});
