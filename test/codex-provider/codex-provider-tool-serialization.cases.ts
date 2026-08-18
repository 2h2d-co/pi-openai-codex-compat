import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  Type,
  IMAGE_GENERATION_PARAMETERS,
  NATIVE_RESPONSE_ENTRY_TYPE,
  IMAGE_GENERATION_TOOL_NAME,
  codexModel,
  userEntry,
  accessToken,
  createHarness,
  type Tool,
  type JsonRecord,
} from "./codex-provider-harness.ts";

void test("transports dotted Pi tools as native Responses namespaces", async () => {
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

void test("persists native output only when Pi cannot round-trip it", async () => {
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
