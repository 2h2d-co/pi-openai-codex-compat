import {
  assert,
  test,
  CodexTransport,
  codexModel,
  accessToken,
  type CodexTransportDiagnostic,
  type JsonRecord,
} from "./codex-transport-harness.ts";

test("disables the WebSocket connect timeout when configured as zero", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let closeReason: string | undefined;

  class PendingWebSocket {
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {
      throw new Error("send should not run before open");
    }
    close(_code?: number, reason?: string): void {
      closeReason = reason;
    }
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
  assert.equal(closeReason, "aborted");
});

test("uses Codex WebSocket timeouts without proactively expiring healthy sockets", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const originalDateNow = Date.now;
  let now = originalDateNow();
  let mode: "connect-timeout" | "stream-idle" | "complete" = "connect-timeout";
  let connections = 0;
  const closeReasons: Array<{ connection: number; reason: string | undefined }> = [];
  const terminalEvent = {
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  };

  class CloseReasonWebSocket {
    readyState = 1;
    private readonly connection = ++connections;
    private readonly behavior = mode;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      if (this.behavior !== "connect-timeout") {
        queueMicrotask(() => this.dispatch("open", {}));
      }
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
      if (this.behavior !== "complete") return;
      queueMicrotask(() => {
        this.dispatch("message", { data: JSON.stringify(terminalEvent) });
      });
    }

    close(_code?: number, reason?: string): void {
      this.readyState = 3;
      closeReasons.push({ connection: this.connection, reason });
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: CloseReasonWebSocket,
  });
  Date.now = () => now;
  const transport = new CodexTransport();
  t.after(() => {
    transport.close("connection-age-session");
    Date.now = originalDateNow;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });
  const fallback = async () =>
    new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  for await (const _event of transport.request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "websocket",
      websocketConnectTimeoutMs: 1,
      websocketMaxRetries: 0,
      fetch: fallback,
    },
  )) {
    // Consume the SSE fallback.
  }

  mode = "stream-idle";
  for await (const _event of transport.request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "websocket",
      timeoutMs: 1,
      websocketMaxRetries: 0,
      fetch: fallback,
    },
  )) {
    // Consume the SSE fallback.
  }

  mode = "complete";
  for (let request = 0; request < 2; request++) {
    for await (const _event of transport.request(
      codexModel(),
      { input: [] },
      {
        apiKey: accessToken(),
        sessionId: "connection-age-session",
        transport: "websocket",
      },
    )) {
      // Consume the WebSocket response.
    }
    now += 55 * 60 * 1_000;
  }

  assert.equal(
    closeReasons.some((entry) => entry.reason === "connect_timeout"),
    true,
  );
  assert.equal(
    closeReasons.some((entry) => entry.reason === "idle_timeout"),
    true,
  );
  assert.equal(
    closeReasons.some((entry) => entry.reason === "connection_age_limit"),
    false,
  );
  assert.equal(connections, 3);
});

test("honors server-directed SSE retry delays and their configured cap", async () => {
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

test("resamples retryable SSE HTTP failures with the stream budget", async () => {
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  })}\n\n`;
  const diagnostics: CodexTransportDiagnostic[] = [];
  let requests = 0;
  for await (const _event of new CodexTransport().request(
    codexModel(),
    { input: [], prompt_cache_key: "sse-http-retry" },
    {
      apiKey: accessToken(),
      sessionId: "sse-http-retry",
      transport: "sse",
      maxRetries: 0,
      sseStreamMaxRetries: 1,
      sseStreamRetryBaseDelayMs: 0,
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? new Response('{"error":{"code":"temporarily_unavailable"}}', { status: 503 })
          : new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the successful resampling attempt.
  }

  assert.equal(requests, 2);
  const recovery = diagnostics.find((diagnostic) => diagnostic.type === "codex_transport_recovery");
  assert.equal(recovery?.details.trigger, "sse_stream_retry");
  assert.equal(recovery?.details.cacheIdentityPreserved, true);
  assert.match(recovery?.details.error?.message ?? "", /temporarily_unavailable/);
});

test("does not retry non-transient SSE response errors", async () => {
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
            return new Response('{"error":{"code":"invalid_request","message":"bad request"}}', {
              status: 400,
            });
          },
        },
      )) {
        // Invalid requests must reach Pi immediately.
      }
    },
    { message: "bad request" },
  );

  assert.equal(requests, 1);
});

test("retries transient SSE rate limits", async () => {
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
          ? new Response(
              '{"error":{"code":"rate_limit_exceeded","message":"temporarily overloaded"}}',
              {
                status: 429,
                headers: { "retry-after-ms": "0" },
              },
            )
          : new Response(terminal, { status: 200 });
      },
    },
  )) {
    // Consume the successful retry.
  }

  assert.equal(requests, 2);
});

test("does not resample terminal SSE usage limits", async () => {
  let requests = 0;
  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          fetch: async () => {
            requests += 1;
            return new Response(
              '{"error":{"code":"usage_limit_reached","message":"limit reached","plan_type":"plus"}}',
              { status: 429 },
            );
          },
        },
      )) {
        // Terminal account limits must reach Pi immediately.
      }
    },
    { message: "You have hit your ChatGPT usage limit (plus plan)." },
  );
  assert.equal(requests, 1);
});

test("normalizes AbortError without retrying", async () => {
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

test("does not retry SSE protocol errors after streaming starts", async () => {
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

test("retries dropped SSE streams before model-visible output", async () => {
  let requests = 0;
  const diagnostics: CodexTransportDiagnostic[] = [];
  const completed = {
    type: "response.completed",
    response: { id: "response-2", status: "completed" },
  };

  const events: JsonRecord[] = [];
  for await (const event of new CodexTransport().request(
    codexModel(),
    { model: "gpt-test", input: [], prompt_cache_key: "sse-retry-session" },
    {
      apiKey: accessToken(),
      sessionId: "sse-retry-session",
      transport: "sse",
      sseStreamMaxRetries: 1,
      sseStreamRetryBaseDelayMs: 0,
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      fetch: async () => {
        requests += 1;
        const event =
          requests === 1 ? { type: "response.created", response: { id: "response-1" } } : completed;
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
      },
    },
  )) {
    events.push(event);
  }

  assert.equal(requests, 2);
  assert.deepEqual(events, [
    { type: "response.created", response: { id: "response-1" } },
    completed,
  ]);
  const recovery = diagnostics.find((diagnostic) => diagnostic.type === "codex_transport_recovery");
  assert.equal(recovery?.details.trigger, "sse_stream_retry");
  assert.equal(recovery?.details.cacheIdentityPreserved, true);
  assert.equal(recovery?.details.retryNumber, 1);
  assert.equal(recovery?.details.maxRetries, 1);
  assert.equal(recovery?.details.error?.message, "Codex SSE stream ended before a terminal event");
});

test("does not retry dropped SSE streams after model-visible output", async () => {
  let requests = 0;
  await assert.rejects(
    async () => {
      for await (const _event of new CodexTransport().request(
        codexModel(),
        { input: [] },
        {
          apiKey: accessToken(),
          transport: "sse",
          sseStreamMaxRetries: 1,
          sseStreamRetryBaseDelayMs: 0,
          fetch: async () => {
            requests += 1;
            return new Response(
              `data: ${JSON.stringify({
                type: "response.output_text.delta",
                delta: "visible",
              })}\n\n`,
              { status: 200 },
            );
          },
        },
      )) {
        // The first visible delta is emitted, then EOF fails closed.
      }
    },
    { message: "Codex SSE stream ended before a terminal event" },
  );
  assert.equal(requests, 1);
});
