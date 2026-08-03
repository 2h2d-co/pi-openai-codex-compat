import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  CodexTransport,
  requestCodexJson,
  resolveCodexApiUrl,
  type CodexTransportDiagnostic,
} from "../extensions/openai-codex-compat/codex-transport.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

function codexModel(): Model<any> {
  return {
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
  } as Model<any>;
}

function accessToken(accountId = "account-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

void test("posts authenticated JSON requests to sibling Codex endpoints", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await requestCodexJson(
    codexModel(),
    "alpha/search",
    { id: "session-1" },
    {
      apiKey: accessToken(),
      headers: { "x-provider": "provider" },
      extraHeaders: { "x-codex-turn-metadata": "turn" },
      fetch: async (input, init) => {
        requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requestInit = init;
        return new Response(JSON.stringify({ output: "result" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(
    resolveCodexApiUrl("https://chatgpt.com/backend-api/codex/responses", "/images/edits"),
    "https://chatgpt.com/backend-api/codex/images/edits",
  );
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/alpha/search");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${accessToken()}`);
  assert.equal(headers.get("chatgpt-account-id"), "account-1");
  assert.equal(headers.get("x-provider"), "provider");
  assert.equal(headers.get("x-codex-turn-metadata"), "turn");
  const requestBody = requestInit?.body;
  if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
  assert.deepEqual(JSON.parse(requestBody), { id: "session-1" });
  assert.deepEqual(result, { output: "result" });
});

void test("formats structured errors from sibling Codex endpoints", async () => {
  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "usage_limit_reached",
                message: "limit reached",
                plan_type: "plus",
              },
            }),
            { status: 429 },
          ),
      },
    ),
    { message: "You have hit your ChatGPT usage limit (plus plan)." },
  );
});

void test("finishes SSE requests when the terminal event arrives before EOF", async () => {
  let cancelled = false;
  const terminalEvent = {
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminalEvent)}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });

  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      fetch: async () => new Response(body, { status: 200 }),
    },
  )) {
    events.push(event);
  }

  assert.deepEqual(events, [terminalEvent]);
  assert.equal(cancelled, true);
});

void test("aligns cache-affinity headers with retention and length limits", async () => {
  const requestHeaders: Headers[] = [];
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  })}\n\n`;
  const fetcher: typeof fetch = async (_input, init) => {
    requestHeaders.push(new Headers(init?.headers));
    return new Response(terminal, { status: 200 });
  };
  const longSessionId = "s".repeat(80);
  const transport = new CodexTransport();

  for await (const _event of transport.request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      sessionId: longSessionId,
      transport: "sse",
      fetch: fetcher,
    },
  )) {
    // Consume the response.
  }
  for await (const _event of transport.request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      sessionId: "no-cache-session",
      cacheRetention: "none",
      transport: "sse",
      fetch: fetcher,
    },
  )) {
    // Consume the response.
  }

  assert.equal(Array.from(requestHeaders[0]?.get("session-id") ?? "").length, 64);
  assert.equal(requestHeaders[0]?.get("x-client-request-id"), requestHeaders[0]?.get("session-id"));
  assert.equal(requestHeaders[1]?.get("session-id"), null);
  assert.equal(requestHeaders[1]?.get("x-client-request-id"), null);
});

void test("validates transport timeouts and reports SSE header timeouts", async () => {
  const transport = new CodexTransport();
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          timeoutMs: -1,
          fetch: async () => {
            throw new Error("fetch should not run");
          },
        },
      )) {
        // Validation fails before the request.
      }
    },
    { message: "Invalid timeoutMs: -1" },
  );

  await assert.rejects(
    async () => {
      for await (const _event of transport.request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          timeoutMs: 5,
          fetch: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (!signal) throw new Error("expected timeout signal");
              const keepAlive = setTimeout(() => {}, 100);
              const onAbort = () => {
                clearTimeout(keepAlive);
                reject(signal.reason);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            }),
        },
      )) {
        // The response headers never arrive.
      }
    },
    { message: "Codex SSE response headers timed out after 5ms" },
  );
});

void test("disables the WebSocket connect timeout when configured as zero", async (t) => {
  const previousWebSocket = globalThis.WebSocket;

  class PendingWebSocket {
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {
      throw new Error("send should not run before open");
    }
    close(): void {}
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: PendingWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "websocket",
          websocketConnectTimeoutMs: 0,
          signal: controller.signal,
          fetch: async () => {
            throw new Error("SSE fallback should not run after abort");
          },
        },
      )) {
        // The request remains pending until explicitly aborted.
      }
    },
    { message: "Request was aborted" },
  );
  clearTimeout(timer);
});

void test("honors server-directed SSE retry delays and their configured cap", async () => {
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  })}\n\n`;
  let requests = 0;
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      maxRetries: 1,
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? new Response('{"error":{"code":"temporarily_unavailable"}}', {
              status: 503,
              headers: { "retry-after-ms": "1" },
            })
          : new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the successful retry.
  }
  assert.equal(requests, 2);

  await assert.rejects(
    async () => {
      for await (const _event of transport.request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          maxRetries: 3,
          maxRetryDelayMs: 1_000,
          fetch: async () =>
            new Response('{"error":{"code":"temporarily_unavailable"}}', {
              status: 503,
              headers: { "retry-after": "2" },
            }),
        },
      )) {
        // The retry delay is rejected before another request.
      }
    },
    { message: "Server requested 2s retry delay (max: 1s)" },
  );
});

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

void test("retries WebSocket connection limits before output starts", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let connections = 0;

  class ConnectionLimitWebSocket {
    readyState = 1;
    private readonly limited: boolean;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
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
    { apiKey: accessToken(), transport: "websocket" },
  )) {
    events.push(event);
  }

  assert.equal(connections, 2);
  assert.equal(events.at(-1)?.type, "response.completed");
});

void test("does not mask malformed WebSocket events with SSE fallback", async (t) => {
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

void test("recovers when a cached WebSocket continuation expires", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
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
      const body = JSON.parse(data) as JsonRecord;
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
    // Establish the cached continuation.
  }
  for await (const _event of transport.request(
    codexModel(),
    { input: [firstUser, firstAssistant, secondUser] },
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
  transport.close("continuation-session");
});

void test("rejects a pre-aborted request before reusing a cached WebSocket", async (t) => {
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

void test("uses sticky SSE fallback after a midstream WebSocket failure", async (t) => {
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
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.details.phase, "after_message_stream_start");
  assert.equal(diagnostics[0]?.details.fallbackTransport, undefined);
  transport.close("fallback-session");
});

void test("scopes cached WebSockets to the authenticated account", async (t) => {
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
        protocols && typeof protocols === "object" && !Array.isArray(protocols)
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

void test("reuses one WebSocket for compaction and continuation requests", async (t) => {
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
      const request = JSON.parse(data) as JsonRecord;
      sent.push(request);
      const compacting =
        Array.isArray(request.input) &&
        request.input.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            (item as JsonRecord).type === "compaction_trigger",
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
