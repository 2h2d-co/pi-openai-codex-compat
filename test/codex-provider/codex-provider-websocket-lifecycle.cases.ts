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
  createHarness,
  type Context,
} from "./codex-provider-harness.ts";

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
    messages: [user.message as Context["messages"][number]],
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
  const context: Context = { messages: [user.message as Context["messages"][number]] };

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
