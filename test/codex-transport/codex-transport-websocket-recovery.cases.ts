import {
  assert,
  test,
  CODEX_WS_REQUEST_START_METADATA_KEY,
  closeOpenAICodexWebSocketSessions,
  CodexTransport,
  CodexTurnState,
  codexModel,
  accessToken,
  transportFailure,
  transportRecovery,
  type CodexTransportDiagnostic,
  type CodexTransportFailureDiagnostic,
  type JsonRecord,
} from "./codex-transport-harness.ts";

void test("reports WebSocket close details and preserves preceding errors", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let failureMode: "close" | "error-then-close" = "close";

  class FailingWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      queueMicrotask(() => this.emit("open", {}));
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
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ type: "response.created", response: { id: "response-1" } }),
        });
        this.emit("message", {
          data: JSON.stringify({
            type: "response.output_item.added",
            item: { type: "message", role: "assistant", content: [] },
          }),
        });
        setTimeout(() => {
          if (failureMode === "error-then-close") {
            this.emit("error", { message: "underlying socket failure" });
          }
          this.readyState = 3;
          this.emit("close", { code: 1_006, reason: "connection lost", wasClean: false });
        }, 0);
      });
    }

    close(): void {
      this.readyState = 3;
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FailingWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const transport = new CodexTransport();
  const options = {
    apiKey: accessToken(),
    transport: "websocket" as const,
    websocketMaxRetries: 0,
  };
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
        // Consume the stream so its transport error is observed.
      }
    },
    {
      name: "WebSocketCloseError",
      message: "WebSocket closed (code 1006, reason: connection lost, wasClean: false)",
    },
  );

  failureMode = "error-then-close";
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
        // Consume the stream so its transport error is observed.
      }
    },
    { message: "underlying socket failure" },
  );
});

void test("stops WebSocket delivery at the terminal response event", async (t) => {
  const previousWebSocket = globalThis.WebSocket;

  class TerminalWebSocket {
    readonly readyState = 1;
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
      queueMicrotask(() => {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: "response-terminal", status: "completed" },
          }),
        });
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.output_text.delta",
            output_index: 0,
            delta: "late",
          }),
        });
      });
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TerminalWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      cacheRetention: "none",
      transport: "websocket",
    },
  )) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "response.completed",
      response: { id: "response-terminal", status: "completed" },
    },
  ]);
});

void test("ignores type-less WebSocket events before selecting SSE fallback", async (t) => {
  const previousWebSocket = globalThis.WebSocket;

  class TypelessWebSocket {
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
      queueMicrotask(() => this.dispatch("message", { data: "{}" }));
      setTimeout(() => this.dispatch("error", { message: "socket failed" }), 0);
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TypelessWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  let starts = 0;
  const diagnostics: CodexTransportDiagnostic[] = [];
  const terminal = {
    type: "response.completed",
    response: { id: "response-sse", status: "completed" },
  };
  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "websocket",
      websocketMaxRetries: 0,
      onTransportStart() {
        starts += 1;
      },
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      fetch: async () =>
        new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    },
  )) {
    events.push(event);
  }

  assert.deepEqual(events, [terminal]);
  assert.equal(starts, 1);
  assert.equal(diagnostics.length, 2);
  const failure = transportFailure(diagnostics[0]);
  assert.equal(failure.details.eventsEmitted, false);
  assert.equal(failure.details.fallbackTransport, "sse");
  const recovery = transportRecovery(diagnostics[1]);
  assert.equal(recovery.details.trigger, "sse_after_websocket_failure");
  assert.equal(recovery.details.attempts[0]?.transport, "sse");
  assert.equal(recovery.details.cacheIdentityPreserved, false);
});

void test("matches Pi AI's recovered WebSocket failure diagnostics", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const terminal = {
    type: "response.completed",
    response: { id: "response-sse", status: "completed" },
  };
  const request = async (): Promise<CodexTransportFailureDiagnostic> => {
    const diagnostics: CodexTransportDiagnostic[] = [];
    for await (const _event of new CodexTransport().request(
      codexModel(),
      { input: [] },
      {
        apiKey: accessToken(),
        transport: "websocket",
        websocketMaxRetries: 0,
        onTransportDiagnostic(diagnostic) {
          diagnostics.push(diagnostic);
        },
        fetch: async () =>
          new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      },
    )) {
      // Consume the SSE recovery response.
    }
    assert.equal(diagnostics.length, 2);
    assert.equal(transportRecovery(diagnostics[1]).details.trigger, "sse_after_websocket_failure");
    return transportFailure(diagnostics[0]);
  };

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  const unavailable = await request();
  assert.equal(unavailable.error.message, "WebSocket transport is not available in this runtime");

  class ThrowingWebSocket {
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
      throw "socket send failed";
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: ThrowingWebSocket,
  });
  const thrownValue = await request();
  assert.deepEqual(thrownValue.error, {
    name: "ThrownValue",
    message: "socket send failed",
  });
});

void test("retries fresh WebSockets before selecting SSE fallback", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let connections = 0;
  let sseRequests = 0;
  const diagnostics: CodexTransportDiagnostic[] = [];

  class RetryingWebSocket {
    readonly readyState = 1;
    private readonly connection = ++connections;
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
      queueMicrotask(() => {
        if (this.connection < 3) {
          this.dispatch("error", { message: `socket failure ${String(this.connection)}` });
          return;
        }
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: "response-retried", status: "completed" },
          }),
        });
      });
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: RetryingWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      sessionId: "retry-session",
      transport: "websocket-cached",
      websocketMaxRetries: 5,
      websocketRetryBaseDelayMs: 0,
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      fetch: async () => {
        sseRequests += 1;
        throw new Error("SSE should not be selected");
      },
    },
  )) {
    events.push(event);
  }

  assert.equal(connections, 3);
  assert.equal(sseRequests, 0);
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      diagnostic.type === "codex_transport_recovery"
        ? [
            diagnostic.details.trigger,
            diagnostic.details.retryNumber,
            diagnostic.details.maxRetries,
          ]
        : diagnostic.type,
    ),
    [
      ["websocket_retry", 1, 5],
      ["websocket_retry", 2, 5],
    ],
  );
  closeOpenAICodexWebSocketSessions("retry-session");
});

void test("replays WebSocket turn state on a fresh retry after metadata", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const turnState = new CodexTurnState();
  const sentBodies: JsonRecord[] = [];
  const handshakeHeaders: Headers[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];
  let connections = 0;

  class TurnStateRetryWebSocket {
    readonly readyState = 1;
    private readonly connection = ++connections;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(_url: string, options?: { headers?: Record<string, string> }) {
      handshakeHeaders.push(new Headers(options?.headers));
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
      sentBodies.push(JSON.parse(data) as JsonRecord);
      if (this.connection === 1) {
        queueMicrotask(() => {
          this.dispatch("message", {
            data: JSON.stringify({
              type: "response.metadata",
              headers: { "X-Codex-Turn-State": "opaque-ws-state" },
            }),
          });
          setTimeout(() => this.dispatch("error", new Error("socket reset")), 0);
        });
        return;
      }
      queueMicrotask(() => {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: "response-retried", status: "completed" },
          }),
        });
      });
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TurnStateRetryWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const events: JsonRecord[] = [];
  const body = {
    model: "gpt-5.6-sol",
    input: [],
    client_metadata: {
      "x-codex-installation-id": "installation-1",
      "x-codex-window-id": "turn-state-retry:0",
      thread_id: "turn-state-retry",
      ws_request_header_x_openai_internal_codex_responses_lite: "true",
    },
  };
  for await (const event of new CodexTransport().request(codexModel(), body, {
    apiKey: accessToken(),
    sessionId: "turn-state-retry",
    transport: "websocket-cached",
    turnState,
    websocketMaxRetries: 1,
    websocketRetryBaseDelayMs: 0,
    onTransportDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    fetch: async () => {
      throw new Error("SSE should not be selected");
    },
  })) {
    events.push(event);
  }

  assert.equal(connections, 2);
  assert.equal(sentBodies.length, 2);
  const firstBody = sentBodies[0];
  const secondBody = sentBodies[1];
  assert.ok(firstBody);
  assert.ok(secondBody);
  assert.equal((firstBody["client_metadata"] as JsonRecord)["x-codex-turn-state"], undefined);
  assert.equal(
    (secondBody["client_metadata"] as JsonRecord)["x-codex-turn-state"],
    "opaque-ws-state",
  );
  assert.equal(
    (firstBody["client_metadata"] as JsonRecord)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ],
    "true",
  );
  assert.equal(
    (secondBody["client_metadata"] as JsonRecord)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ],
    "true",
  );
  assert.match(
    String((firstBody["client_metadata"] as JsonRecord)[CODEX_WS_REQUEST_START_METADATA_KEY]),
    /^\d+$/,
  );
  assert.match(
    String((secondBody["client_metadata"] as JsonRecord)[CODEX_WS_REQUEST_START_METADATA_KEY]),
    /^\d+$/,
  );
  assert.equal(handshakeHeaders[0]?.get("x-openai-internal-codex-responses-lite"), null);
  assert.equal(handshakeHeaders[0]?.get("x-codex-routing-hint"), "model=gpt-5.6-sol");
  assert.equal(events.at(-1)?.type, "response.completed");
  const recovery = diagnostics.find((diagnostic) => diagnostic.type === "codex_transport_recovery");
  assert.equal(recovery?.details.attempts[0]?.turnStateReplayed, false);
  assert.equal(recovery?.details.cacheIdentity.installationId, "installation-1");
  assert.equal(recovery?.details.cacheIdentity.windowId, "turn-state-retry:0");
  assert.equal(recovery?.details.cacheIdentity.routingHint, "model=gpt-5.6-sol");
  const selected = diagnostics.find((diagnostic) => diagnostic.type === "codex_transport_request");
  assert.equal(selected?.details.turnStateAvailableAtStart, false);
  assert.equal(selected?.details.turnStateReplayed, true);
  assert.equal(selected?.details.turnStateReceived, true);
  assert.equal(selected?.details.sessionId, "turn-state-retry");
  assert.equal(selected?.details.accountId, "account-1");
  assert.equal(selected?.details.responseId, "response-retried");
  assert.equal(selected?.details.turnStateReplayedValue, "opaque-ws-state");
  assert.equal(selected?.details.turnStateReceivedValue, "opaque-ws-state");
  assert.match(JSON.stringify(diagnostics), /opaque-ws-state/);
  closeOpenAICodexWebSocketSessions("turn-state-retry");
});

void test("replays WebSocket turn state on SSE fallback", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const turnState = new CodexTurnState();
  let sseHeaders: Headers | undefined;

  class TurnStateFallbackWebSocket {
    readonly readyState = 1;
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
      queueMicrotask(() => {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.metadata",
            headers: { "x-codex-turn-state": "opaque-fallback-state" },
          }),
        });
        setTimeout(() => this.dispatch("error", new Error("socket reset")), 0);
      });
    }

    close(): void {}

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TurnStateFallbackWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-fallback", status: "completed" },
  })}\n\n`;
  for await (const _event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      sessionId: "turn-state-fallback",
      transport: "websocket-cached",
      turnState,
      websocketMaxRetries: 0,
      fetch: async (_input, init) => {
        sseHeaders = new Headers(init?.headers);
        return new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the recovered response.
  }

  assert.equal(sseHeaders?.get("x-codex-turn-state"), "opaque-fallback-state");
  closeOpenAICodexWebSocketSessions("turn-state-fallback");
});
