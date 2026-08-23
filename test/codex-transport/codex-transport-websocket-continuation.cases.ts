import { requireJsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  closeOpenAICodexWebSocketSessions,
  CodexTransport,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  codexModel,
  accessToken,
  rawMessageItem,
  canonicalMessageItem,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
  type JsonRecord,
} from "./codex-transport-harness.ts";

test("prewarms the first WebSocket request and generates from its continuation", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];

  class PrewarmWebSocket {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
      const responseId = sentBodies.length === 1 ? "response-prewarm" : "response-turn";
      queueMicrotask(() => {
        this.dispatch("message", {
          data: JSON.stringify({ type: "response.created", response: { id: responseId } }),
        });
        this.dispatch("message", {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: responseId, status: "completed" },
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
    value: PrewarmWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const transport = new CodexTransport();
  const user = { role: "user", content: "hello" };
  const options = {
    apiKey: accessToken(),
    sessionId: "prewarm-session",
    transport: "websocket-cached" as const,
    onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
      diagnostics.push(diagnostic);
    },
  };
  assert.equal(
    await transport.prewarm(
      codexModel(),
      {
        model: "gpt-test",
        instructions: "same",
        input: [user],
        client_metadata: { request_kind: "prewarm" },
      },
      options,
    ),
    true,
  );
  for await (const _event of transport.request(
    codexModel(),
    {
      model: "gpt-test",
      instructions: "same",
      input: [user],
      client_metadata: { request_kind: "turn" },
    },
    options,
  )) {
    // Consume the first real response.
  }

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]?.["generate"], false);
  assert.deepEqual(sentBodies[0]?.input, [user]);
  assert.equal(sentBodies[1]?.["generate"], undefined);
  assert.equal(sentBodies[1]?.previous_response_id, "response-prewarm");
  assert.deepEqual(sentBodies[1]?.input, []);
  assert.equal(diagnostics.at(-1)?.type, "codex_transport_prewarm");
  if (diagnostics.at(-1)?.type === "codex_transport_prewarm") {
    assert.deepEqual(diagnostics.at(-1)?.details, {
      outcome: "completed",
      continuationReady: true,
    });
  }
  transport.close("prewarm-session");
});

test("reports structured diagnostics when prewarming fails", async () => {
  const diagnostics: CodexTransportDiagnostic[] = [];
  const transport = new CodexTransport();
  const failure = transport.prewarm(
    codexModel(),
    { model: "gpt-test", input: [] },
    {
      apiKey: "",
      sessionId: "failed-prewarm-session",
      transport: "websocket-cached",
      onTransportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
  );

  await assert.rejects(failure, /No API key for provider: openai-codex/u);
  const diagnostic = diagnostics.at(-1);
  assert.equal(diagnostic?.type, "codex_transport_prewarm");
  if (diagnostic?.type !== "codex_transport_prewarm") {
    assert.fail("Expected a prewarm diagnostic.");
  }
  assert.equal(diagnostic.details.outcome, "failed");
  assert.equal(diagnostic.details.continuationReady, false);
  assert.equal(diagnostic.details.error?.name, "Error");
  assert.equal(diagnostic.details.error?.message, "No API key for provider: openai-codex");
  assert.equal(typeof diagnostic.details.error?.stack, "string");
});

test("does not treat incomplete WebSocket responses as completed continuation state", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  let continuationReady = 0;

  class IncompleteWebSocket {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
      const responseNumber = sentBodies.length;
      queueMicrotask(() => {
        const response: JsonRecord = {
          id: `response-${String(responseNumber)}`,
          status: responseNumber === 1 ? "incomplete" : "completed",
        };
        if (responseNumber === 1) {
          response["incomplete_details"] = { reason: "max_output_tokens" };
        }
        this.dispatch("message", {
          data: JSON.stringify({
            type: responseNumber === 1 ? "response.incomplete" : "response.completed",
            response,
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
    value: IncompleteWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const firstInput = { role: "user", content: "first" };
  const continuationInput = { role: "user", content: "continue" };
  const options = {
    apiKey: accessToken(),
    sessionId: "incomplete-continuation-session",
    transport: "websocket-cached" as const,
    onContinuationReady() {
      continuationReady += 1;
    },
  };
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstInput] },
    options,
  )) {
    // Consume the incomplete response.
  }
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstInput, continuationInput] },
    options,
  )) {
    // Consume the completed response.
  }

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[1]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[1]?.input, [firstInput, continuationInput]);
  assert.equal(continuationReady, 1);
  transport.close("incomplete-continuation-session");
});

test("matches official Codex semantic WebSocket delta comparisons", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const diagnostics: CodexTransportDiagnostic[] = [];

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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
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
  const changedFirstInput = { role: "user", content: "changed first" };
  const options = {
    apiKey: accessToken(),
    sessionId: "created-id-session",
    transport: "websocket-cached" as const,
    onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
      diagnostics.push(diagnostic);
    },
  };
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    {
      model: "gpt-test",
      instructions: "same",
      input: [firstInput],
      stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
      omittedFromJson: undefined,
    },
    options,
  )) {
    // Consume the response.
  }
  for await (const _event of transport.request(
    codexModel(),
    {
      model: "gpt-test",
      instructions: "same",
      input: [
        {
          ...firstInput,
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
        nextInput,
      ],
      stream_options: { reasoning_summary_delivery: "none" },
      omittedFromJson: undefined,
    },
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
    // JSON object order is not model context.
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
    // Internal item metadata and JSON object order are not model context.
  }
  for await (const _event of transport.request(
    codexModel(),
    {
      instructions: "same",
      model: "gpt-test",
      input: [changedFirstInput, nextInput, thirdInput, fourthInput],
    },
    options,
  )) {
    // A model-visible history change must bypass continuation with exact diagnostics.
  }

  assert.equal(sentBodies.length, 5);
  assert.equal(sentBodies[0]?.["omittedFromJson"], undefined);
  assert.equal(sentBodies[1]?.["omittedFromJson"], undefined);
  assert.equal(sentBodies[1]?.previous_response_id, "response-created");
  assert.deepEqual(sentBodies[1]?.input, [nextInput]);
  assert.equal(sentBodies[2]?.previous_response_id, "response-2");
  assert.deepEqual(sentBodies[2]?.input, [thirdInput]);
  assert.equal(sentBodies[3]?.previous_response_id, "response-3");
  assert.deepEqual(sentBodies[3]?.input, [fourthInput]);
  assert.equal(sentBodies[4]?.previous_response_id, undefined);
  assert.deepEqual(sentBodies[4]?.input, [changedFirstInput, nextInput, thirdInput, fourthInput]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.type, "codex_transport_recovery");
  if (diagnostics[0]?.type === "codex_transport_recovery") {
    assert.deepEqual(diagnostics[0].details.historyMismatch, {
      index: 0,
      baselineInputItems: 4,
      currentInputItems: 4,
      baselineItem: firstInput,
      currentItem: changedFirstInput,
    });
  }
  transport.close("created-id-session");
});

test("sends full context when a payload hook supplies string input", async (t) => {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
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

test("builds WebSocket continuation state only from output_item.done items", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sentBodies: JsonRecord[] = [];
  const streamedItem = rawMessageItem("message-streamed", "streamed");
  const terminalItem = rawMessageItem("message-terminal", "terminal");

  class DoneItemWebSocket {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
      const turn = sentBodies.length;
      const responseEvents =
        turn === 1
          ? [
              { type: "response.output_item.done", item: streamedItem },
              {
                type: "response.completed",
                response: {
                  id: "response-streamed",
                  status: "completed",
                  output: [terminalItem],
                },
              },
            ]
          : [
              {
                type: "response.completed",
                response: { id: "response-second", status: "completed" },
              },
            ];
      queueMicrotask(() => {
        for (const event of responseEvents) {
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
    value: DoneItemWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    });
  });

  const firstUser = { role: "user", content: "first" };
  const secondUser = { role: "user", content: "second" };
  const options = {
    apiKey: accessToken(),
    sessionId: "done-item-continuation-session",
    transport: "websocket-cached" as const,
  };
  const transport = new CodexTransport();
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstUser] },
    options,
  )) {
    // Establish the continuation from the streamed done item.
  }
  for await (const _event of transport.request(
    codexModel(),
    { model: "gpt-test", input: [firstUser, streamedItem, secondUser] },
    options,
  )) {
    // Consume the delta continuation response.
  }

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[1]?.previous_response_id, "response-streamed");
  assert.deepEqual(sentBodies[1]?.input, [secondUser]);
  transport.close("done-item-continuation-session");
});

test("continues a multi-step conversation with canonical and native replay items", async (t) => {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
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
    prewarmRequests: 0,
  });
  if (stats) stats.requests = 99;
  assert.equal(getOpenAICodexWebSocketDebugStats("replay-session")?.requests, 3);
  resetOpenAICodexWebSocketDebugStats("replay-session");
  assert.equal(getOpenAICodexWebSocketDebugStats("replay-session"), undefined);
  closeOpenAICodexWebSocketSessions("replay-session");
  assert.equal(closes, 1);
});

test("invalidates and re-establishes continuation after a conversation branch", async (t) => {
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
      sentBodies.push(requireJsonRecord(JSON.parse(data)));
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
