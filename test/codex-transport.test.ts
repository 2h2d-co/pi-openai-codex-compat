import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  CodexTransport,
  getOpenAICodexWebSocketDebugStats,
  requestCodexJson,
  resetOpenAICodexWebSocketDebugStats,
  resolveCodexApiUrl,
  type CodexContinuationHandle,
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

function rawMessageItem(id: string, text: string): JsonRecord {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ text, type: "output_text", annotations: [] }],
  };
}

function canonicalMessageItem(id: string, text: string): JsonRecord {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
    id,
  };
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

void test("matches Pi AI's raw and untruncated HTTP error messages", async () => {
  const longMessage = `upstream-${"x".repeat(4_100)}`;
  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: longMessage } }), { status: 400 }),
      },
    ),
    { message: longMessage },
  );

  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () => new Response("  upstream denied  ", { status: 400 }),
      },
    ),
    { message: "  upstream denied  " },
  );

  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () => new Response("", { status: 500 }),
      },
    ),
    { message: "Request failed" },
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

void test("preserves SSE read errors when reader cleanup also fails", async () => {
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("SSE body read failed");
          },
          async cancel() {},
          releaseLock() {
            throw new Error("SSE reader release failed");
          },
        };
      },
    },
  } as unknown as Response;

  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          fetch: async () => response,
        },
      )) {
        // Consume the response.
      }
    },
    { message: "SSE body read failed" },
  );
});

void test("marks SSE transport started after successful response headers", async () => {
  let starts = 0;
  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      onTransportStart() {
        starts += 1;
      },
      fetch: async () => new Response("", { status: 200 }),
    },
  )) {
    events.push(event);
  }

  assert.equal(starts, 1);
  assert.deepEqual(events, []);
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
  const hashedSessionId = createHash("sha256").update(longSessionId, "utf8").digest("hex");
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

  assert.equal(requestHeaders[0]?.get("session-id"), hashedSessionId);
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

void test("retries non-transient SSE response errors when configured like Pi AI", async () => {
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  })}\n\n`;
  let requests = 0;
  for await (const _event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      maxRetries: 1,
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? new Response('{"error":{"code":"invalid_request","message":"bad request"}}', {
              status: 400,
            })
          : new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the successful retry.
  }

  assert.equal(requests, 2);
});

void test("retries generic usage-limit responses like Pi AI", async () => {
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  })}\n\n`;
  let requests = 0;
  for await (const _event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      maxRetries: 1,
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? new Response('{"error":{"code":"temporary_limit","message":"usage limit"}}', {
              status: 429,
              headers: { "retry-after-ms": "0" },
            })
          : new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the successful retry.
  }

  assert.equal(requests, 2);
});

void test("normalizes AbortError without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          maxRetries: 2,
          fetch: async () => {
            requests += 1;
            const error = new Error("custom abort");
            error.name = "AbortError";
            throw error;
          },
        },
      )) {
        // AbortError stops acquisition immediately.
      }
    },
    { message: "Request was aborted" },
  );
  assert.equal(requests, 1);
});

void test("does not retry SSE protocol errors after streaming starts", async () => {
  let requests = 0;
  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          maxRetries: 1,
          fetch: async () => {
            requests += 1;
            return new Response("data: {not-json}\n\n", { status: 200 });
          },
        },
      )) {
        // Protocol errors after response acquisition are terminal.
      }
    },
    { name: "CodexProtocolError" },
  );
  assert.equal(requests, 1);
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
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.details.eventsEmitted, false);
  assert.equal(diagnostics[0]?.details.fallbackTransport, "sse");
});

void test("continues created response IDs with Pi AI's order-sensitive delta checks", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];

  class CreatedIdWebSocket {
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

    send(data: string): void {
      sentBodies.push(JSON.parse(data) as JsonRecord);
      const events =
        sentBodies.length === 1
          ? [
              { type: "response.created", response: { id: "response-created" } },
              { type: "response.completed", response: { status: "completed" } },
            ]
          : [
              {
                type: "response.completed",
                response: { id: `response-${String(sentBodies.length)}`, status: "completed" },
              },
            ];
      queueMicrotask(() => {
        for (const event of events) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
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
    value: CreatedIdWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const firstInput = { role: "user", content: "first" };
  const nextInput = { role: "user", content: "next" };
  const thirdInput = { role: "user", content: "third" };
  const fourthInput = { role: "user", content: "fourth" };
  const options = {
    apiKey: accessToken(),
    sessionId: "created-id-session",
    transport: "websocket-cached" as const,
  };
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", instructions: "same", input: [firstInput] },
    options,
  )) {
    // Consume the response.
  }
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", instructions: "same", input: [firstInput, nextInput] },
    options,
  )) {
    // Consume the response.
  }
  for await (const _event of transport.request(
    codexModel(),
    {
      instructions: "same",
      model: "gpt-test",
      input: [firstInput, nextInput, thirdInput],
    },
    options,
  )) {
    // Reordered request fields require a full-context request like Pi AI.
  }
  for await (const _event of transport.request(
    codexModel(),
    {
      instructions: "same",
      model: "gpt-test",
      input: [{ content: "first", role: "user" }, nextInput, thirdInput, fourthInput],
    },
    options,
  )) {
    // Reordered history fields also require a full-context request.
  }

  assert.equal(sentBodies.length, 4);
  assert.equal(sentBodies[1]?.previous_response_id, "response-created");
  assert.deepEqual(sentBodies[1]?.input, [nextInput]);
  assert.equal(sentBodies[2]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[2]?.input, [firstInput, nextInput, thirdInput]);
  assert.equal(sentBodies[3]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[3]?.input, [
    { content: "first", role: "user" },
    nextInput,
    thirdInput,
    fourthInput,
  ]);
  transport.close("created-id-session");
});

void test("sends full context when a payload hook supplies string input", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];

  class StringInputWebSocket {
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

    send(data: string): void {
      sentBodies.push(JSON.parse(data) as JsonRecord);
      const responseNumber = sentBodies.length;
      queueMicrotask(() => {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: `response-${String(responseNumber)}`, status: "completed" },
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
    value: StringInputWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const options = {
    apiKey: accessToken(),
    sessionId: "string-input-session",
    transport: "websocket-cached" as const,
  };
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: "hook-supplied input" },
    options,
  )) {
    // Consume the response.
  }
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: "hook-supplied input" },
    options,
  )) {
    // Consume the response.
  }

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[1]?.previous_response_id, undefined);
  assert.equal(sentBodies[1]?.input, "hook-supplied input");
  transport.close("string-input-session");
});

void test("continues a multi-step conversation with canonical and native replay items", async (t) => {
  resetOpenAICodexWebSocketDebugStats();
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  let connections = 0;
  let closes = 0;
  const nativeAssistant = {
    type: "function_call",
    id: "function-2",
    call_id: "call-2",
    name: "read",
    arguments: "{}",
    status: "completed",
    provider_data: { opaque: "native" },
  };

  class ReplayWebSocket {
    readonly readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
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
      const turn = sentBodies.length;
      const item =
        turn === 2
          ? nativeAssistant
          : rawMessageItem(`message-${String(turn)}`, `answer-${String(turn)}`);
      const events = [
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: { id: `response-${String(turn)}`, status: "completed" },
        },
      ];
      queueMicrotask(() => {
        for (const event of events) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      closes += 1;
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: ReplayWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const firstUser = { role: "user", content: "first" };
  const firstAssistant = canonicalMessageItem("message-1", "answer-1");
  const secondUser = { role: "user", content: "second" };
  const thirdUser = { role: "user", content: "third" };
  const continuations: CodexContinuationHandle[] = [];
  const options = {
    apiKey: accessToken(),
    sessionId: "replay-session",
    transport: "websocket-cached" as const,
    onContinuationReady(handle: CodexContinuationHandle) {
      continuations.push(handle);
    },
  };
  const transport = new CodexTransport();

  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstUser] },
    options,
  )) {
    // Establish the first continuation.
  }
  const firstContinuation = continuations[0];
  assert.equal(firstContinuation?.responseId, "response-1");
  assert.equal(firstContinuation?.replaceResponseItems([firstAssistant]), true);

  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstUser, firstAssistant, secondUser] },
    options,
  )) {
    // Continue from the canonical first response.
  }
  const secondContinuation = continuations[1];
  assert.equal(secondContinuation?.responseId, "response-2");
  assert.equal(firstContinuation?.replaceResponseItems([]), false);
  assert.equal(secondContinuation?.replaceResponseItems([nativeAssistant]), true);

  for await (const _event of transport.request(
    codexModel(),
    {
      model: "gpt-test",
      input: [firstUser, firstAssistant, secondUser, nativeAssistant, thirdUser],
    },
    options,
  )) {
    // Continue from the exact native second response.
  }

  assert.equal(connections, 1);
  assert.equal(sentBodies.length, 3);
  assert.equal(sentBodies[0]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[0]?.input, [firstUser]);
  assert.equal(sentBodies[1]?.previous_response_id, "response-1");
  assert.deepEqual(sentBodies[1]?.input, [secondUser]);
  assert.equal(sentBodies[2]?.previous_response_id, "response-2");
  assert.deepEqual(sentBodies[2]?.input, [thirdUser]);
  const stats = getOpenAICodexWebSocketDebugStats("replay-session");
  assert.deepEqual(stats, {
    requests: 3,
    connectionsCreated: 1,
    connectionsReused: 2,
    cachedContextRequests: 3,
    storeTrueRequests: 0,
    fullContextRequests: 1,
    deltaRequests: 2,
    lastInputItems: 1,
    lastDeltaInputItems: 1,
    lastPreviousResponseId: "response-2",
    websocketFailures: 0,
    sseFallbacks: 0,
  });
  if (stats) stats.requests = 99;
  assert.equal(getOpenAICodexWebSocketDebugStats("replay-session")?.requests, 3);
  resetOpenAICodexWebSocketDebugStats("replay-session");
  assert.equal(getOpenAICodexWebSocketDebugStats("replay-session"), undefined);
  closeOpenAICodexWebSocketSessions("replay-session");
  assert.equal(closes, 1);
});

void test("invalidates and re-establishes continuation after a conversation branch", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  let connections = 0;

  class BranchWebSocket {
    readonly readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
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
      const turn = sentBodies.length;
      const events = [
        {
          type: "response.output_item.done",
          item: rawMessageItem(`message-${String(turn)}`, `answer-${String(turn)}`),
        },
        {
          type: "response.completed",
          response: { id: `response-${String(turn)}`, status: "completed" },
        },
      ];
      queueMicrotask(() => {
        for (const event of events) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
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
    value: BranchWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const firstUser = { role: "user", content: "first" };
  const firstAssistant = canonicalMessageItem("message-1", "answer-1");
  const secondUser = { role: "user", content: "second" };
  const secondAssistant = canonicalMessageItem("message-2", "answer-2");
  const branchedUser = { role: "user", content: "replacement second" };
  const branchedAssistant = canonicalMessageItem("message-3", "answer-3");
  const finalUser = { role: "user", content: "final" };
  let continuation: CodexContinuationHandle | undefined;
  const options = {
    apiKey: accessToken(),
    sessionId: "branch-session",
    transport: "websocket-cached" as const,
    onContinuationReady(handle: CodexContinuationHandle) {
      continuation = handle;
    },
  };
  const transport = new CodexTransport();
  const request = async (input: JsonRecord[], replayItem: JsonRecord): Promise<void> => {
    for await (const _event of transport.request(
      codexModel(),
      { model: "gpt-test", input },
      options,
    )) {
      // Consume the response.
    }
    assert.equal(continuation?.replaceResponseItems([replayItem]), true);
  };

  await request([firstUser], firstAssistant);
  await request([firstUser, firstAssistant, secondUser], secondAssistant);
  await request([firstUser, firstAssistant, branchedUser], branchedAssistant);

  for await (const _event of transport.request(
    codexModel(),
    {
      model: "gpt-test",
      input: [firstUser, firstAssistant, branchedUser, branchedAssistant, finalUser],
    },
    options,
  )) {
    // Continue from the new branch response.
  }

  assert.equal(connections, 1);
  assert.equal(sentBodies.length, 4);
  assert.equal(sentBodies[0]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[0]?.input, [firstUser]);
  assert.equal(sentBodies[1]?.previous_response_id, "response-1");
  assert.deepEqual(sentBodies[1]?.input, [secondUser]);
  assert.equal(sentBodies[2]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[2]?.input, [firstUser, firstAssistant, branchedUser]);
  assert.equal(sentBodies[3]?.previous_response_id, "response-3");
  assert.deepEqual(sentBodies[3]?.input, [finalUser]);
  transport.close("branch-session");
});

void test("uses UUIDv7 for empty session IDs and WebSocket connection-limit retries", async (t) => {
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
        protocols && typeof protocols === "object" && !Array.isArray(protocols)
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
    websocketFallbackActive: true,
    lastWebSocketError: "socket failed after output started",
  });
  resetOpenAICodexWebSocketDebugStats("fallback-session");
  assert.equal(getOpenAICodexWebSocketDebugStats("fallback-session"), undefined);
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
