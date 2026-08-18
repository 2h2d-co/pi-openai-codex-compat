import { requireJsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  Type,
  DEFAULT_CONFIG,
  codexModel,
  userEntry,
  textEvents,
  accessToken,
  createHarness,
  type Tool,
  type JsonRecord,
  type CodexTransportDiagnostic,
} from "./codex-provider-harness.ts";

void test("commits canonical assistant items for WebSocket continuation", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  let replayItems: readonly JsonRecord[] | undefined;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    yield* textEvents("hello back");
    options.onContinuationReady?.({
      responseId: "resp_text",
      replaceResponseItems(items) {
        replayItems = structuredClone(items);
        return true;
      },
    });
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "websocket-cached",
      },
    )
    .result();

  assert.equal(
    JSON.stringify(replayItems),
    JSON.stringify([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello back", annotations: [] }],
        status: "completed",
        id: "msg_text",
      },
    ]),
  );
});

void test("preserves flat default tool calls in Responses Lite continuations", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user], {
    ...DEFAULT_CONFIG,
    responsesLite: true,
  });
  let replayItems: readonly JsonRecord[] | undefined;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    yield { type: "response.created", response: { id: "resp_tool" } };
    yield {
      type: "response.output_item.done",
      item: {
        id: "fc_report",
        type: "function_call",
        status: "completed",
        call_id: "call_report",
        name: "report",
        arguments: "{}",
      },
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
    options.onContinuationReady?.({
      responseId: "resp_tool",
      replaceResponseItems(items) {
        replayItems = structuredClone(items);
        return true;
      },
    });
  };

  const tool = {
    name: "report",
    description: "Report",
    parameters: Type.Object({}),
  } satisfies Tool;
  const message = await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        messages: [user.message],
        tools: [tool],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "websocket-cached",
      },
    )
    .result();

  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(replayItems, [
    {
      type: "function_call",
      id: "fc_report",
      call_id: "call_report",
      name: "report",
      arguments: "{}",
    },
  ]);
  assert.equal(harness.customEntries.length, 0);
});

void test("honors disabled cache retention when building provider payloads", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-with-cache-disabled",
        cacheRetention: "none",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests[0]?.prompt_cache_key, undefined);
});

void test("retains recovered transport diagnostics on assistant messages", async () => {
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
    yield* textEvents("hello back");
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "auto",
      },
    )
    .result();

  assert.deepEqual(message.diagnostics, [diagnostic]);
});

void test("persists transparent Codex recovery diagnostics on successful assistants", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const diagnostic: CodexTransportDiagnostic = {
    type: "codex_transport_recovery",
    timestamp: Date.now(),
    details: {
      trigger: "previous_response_not_found",
      configuredTransport: "auto",
      previousResponseId: "response-previous",
      cacheIdentity: {
        promptCacheKey: "session-1",
        sessionHeader: "session-1",
        threadHeader: "session-1",
        clientRequestHeader: "session-1",
        routingHint: null,
        accountId: "account-1",
      },
      attempts: [
        {
          transport: "websocket",
          connection: "reused",
          contextMode: "delta",
          inputItems: 1,
          fullInputItems: 3,
          fullRequestBytes: 300,
          wireRequestBytes: 100,
          outcome: "previous_response_not_found",
        },
        {
          transport: "websocket",
          connection: "new",
          contextMode: "full",
          inputItems: 3,
          fullInputItems: 3,
          fullRequestBytes: 300,
          wireRequestBytes: 300,
          outcome: "retry_scheduled",
        },
      ],
      cacheAffinityEnabled: true,
      cacheIdentityPreserved: true,
      promptKeyAndHeaderAligned: true,
      accountIdentityPreserved: true,
    },
  };
  harness.runtime.transport.request = async function* (_model, _body, options) {
    options.onTransportDiagnostic?.(diagnostic);
    yield* textEvents("hello back");
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "auto",
      },
    )
    .result();

  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.diagnostics, [diagnostic]);
});
