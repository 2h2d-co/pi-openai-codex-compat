import { requireJsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { hasObjectType } from "../../extensions/openai-codex-compat/value-contracts.ts";
import {
  assert,
  test,
  CodexTransport,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  codexModel,
  accessToken,
  transportFailure,
  transportRecovery,
  type CodexTransportDiagnostic,
  type JsonRecord,
} from "./codex-transport-harness.ts";

test("uses UUIDv7 for empty session IDs and WebSocket connection-limit retries", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let connections = 0;
  const requestIds: string[] = [];

  class ConnectionLimitWebSocket {
    readyState = 1;
    private readonly limited: boolean;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(
      _url: string,
      protocols?: string | string[] | { headers?: Record<string, string> },
    ) {
      const headers =
        protocols && hasObjectType(protocols) && !Array.isArray(protocols)
          ? protocols.headers
          : undefined;
      requestIds.push(headers?.["session-id"] ?? "");
      this.limited = connections++ === 0;
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
      const event = this.limited
        ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
        : {
            type: "response.completed",
            response: { id: "response-1", status: "completed" },
          };
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(event) }));
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
    value: ConnectionLimitWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    { apiKey: accessToken(), sessionId: "", transport: "websocket" },
  )) {
    events.push(event);
  }

  assert.equal(connections, 2);
  assert.equal(requestIds[0], requestIds[1]);
  assert.match(
    requestIds[0] ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("reconnects an expired cached WebSocket after lifecycle events without surfacing the limit", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  let connections = 0;

  class ExpiringWebSocket {
    readyState = 1;
    private readonly connection = ++connections;
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

    send(data: string): void {
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
      const events =
        this.connection === 1 && sentBodies.length === 1
          ? [
              {
                type: "response.output_item.done",
                output_index: 0,
                item: firstAssistant,
              },
              {
                type: "response.completed",
                response: { id: "response-1", status: "completed" },
              },
            ]
          : this.connection === 1
            ? [
                { type: "response.created", response: { id: "response-expired" } },
                { type: "response.in_progress", response: { id: "response-expired" } },
                {
                  type: "error",
                  error: {
                    code: "websocket_connection_limit_reached",
                    message:
                      "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
                  },
                },
              ]
            : [
                {
                  type: "response.completed",
                  response: { id: "response-2", status: "completed" },
                },
              ];
      queueMicrotask(() => {
        for (const event of events) this.emit("message", { data: JSON.stringify(event) });
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
    value: ExpiringWebSocket,
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
    sessionId: "expired-connection-session",
    transport: "websocket-cached" as const,
  };
  const firstUser = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const firstAssistant = {
    type: "message",
    id: "message-1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "first" }],
  };
  const secondUser = { role: "user", content: [{ type: "input_text", text: "second" }] };

  for await (const _event of transport.request(codexModel(), { input: [firstUser] }, options)) {
    // Establish continuation state on the cached WebSocket.
  }

  const events: JsonRecord[] = [];
  for await (const event of transport.request(
    codexModel(),
    { input: [firstUser, firstAssistant, secondUser] },
    options,
  )) {
    events.push(event);
  }

  assert.equal(connections, 2);
  assert.equal(sentBodies.length, 3);
  assert.equal(sentBodies[1]?.previous_response_id, "response-1");
  assert.deepEqual(sentBodies[1]?.input, [secondUser]);
  assert.equal(sentBodies[2]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[2]?.input, [firstUser, firstAssistant, secondUser]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.created", "response.in_progress", "response.completed"],
  );
  transport.close("expired-connection-session");
});

test("does not mask malformed WebSocket events with SSE fallback", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let fetches = 0;

  class MalformedWebSocket {
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
      queueMicrotask(() => this.emit("message", { data: "{not-json" }));
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
    value: MalformedWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "auto",
          fetch: async () => {
            fetches += 1;
            return new Response();
          },
        },
      )) {
        // Protocol errors fail instead of duplicating the request over SSE.
      }
    },
    {
      name: "CodexProtocolError",
      message: /Invalid Codex WebSocket JSON/,
    },
  );
  assert.equal(fetches, 0);
});

test("recovers when a cached WebSocket continuation expires", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];
  let connections = 0;

  class MissingContinuationWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
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

    send(data: string): void {
      const body = requireJsonRecord(JSON.parse(data));
      sentBodies.push(body);
      const events =
        sentBodies.length === 2
          ? [
              {
                type: "error",
                error: {
                  code: "previous_response_not_found",
                  message: "Previous response expired.",
                },
              },
            ]
          : sentBodies.length === 1
            ? [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "message-1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "first" }],
                  },
                },
                {
                  type: "response.completed",
                  response: { id: "response-1", status: "completed" },
                },
              ]
            : [
                {
                  type: "response.completed",
                  response: { id: "response-2", status: "completed" },
                },
              ];
      queueMicrotask(() => {
        for (const event of events) this.emit("message", { data: JSON.stringify(event) });
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
    value: MissingContinuationWebSocket,
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
    sessionId: "continuation-session",
    transport: "websocket-cached" as const,
    onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
      diagnostics.push(diagnostic);
    },
  };
  const firstUser = { role: "user", content: [{ type: "input_text", text: "first" }] };
  const firstAssistant = {
    type: "message",
    id: "message-1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "first" }],
  };
  const secondUser = { role: "user", content: [{ type: "input_text", text: "second" }] };

  for await (const _event of transport.request(
    codexModel(),
    { input: [firstUser], prompt_cache_key: "continuation-session" },
    options,
  )) {
    // Establish the cached continuation.
  }
  for await (const _event of transport.request(
    codexModel(),
    {
      input: [firstUser, firstAssistant, secondUser],
      prompt_cache_key: "continuation-session",
    },
    options,
  )) {
    // Recover the expired continuation with full history.
  }

  assert.equal(connections, 2);
  assert.equal(sentBodies.length, 3);
  assert.equal(sentBodies[1]?.previous_response_id, "response-1");
  assert.deepEqual(sentBodies[1]?.input, [secondUser]);
  assert.equal(sentBodies[2]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[2]?.input, [firstUser, firstAssistant, secondUser]);
  assert.equal(diagnostics.length, 1);
  const recovery = transportRecovery(diagnostics[0]);
  assert.equal(recovery.details.trigger, "previous_response_not_found");
  assert.equal(recovery.details.previousResponseId, "response-1");
  assert.equal(recovery.details.cacheAffinityEnabled, true);
  assert.equal(recovery.details.cacheIdentityPreserved, true);
  assert.equal(recovery.details.promptKeyAndHeaderAligned, true);
  assert.deepEqual(
    recovery.details.attempts.map((attempt) => ({
      transport: attempt.transport,
      connection: attempt.connection,
      contextMode: attempt.contextMode,
      inputItems: attempt.inputItems,
      fullInputItems: attempt.fullInputItems,
      outcome: attempt.outcome,
    })),
    [
      {
        transport: "websocket",
        connection: "reused",
        contextMode: "delta",
        inputItems: 1,
        fullInputItems: 3,
        outcome: "previous_response_not_found",
      },
      {
        transport: "websocket",
        connection: "new",
        contextMode: "full",
        inputItems: 3,
        fullInputItems: 3,
        outcome: "retry_scheduled",
      },
    ],
  );
  transport.close("continuation-session");
});

test("rejects a pre-aborted request before reusing a cached WebSocket", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let sends = 0;

  class AbortWebSocket {
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
      sends += 1;
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: `response-${sends}`, status: "completed" },
          }),
        });
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
    value: AbortWebSocket,
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
    sessionId: "abort-session",
    transport: "websocket-cached" as const,
  };
  for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
    // Establish a reusable socket.
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(
        codexModel(),
        { input: [] },
        { ...options, signal: controller.signal },
      )) {
        // The request must fail before an event is sent.
      }
    },
    { message: "Request was aborted" },
  );
  assert.equal(sends, 1);
  transport.close("abort-session");
});

test("uses sticky SSE fallback after a midstream WebSocket failure", async (t) => {
  resetOpenAICodexWebSocketDebugStats("fallback-session");
  const previousWebSocket = globalThis.WebSocket;
  let connections = 0;
  let fetches = 0;
  const diagnostics: CodexTransportDiagnostic[] = [];

  class MidstreamFailureWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
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
            item: { type: "reasoning", id: "reasoning-1", summary: [] },
          }),
        });
        setTimeout(() => this.emit("error", { message: "socket failed after output started" }), 0);
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
    value: MidstreamFailureWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const fetcher: typeof fetch = async () => {
    fetches += 1;
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "response-2", status: "completed" },
      })}\n\n`,
      { status: 200 },
    );
  };
  const transport = new CodexTransport();
  const options = {
    apiKey: accessToken(),
    sessionId: "fallback-session",
    transport: "websocket-cached" as const,
    fetch: fetcher,
    onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
      diagnostics.push(diagnostic);
    },
  };

  await assert.rejects(
    async () => {
      for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
        // Observe the first event before the transport fails.
      }
    },
    { message: "socket failed after output started" },
  );
  for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
    // The failed session now uses SSE.
  }

  assert.equal(connections, 1);
  assert.equal(fetches, 1);
  assert.equal(diagnostics.length, 2);
  const failure = transportFailure(diagnostics[0]);
  assert.equal(failure.details.phase, "after_message_stream_start");
  assert.equal(failure.details.fallbackTransport, undefined);
  const recovery = transportRecovery(diagnostics[1]);
  assert.equal(recovery.details.trigger, "sticky_sse_after_websocket_failure");
  assert.equal(recovery.details.cacheIdentityPreserved, true);
  assert.equal(recovery.details.accountIdentityPreserved, true);
  assert.equal(recovery.details.attempts[0]?.transport, "sse");
  assert.deepEqual(getOpenAICodexWebSocketDebugStats("fallback-session"), {
    requests: 1,
    connectionsCreated: 1,
    connectionsReused: 0,
    cachedContextRequests: 1,
    storeTrueRequests: 0,
    fullContextRequests: 1,
    deltaRequests: 0,
    lastInputItems: 0,
    websocketFailures: 1,
    sseFallbacks: 1,
    prewarmRequests: 0,
    websocketFallbackActive: true,
    lastWebSocketError: "socket failed after output started",
  });
  resetOpenAICodexWebSocketDebugStats("fallback-session");
  assert.equal(getOpenAICodexWebSocketDebugStats("fallback-session"), undefined);
  transport.close("fallback-session");
});

test("scopes cached WebSockets to the authenticated account", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const connectedAccounts: string[] = [];
  const sentConnectionIds: number[] = [];

  class AccountWebSocket {
    readyState = 1;
    private readonly connectionId: number;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(
      _url: string,
      protocols?: string | string[] | { headers?: Record<string, string> },
    ) {
      this.connectionId = connectedAccounts.length + 1;
      const headers =
        protocols && hasObjectType(protocols) && !Array.isArray(protocols)
          ? protocols.headers
          : undefined;
      connectedAccounts.push(headers?.["chatgpt-account-id"] ?? "");
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
      sentConnectionIds.push(this.connectionId);
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: `response-${sentConnectionIds.length}`,
              status: "completed",
            },
          }),
        });
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
    value: AccountWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const transport = new CodexTransport();
  const request = async (accountId: string) => {
    for await (const _event of transport.request(
      codexModel(),
      { input: [] },
      {
        apiKey: accessToken(accountId),
        sessionId: "shared-session",
        transport: "websocket-cached",
      },
    )) {
      // Consume the response.
    }
  };

  await request("account-a");
  await request("account-b");
  await request("account-a");

  assert.deepEqual(connectedAccounts, ["account-a", "account-b"]);
  assert.deepEqual(sentConnectionIds, [1, 2, 1]);
  transport.close("shared-session");
});

test("reuses one WebSocket for compaction and continuation requests", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sent: JsonRecord[] = [];
  let connections = 0;

  class FakeWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
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

    send(data: string): void {
      const request = requireJsonRecord(JSON.parse(data));
      sent.push(request);
      const compacting =
        Array.isArray(request.input) &&
        request.input.some(
          (item) =>
            hasObjectType(item) &&
            item !== null &&
            !Array.isArray(item) &&
            requireJsonRecord(item).type === "compaction_trigger",
        );
      const events: JsonRecord[] = compacting
        ? [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_compact",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
            },
          ]
        : [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_done",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
            },
          ];
      queueMicrotask(() => {
        for (const event of events) {
          this.emit("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
      this.emit("close", { code: 1_000, wasClean: true });
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
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
    sessionId: "session-1",
    transport: "websocket-cached" as const,
  };
  const userItem = { role: "user", content: [{ type: "input_text", text: "hello" }] };
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };

  const firstEvents: JsonRecord[] = [];
  for await (const event of transport.request(codexModel(), { input: [userItem] }, options)) {
    firstEvents.push(event);
  }
  const compactEvents: JsonRecord[] = [];
  for await (const event of transport.request(
    codexModel(),
    { input: [userItem, messageItem, { type: "compaction_trigger" }] },
    options,
  )) {
    compactEvents.push(event);
  }
  const continuationEvents: JsonRecord[] = [];
  for await (const event of transport.request(
    codexModel(),
    { input: [{ type: "compaction", encrypted_content: "opaque" }] },
    options,
  )) {
    continuationEvents.push(event);
  }

  assert.equal(connections, 1);
  assert.equal(sent.length, 3);
  assert.equal(firstEvents.at(-1)?.type, "response.completed");
  assert.equal(sent[1]?.previous_response_id, "resp_done");
  assert.deepEqual(sent[1]?.input, [{ type: "compaction_trigger" }]);
  assert.equal(sent[2]?.previous_response_id, undefined);
  assert.deepEqual(sent[2]?.input, [{ type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(compactEvents.at(-1)?.type, "response.completed");
  assert.equal(continuationEvents.at(-1)?.type, "response.completed");
  transport.close("session-1");
});
