import {
  assert,
  test,
  MANUAL_COMPACTION_METADATA,
  codexModel,
  userEntry,
  textEvents,
  compactionEvents,
  accessToken,
  createHarness,
  type AssistantMessage,
  type Context,
  type JsonRecord,
  type CodexTransportDiagnostic,
} from "./codex-provider-harness.ts";

void test("emits start only when the Codex transport starts", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const diagnostic: CodexTransportDiagnostic = {
    type: "provider_transport_failure",
    timestamp: Date.now(),
    error: { name: "Error", message: "WebSocket unavailable" },
    details: {
      configuredTransport: "auto",
      fallbackTransport: "sse",
      eventsEmitted: false,
      phase: "before_message_stream_start",
      requestBytes: 123,
    },
  };
  harness.runtime.transport.request = async function* (_model, _body, options) {
    options.onTransportDiagnostic?.(diagnostic);
    options.onTransportStart?.();
    yield* textEvents("hello back");
  };

  const events = [];
  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  for await (const event of result) events.push(event);

  assert.equal(events[0]?.type, "start");
  assert.deepEqual(events[0]?.partial.diagnostics, [diagnostic]);
  assert.equal(events.at(-1)?.type, "done");
});

void test("normalizes pre-stream failures without emitting start", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield* [];
    throw { code: "transport_failed", message: "connection failed" };
  };

  const events = [];
  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  for await (const event of result) events.push(event);

  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(
    errorEvent?.error.errorMessage,
    '{"code":"transport_failed","message":"connection failed"}',
  );
});

void test("cleans streaming scratch state and surfaces structured provider errors", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const failure = Object.assign(new Error("opaque provider failure"), {
    status: 403,
    error: { message: "request denied" },
  });
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "tool",
        arguments: "",
      },
    };
    yield {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"input":',
    };
    throw failure;
  };

  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  let failedMessage: AssistantMessage | undefined;
  for await (const event of result) {
    if (event.type === "error") failedMessage = event.error;
  }

  assert.equal(failedMessage?.errorMessage, '403: {"message":"request denied"}');
  const toolCall = failedMessage?.content.find((block) => block.type === "toolCall");
  assert.ok(toolCall);
  assert.equal("partialJson" in toolCall, false);
  assert.equal("customInput" in toolCall, false);
});

void test("honors non-object payload replacements like Pi AI", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  let request: unknown;
  harness.runtime.transport.request = async function* (_model, body) {
    request = body;
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
        onPayload: () => [],
      },
    )
    .result();

  assert.deepEqual(request, []);
});

void test("rejects missing streamSimple authentication synchronously", () => {
  const harness = createHarness([userEntry("user-1", "hello")]);
  assert.throws(
    () => harness.runtime.streamSimple(codexModel(), { messages: [] }, {}),
    /No API key for provider: openai-codex/,
  );
});

void test("validates direct-stream and compaction authentication before payload hooks", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  let payloadHooks = 0;
  let transportRequests = 0;
  harness.runtime.transport.request = async function* () {
    transportRequests += 1;
    yield* textEvents("unexpected");
  };

  const streamMessage = await harness.runtime
    .stream(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        sessionId: "session-1",
        onPayload(payload) {
          payloadHooks += 1;
          return payload;
        },
      },
    )
    .result();
  assert.equal(streamMessage.stopReason, "error");
  assert.match(streamMessage.errorMessage ?? "", /No API key for provider: openai-codex/);

  await assert.rejects(
    harness.runtime.compact({
      model: codexModel(),
      requestOptions: {
        apiKey: "invalid-token",
        sessionId: "session-1",
        onPayload(payload) {
          payloadHooks += 1;
          return payload;
        },
      },
      history: [],
      instructions: "Compact",
      grammarToolInputProperties: new Map(),
      template: {},
      priority: false,
      compactionMetadata: MANUAL_COMPACTION_METADATA,
      compactionDecision: { reason: "manual", willRetry: false },
    }),
    /Failed to extract accountId from token/,
  );
  assert.equal(payloadHooks, 0);
  assert.equal(transportRequests, 0);
});

void test("discards WebSockets when compaction response validation fails", async () => {
  const harness = createHarness([userEntry("user-1", "hello")]);
  let reportedFailure: unknown;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    options.onWebSocketResponseHandle?.({
      discard() {
        return true;
      },
      failParsing(error) {
        reportedFailure = error;
        return true;
      },
    });
    yield {
      type: "response.completed",
      response: { id: "response-without-compaction", status: "completed" },
    };
  };

  await assert.rejects(
    harness.runtime.compact({
      model: codexModel(),
      requestOptions: {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "websocket-cached",
      },
      history: [],
      instructions: "Compact",
      grammarToolInputProperties: new Map(),
      template: {},
      priority: false,
      compactionMetadata: MANUAL_COMPACTION_METADATA,
      compactionDecision: { reason: "manual", willRetry: false },
    }),
    /exactly one is required/,
  );
  assert.ok(reportedFailure instanceof Error);
  assert.match(reportedFailure.message, /exactly one is required/);
});

void test("advances Codex window metadata after successful direct compaction", async () => {
  const user = userEntry("user-1", "continue");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    if (requests.length === 1) yield* compactionEvents();
    else yield* textEvents("continued", "resp_continued");
  };

  await harness.runtime.compact({
    model: codexModel(),
    requestOptions: {
      apiKey: accessToken(),
      sessionId: "session-1",
      transport: "sse",
    },
    history: [],
    instructions: "Compact",
    grammarToolInputProperties: new Map(),
    template: {},
    priority: false,
    compactionMetadata: MANUAL_COMPACTION_METADATA,
    compactionDecision: { reason: "manual", willRetry: false },
  });
  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  const compactMetadata = requests[0]?.["client_metadata"] as JsonRecord;
  const turnMetadata = requests[1]?.["client_metadata"] as JsonRecord;
  assert.equal(compactMetadata["x-codex-window-id"], "session-1:0");
  assert.equal(turnMetadata["x-codex-window-id"], "session-1:1");
});

void test("prices unsuccessful terminal usage before returning the provider error", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.incomplete",
      response: {
        id: "response-filtered",
        status: "incomplete",
        service_tier: "default",
        incomplete_details: { reason: "content_filter" },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  };

  const message = await harness.runtime
    .stream(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        serviceTier: "priority",
      },
    )
    .result();

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Response incomplete: content_filter");
  assert.equal(message.usage.totalTokens, 0);
  assert.ok(Math.abs(message.usage.cost.input - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.output - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.total - 0.00004) < 1e-12);
});

void test("matches Pi AI's fallback message for terminal failures without details", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.completed",
      response: {
        id: "response-failed",
        status: "failed",
      },
    };
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      { apiKey: accessToken() },
    )
    .result();

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "An unknown error occurred");
});
