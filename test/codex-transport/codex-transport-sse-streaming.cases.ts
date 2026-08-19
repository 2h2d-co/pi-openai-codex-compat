import {
  assert,
  createHash,
  test,
  CodexTransport,
  CodexTurnState,
  codexModel,
  accessToken,
  type CodexTransportDiagnostic,
  type JsonRecord,
} from "./codex-transport-harness.ts";
import { parseSse } from "../../extensions/openai-codex-compat/codex-transport/codex-transport-sse-stream.ts";

test("finishes SSE requests when the terminal event arrives before EOF", async () => {
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

test("delivers response.failed to the provider-owned resampling loop", async () => {
  const terminalEvent = {
    type: "response.failed",
    response: {
      id: "response-failed",
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "retry this response" },
    },
  };
  const events: JsonRecord[] = [];

  for await (const event of new CodexTransport().request(
    codexModel(),
    { input: [] },
    {
      apiKey: accessToken(),
      transport: "sse",
      fetch: async () =>
        new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, { status: 200 }),
    },
  )) {
    events.push(event);
  }

  assert.deepEqual(events, [terminalEvent]);
});

test("serializes SSE request payloads exactly once", async () => {
  let payloadReads = 0;
  const request: JsonRecord = { input: [] };
  Object.defineProperty(request, "marker", {
    enumerable: true,
    get() {
      payloadReads += 1;
      return payloadReads;
    },
  });
  const terminalEvent = {
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  };

  for await (const _event of new CodexTransport().request(codexModel(), request, {
    apiKey: accessToken(),
    transport: "sse",
    fetch: async () =>
      new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  })) {
    // Consume the response.
  }

  assert.equal(payloadReads, 1);
});

test("preserves SSE read errors when reader cleanup also fails", async () => {
  const readFailure = new Error("SSE body read failed");
  const releaseFailure = new Error("SSE reader release failed");
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            throw readFailure;
          },
          async cancel() {},
          releaseLock() {
            throw releaseFailure;
          },
        };
      },
    },
  };

  await assert.rejects(
    async () => {
      for await (const _event of parseSse(response)) {
        // Consume the response.
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "SSE body read failed");
      assert.equal(error.cause, readFailure);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[1], releaseFailure);
      return true;
    },
  );
});

test("marks SSE transport started after successful response headers", async () => {
  let starts = 0;
  const terminalEvent = {
    type: "response.completed",
    response: { id: "response-1", status: "completed" },
  };
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
      fetch: async () =>
        new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, { status: 200 }),
    },
  )) {
    events.push(event);
  }

  assert.equal(starts, 1);
  assert.deepEqual(events, [terminalEvent]);
});

test("aligns cache-affinity headers with retention and length limits", async () => {
  const requestHeaders: Headers[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];
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
    {
      model: "gpt-5.6-sol",
      service_tier: "priority",
      input: [],
      prompt_cache_key: hashedSessionId,
      client_metadata: { session_id: hashedSessionId, thread_id: hashedSessionId },
    },
    {
      apiKey: accessToken(),
      sessionId: longSessionId,
      transport: "sse",
      turnState: new CodexTurnState(),
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
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
      turnState: new CodexTurnState(),
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      fetch: fetcher,
    },
  )) {
    // Consume the response.
  }

  assert.equal(requestHeaders[0]?.get("session-id"), hashedSessionId);
  assert.equal(requestHeaders[0]?.get("thread-id"), hashedSessionId);
  assert.equal(requestHeaders[0]?.get("x-client-request-id"), hashedSessionId);
  assert.equal(requestHeaders[0]?.get("openai-beta"), null);
  assert.equal(requestHeaders[0]?.get("x-codex-routing-hint"), "model=gpt-5.6-sol;tier=priority");
  assert.equal(requestHeaders[1]?.get("session-id"), null);
  assert.equal(requestHeaders[1]?.get("x-client-request-id"), null);
  const requestDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.type === "codex_transport_request",
  );
  assert.equal(requestDiagnostics[0]?.details.promptKeyAndHeaderAligned, true);
  assert.equal(requestDiagnostics[1]?.details.promptKeyAndHeaderAligned, false);
});

test("captures and replays SSE turn state with exact diagnostic values", async () => {
  const turnState = new CodexTurnState();
  const requestHeaders: Headers[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];
  let requests = 0;
  const terminal = `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "response-1",
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
      },
    },
  })}\n\n`;
  const fetcher: typeof fetch = async (_input, init) => {
    requests += 1;
    requestHeaders.push(new Headers(init?.headers));
    const responseInit: ResponseInit =
      requests === 1
        ? { status: 200, headers: { "x-codex-turn-state": "opaque-routing-state" } }
        : { status: 200 };
    return new Response(terminal, responseInit);
  };
  const transport = new CodexTransport();
  const options = {
    apiKey: accessToken(),
    sessionId: "turn-state-sse",
    transport: "sse" as const,
    turnState,
    fetch: fetcher,
    onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
      diagnostics.push(diagnostic);
    },
  };

  for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
    // Consume the first response.
  }
  for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
    // Consume the second response.
  }

  assert.equal(requestHeaders[0]?.get("x-codex-turn-state"), null);
  assert.equal(requestHeaders[1]?.get("x-codex-turn-state"), "opaque-routing-state");
  const requestDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.type === "codex_transport_request",
  );
  assert.equal(requestDiagnostics.length, 2);
  assert.deepEqual(requestDiagnostics[0]?.details.usage, {
    inputTokens: 20,
    cachedTokens: 12,
    cacheWriteTokens: 3,
  });
  assert.equal(requestDiagnostics[0]?.details.turnStateAvailableAtStart, false);
  assert.equal(requestDiagnostics[0]?.details.turnStateReplayed, false);
  assert.equal(requestDiagnostics[0]?.details.turnStateReceived, true);
  assert.equal(requestDiagnostics[0]?.details.sessionId, "turn-state-sse");
  assert.equal(requestDiagnostics[0]?.details.accountId, "account-1");
  assert.equal(requestDiagnostics[0]?.details.responseId, "response-1");
  assert.equal(requestDiagnostics[0]?.details.turnStateReceivedValue, "opaque-routing-state");
  assert.equal(requestDiagnostics[1]?.details.turnStateAvailableAtStart, true);
  assert.equal(requestDiagnostics[1]?.details.turnStateReplayed, true);
  assert.equal(requestDiagnostics[1]?.details.turnStateReceived, false);
  assert.equal(requestDiagnostics[1]?.details.turnStateAtStart, "opaque-routing-state");
  assert.equal(requestDiagnostics[1]?.details.turnStateReplayedValue, "opaque-routing-state");
  assert.match(JSON.stringify(diagnostics), /opaque-routing-state/);
});

test("validates transport timeouts and reports SSE header timeouts", async () => {
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
          sseStreamMaxRetries: 0,
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
