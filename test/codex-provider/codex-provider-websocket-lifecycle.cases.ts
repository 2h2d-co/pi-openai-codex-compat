import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  Type,
  getOpenAICodexWebSocketDebugStats,
  codexModel,
  userEntry,
  textEvents,
  responseDecisions,
  accessToken,
  appendToolExchange,
  createHarness,
  DEFAULT_CONFIG,
  REPORT_TOOL,
  type Context,
  type JsonRecord,
} from "./codex-provider-harness.ts";

void test("recovers an age-limited turn from done items while discarding provisional output", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const committedItem = {
    type: "message",
    id: "message-committed",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "committed before reconnect", annotations: [] }],
  };
  let connections = 0;

  class AgeLimitedTextWebSocket {
    readyState = 1;
    private readonly connectionId = ++connections;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      queueMicrotask(() => this.dispatch("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      const parsed: unknown = JSON.parse(data);
      sentBodies.push(requireJsonRecord(parsed));
      const responseEvents =
        this.connectionId === 1
          ? [
              { type: "response.created", response: { id: "response-age-limited" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...committedItem, status: "in_progress", content: [] },
              },
              {
                type: "response.content_part.added",
                output_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "committed before reconnect",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: committedItem,
              },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "message",
                  id: "message-provisional",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              },
              {
                type: "response.content_part.added",
                output_index: 1,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 1,
                delta: "discard this provisional text",
              },
              {
                type: "error",
                error: {
                  code: "websocket_connection_limit_reached",
                  message:
                    "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
                },
              },
            ]
          : textEvents("recovered after reconnect", "response-recovered");
      queueMicrotask(() => {
        for (const event of responseEvents) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: AgeLimitedTextWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const sessionId = "provider-age-limited-text";
  const user = userEntry("user-1", "continue through the reconnect");
  const harness = createHarness([user], DEFAULT_CONFIG, sessionId, {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  t.after(() => harness.runtime.transport.close(sessionId));

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId,
        transport: "websocket-cached",
      },
    )
    .result();

  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(connections, 2);
  assert.equal(sentBodies.length, 2);
  assert.deepEqual(
    message.content.filter((block) => block.type === "text").map((block) => block.text),
    ["committed before reconnect", "recovered after reconnect"],
  );
  assert.doesNotMatch(JSON.stringify(message.content), /discard this provisional text/);

  const firstBody = sentBodies[0];
  const secondBody = sentBodies[1];
  assert.ok(firstBody);
  assert.ok(secondBody);
  const firstInput = requireJsonRecords(firstBody.input);
  const secondInput = requireJsonRecords(secondBody.input);
  assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput);
  assert.deepEqual(secondInput.slice(firstInput.length), [committedItem]);
  assert.equal(secondBody.previous_response_id, undefined);
  assert.doesNotMatch(JSON.stringify(secondBody), /discard this provisional text/);

  const decisions = responseDecisions(message);
  assert.equal(decisions[0]?.["terminalType"], "websocket_connection_limit_reached");
  assert.equal(decisions[0]?.["decision"], "continue_no_tools");
  assert.equal(decisions[1]?.["decision"], "return_terminal");
});

void test("defers done tool calls across an age-limit reconnect until Pi records output", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const doneCall = {
    type: "function_call",
    id: "function-complete",
    call_id: "call-complete",
    name: "report",
    status: "completed",
    arguments: '{"value":"complete"}',
  };
  let connections = 0;

  class AgeLimitedToolWebSocket {
    readyState = 1;
    private readonly connectionId = ++connections;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      queueMicrotask(() => this.dispatch("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      const parsed: unknown = JSON.parse(data);
      sentBodies.push(requireJsonRecord(parsed));
      const responseEvents =
        this.connectionId === 1
          ? [
              { type: "response.created", response: { id: "response-tool-age-limited" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...doneCall, status: "in_progress", arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: doneCall.arguments,
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: doneCall,
              },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "function-partial",
                  call_id: "call-partial",
                  name: "report",
                  status: "in_progress",
                  arguments: "",
                },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                delta: '{"value":',
              },
              {
                type: "error",
                error: {
                  code: "websocket_connection_limit_reached",
                  message:
                    "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
                },
              },
            ]
          : textEvents("continued after tool output", "response-after-tool");
      queueMicrotask(() => {
        for (const event of responseEvents) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: AgeLimitedToolWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const sessionId = "provider-age-limited-tool";
  const user = userEntry("user-1", "call the tool and continue");
  const harness = createHarness([user], DEFAULT_CONFIG, sessionId, {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  t.after(() => harness.runtime.transport.close(sessionId));
  const firstContext: Context = {
    messages: [user.message],
    tools: [REPORT_TOOL],
  };

  const toolMessage = await harness.runtime
    .streamSimple(codexModel(), firstContext, {
      apiKey: accessToken(),
      sessionId,
      transport: "websocket-cached",
    })
    .result();

  assert.equal(toolMessage.stopReason, "toolUse", toolMessage.errorMessage);
  assert.deepEqual(
    toolMessage.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({ id: block.id, arguments: block.arguments })),
    [{ id: "call-complete|function-complete", arguments: { value: "complete" } }],
  );
  assert.doesNotMatch(JSON.stringify(toolMessage.content), /call-partial/);
  const toolDecision = responseDecisions(toolMessage)[0];
  assert.equal(toolDecision?.["terminalType"], "websocket_connection_limit_reached");
  assert.equal(toolDecision?.["postToolDisposition"], "retry");
  assert.equal(toolDecision?.["discardedPartialCalls"], 1);

  const toolResult = appendToolExchange(harness, toolMessage);
  const continued = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message, toolMessage, toolResult],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId,
        transport: "websocket-cached",
      },
    )
    .result();

  assert.equal(continued.stopReason, "stop", continued.errorMessage);
  assert.equal(
    continued.content.find((block) => block.type === "text")?.text,
    "continued after tool output",
  );
  assert.equal(connections, 2);
  assert.equal(sentBodies.length, 2);
  const retryBody = sentBodies[1];
  assert.ok(retryBody);
  assert.equal(retryBody.previous_response_id, undefined);
  const retryInput = requireJsonRecords(retryBody.input);
  assert.equal(retryInput.filter((item) => item.type === "function_call").length, 1);
  assert.equal(retryInput.filter((item) => item.type === "function_call_output").length, 1);
  assert.match(JSON.stringify(retryInput), /call-complete/);
  assert.doesNotMatch(JSON.stringify(retryInput), /call-partial/);
});

void test("discards downstream-failed WebSockets without activating SSE fallback", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const closedConnections = new Set<number>();
  let connections = 0;
  let fetchRequests = 0;

  class ResponseFailureWebSocket {
    readyState = 1;
    private readonly connectionId = ++connections;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      queueMicrotask(() => this.dispatch("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(): void {
      const responseEvents =
        this.connectionId === 1
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "custom_tool_call",
                  id: "ctc_invalid",
                  call_id: "call_invalid",
                  name: "sample_tool",
                  input: "",
                },
              },
              {
                type: "response.custom_tool_call_input.delta",
                output_index: 0,
                delta: "abc",
              },
              {
                type: "response.custom_tool_call_input.done",
                output_index: 0,
                input: "ab",
              },
            ]
          : this.connectionId === 2
            ? [
                {
                  type: "response.incomplete",
                  response: {
                    id: "response-filtered",
                    status: "incomplete",
                    incomplete_details: { reason: "content_filter" },
                  },
                },
              ]
            : textEvents("recovered", "response-recovered");
      queueMicrotask(() => {
        for (const event of responseEvents) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
      closedConnections.add(this.connectionId);
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: ResponseFailureWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const context: Context = {
    messages: [user.message],
    tools: [
      {
        name: "sample_tool",
        description: "Sample tool",
        parameters: Type.Object({ payload: Type.String() }),
        constrainedSampling: {
          type: "grammar",
          variants: { openai_lark: "start: /[a-z]+/" },
        },
      },
    ],
  };
  const requestOptions = {
    apiKey: accessToken(),
    sessionId: "downstream-failure-session",
    transport: "websocket-cached" as const,
    fetch: async () => {
      fetchRequests += 1;
      throw new Error("SSE fallback should not be used");
    },
  };

  const parserFailure = await harness.runtime
    .streamSimple(codexModel(), context, requestOptions)
    .result();
  assert.equal(parserFailure.stopReason, "error");
  assert.match(parserFailure.errorMessage ?? "", /changed non-monotonically/);
  assert.equal(parserFailure.diagnostics?.length, 1);
  assert.equal(parserFailure.diagnostics?.[0]?.type, "provider_transport_failure");
  assert.equal(parserFailure.diagnostics?.[0]?.details?.["eventsEmitted"], true);

  const terminalFailure = await harness.runtime
    .streamSimple(codexModel(), context, requestOptions)
    .result();
  assert.equal(terminalFailure.stopReason, "error");
  assert.equal(terminalFailure.errorMessage, "Response incomplete: content_filter");
  assert.deepEqual(
    terminalFailure.diagnostics?.map((diagnostic) => diagnostic.type),
    ["codex_transport_request", "codex_response_decision"],
  );
  assert.equal(responseDecisions(terminalFailure)[0]?.["decision"], "return_terminal");

  const recovered = await harness.runtime
    .streamSimple(codexModel(), context, requestOptions)
    .result();
  assert.equal(recovered.stopReason, "stop");
  assert.equal(recovered.content.find((block) => block.type === "text")?.text, "recovered");

  assert.equal(connections, 3);
  assert.equal(fetchRequests, 0);
  assert.equal(closedConnections.has(1), true);
  assert.equal(closedConnections.has(2), true);
  assert.deepEqual(getOpenAICodexWebSocketDebugStats("downstream-failure-session"), {
    requests: 3,
    connectionsCreated: 3,
    connectionsReused: 0,
    cachedContextRequests: 3,
    storeTrueRequests: 0,
    fullContextRequests: 3,
    deltaRequests: 0,
    lastInputItems: 1,
    websocketFailures: 0,
    sseFallbacks: 0,
    prewarmRequests: 0,
  });
  harness.runtime.transport.close("downstream-failure-session");
});

void test("honors aborts after terminal processing and while waiting for a session request", async () => {
  const user = userEntry("user-1", "hello");
  const context: Context = { messages: [user.message] };

  const terminalHarness = createHarness([user]);
  const terminalAbort = new AbortController();
  terminalHarness.runtime.transport.request = async function* () {
    yield* textEvents("finished");
    terminalAbort.abort();
  };
  const terminalMessage = await terminalHarness.runtime
    .streamSimple(codexModel(), context, {
      apiKey: accessToken(),
      sessionId: "session-1",
      signal: terminalAbort.signal,
    })
    .result();
  assert.equal(terminalMessage.stopReason, "aborted");

  const queuedHarness = createHarness([user]);
  let startFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    startFirst = resolve;
  });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let requests = 0;
  queuedHarness.runtime.transport.request = async function* () {
    requests += 1;
    if (requests === 1) {
      startFirst();
      await firstReleased;
    }
    yield* textEvents("finished");
  };

  const first = queuedHarness.runtime.streamSimple(codexModel(), context, {
    apiKey: accessToken(),
    sessionId: "session-1",
  });
  await firstStarted;

  const queuedAbort = new AbortController();
  const second = queuedHarness.runtime.streamSimple(codexModel(), context, {
    apiKey: accessToken(),
    sessionId: "session-1",
    signal: queuedAbort.signal,
  });
  queuedAbort.abort();
  try {
    const queuedMessage = await Promise.race([
      second.result(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("queued abort did not settle promptly")), 250);
      }),
    ]);
    assert.equal(queuedMessage.stopReason, "aborted");
    assert.equal(requests, 1);
  } finally {
    releaseFirst();
  }
  assert.equal((await first.result()).stopReason, "stop");
});
