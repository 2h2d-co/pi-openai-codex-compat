import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CodexProviderRuntime } from "../extensions/openai-codex-compat/codex-provider.ts";
import {
  DEFAULT_CONFIG,
  type CodexCompatConfig,
} from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import {
  getOpenAICodexWebSocketDebugStats,
  type CodexTransportDiagnostic,
} from "../extensions/openai-codex-compat/codex-transport.ts";
import { IMAGE_GENERATION_PARAMETERS } from "../extensions/openai-codex-compat/image-generation-schema.ts";
import { NATIVE_RESPONSE_ENTRY_TYPE } from "../extensions/openai-codex-compat/native-history.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "../extensions/openai-codex-compat/namespaced-tools.ts";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

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
    compat: { supportsOpenAIGrammarTools: true },
  } as Model<any>;
}

function userEntry(id: string, text: string, parentId: string | null = null): MessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as MessageEntry;
}

function assistantEntry(id: string, parentId: string, text: string): MessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      responseId: `resp_${id}`,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as MessageEntry;
}

function textEvents(text: string, responseId = "resp_text"): JsonRecord[] {
  return [
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.added",
      item: { id: "msg_text", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

function compactionEvents(): JsonRecord[] {
  return [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_compact",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
}

function accessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

function createHarness(
  initialBranch: SessionEntry[],
  config: CodexCompatConfig = DEFAULT_CONFIG,
  sessionId = "session-1",
) {
  let branch = [...initialBranch];
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  const compactions: Array<{ details: unknown; usage: unknown }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const pi = {
    getAllTools: () => [],
    getActiveTools: () => [],
    appendEntry(customType: string, data: unknown) {
      customEntries.push({ customType, data });
      branch.push({
        type: "custom",
        id: `custom-${branch.length}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } as SessionEntry);
    },
  } as unknown as ExtensionAPI;
  const runtime = new CodexProviderRuntime(pi, () => config);
  const manager = {
    getSessionId: () => sessionId,
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id ?? null,
    appendCompaction(
      summary: string,
      firstKeptEntryId: string,
      tokensBefore: number,
      details: unknown,
      fromHook: boolean,
      usage: unknown,
    ) {
      const id = `compact-${branch.length}`;
      branch.push({
        type: "compaction",
        id,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromHook,
        usage,
      } as SessionEntry);
      compactions.push({ details, usage });
      return id;
    },
  };
  const extensionContext = {
    model: codexModel(),
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    scopedModels: [],
    sessionManager: manager,
    ui: {
      notify() {},
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
  } as unknown as ExtensionContext;
  runtime.captureScope(extensionContext);
  return {
    runtime,
    branch: () => branch,
    customEntries,
    compactions,
    statuses,
  };
}

void test("streams ordinary responses without persisting redundant native data", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    yield* textEvents("hello back");
  };
  const context: Context = { messages: [user.message as Context["messages"][number]] };

  const message = await harness.runtime
    .streamSimple(codexModel(), context, {
      apiKey: accessToken(),
      sessionId: "session-1",
      transport: "sse",
    })
    .result();

  assert.equal(message.stopReason, "stop");
  assert.equal(message.responseId, "resp_text");
  assert.equal(requests.length, 1);
  assert.equal(harness.customEntries.length, 0);
});

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
      { messages: [user.message as Context["messages"][number]] },
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

void test("honors disabled cache retention when building provider payloads", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
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
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "auto",
      },
    )
    .result();

  assert.deepEqual(message.diagnostics, [diagnostic]);
});

void test("emits start only when the Codex transport starts", async () => {
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
    options.onTransportStart?.();
    yield* textEvents("hello back");
  };

  const events = [];
  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  for await (const event of result) events.push(event);

  assert.equal(events[0]?.type, "start");
  assert.deepEqual(events[0]?.partial.diagnostics, [diagnostic]);
  assert.equal(events.at(-1)?.type, "done");
});

void test("normalizes pre-stream failures without emitting start", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield* [];
    throw { code: "transport_failed", message: "connection failed" };
  };

  const events = [];
  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  for await (const event of result) events.push(event);

  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(
    errorEvent?.error.errorMessage,
    '{"code":"transport_failed","message":"connection failed"}',
  );
});

void test("cleans streaming scratch state and surfaces structured provider errors", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const failure = Object.assign(new Error("opaque provider failure"), {
    status: 403,
    error: { message: "request denied" },
  });
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "tool",
        arguments: "",
      },
    };
    yield {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"input":',
    };
    throw failure;
  };

  const result = harness.runtime.streamSimple(
    codexModel(),
    { messages: [user.message as Context["messages"][number]] },
    { apiKey: accessToken(), sessionId: "session-1", transport: "auto" },
  );
  let failedMessage: AssistantMessage | undefined;
  for await (const event of result) {
    if (event.type === "error") failedMessage = event.error;
  }

  assert.equal(failedMessage?.errorMessage, '403: {"message":"request denied"}');
  const toolCall = failedMessage?.content.find((block) => block.type === "toolCall");
  assert.ok(toolCall);
  assert.equal("partialJson" in toolCall, false);
  assert.equal("customInput" in toolCall, false);
});

void test("honors non-object payload replacements like Pi AI", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  let request: unknown;
  harness.runtime.transport.request = async function* (_model, body) {
    request = body;
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
        onPayload: () => [],
      },
    )
    .result();

  assert.deepEqual(request, []);
});

void test("rejects missing streamSimple authentication synchronously", () => {
  const harness = createHarness([userEntry("user-1", "hello")]);
  assert.throws(
    () => harness.runtime.streamSimple(codexModel(), { messages: [] }, {}),
    /No API key for provider: openai-codex/,
  );
});

void test("validates direct-stream and compaction authentication before payload hooks", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  let payloadHooks = 0;
  let transportRequests = 0;
  harness.runtime.transport.request = async function* () {
    transportRequests += 1;
    yield* textEvents("unexpected");
  };

  const streamMessage = await harness.runtime
    .stream(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        sessionId: "session-1",
        onPayload(payload) {
          payloadHooks += 1;
          return payload;
        },
      },
    )
    .result();
  assert.equal(streamMessage.stopReason, "error");
  assert.match(streamMessage.errorMessage ?? "", /No API key for provider: openai-codex/);

  await assert.rejects(
    harness.runtime.compact({
      model: codexModel(),
      requestOptions: {
        apiKey: "invalid-token",
        sessionId: "session-1",
        onPayload(payload) {
          payloadHooks += 1;
          return payload;
        },
      },
      history: [],
      instructions: "Compact",
      grammarToolInputProperties: new Map(),
      template: {},
      priority: false,
    }),
    /Failed to extract accountId from token/,
  );
  assert.equal(payloadHooks, 0);
  assert.equal(transportRequests, 0);
});

void test("discards WebSockets when compaction response validation fails", async () => {
  const harness = createHarness([userEntry("user-1", "hello")]);
  let reportedFailure: unknown;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    options.onWebSocketResponseHandle?.({
      discard() {
        return true;
      },
      failParsing(error) {
        reportedFailure = error;
        return true;
      },
    });
    yield {
      type: "response.completed",
      response: { id: "response-without-compaction", status: "completed" },
    };
  };

  await assert.rejects(
    harness.runtime.compact({
      model: codexModel(),
      requestOptions: {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "websocket-cached",
      },
      history: [],
      instructions: "Compact",
      grammarToolInputProperties: new Map(),
      template: {},
      priority: false,
    }),
    /exactly one is required/,
  );
  assert.ok(reportedFailure instanceof Error);
  assert.match(reportedFailure.message, /exactly one is required/);
});

void test("prices unsuccessful terminal usage before returning the provider error", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.incomplete",
      response: {
        id: "response-filtered",
        status: "incomplete",
        service_tier: "default",
        incomplete_details: { reason: "content_filter" },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  };

  const message = await harness.runtime
    .stream(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        serviceTier: "priority",
      },
    )
    .result();

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Response incomplete: content_filter");
  assert.equal(message.usage.totalTokens, 0);
  assert.ok(Math.abs(message.usage.cost.input - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.output - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.total - 0.00004) < 1e-12);
});

void test("matches Pi AI's fallback message for terminal failures without details", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield {
      type: "response.completed",
      response: {
        id: "response-failed",
        status: "failed",
      },
    };
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      { apiKey: accessToken() },
    )
    .result();

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "An unknown error occurred");
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
  assert.equal(terminalFailure.diagnostics, undefined);

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

void test("transports dotted Pi tools as native Responses namespaces", async () => {
  const user = userEntry("user-1", "search");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    yield { type: "response.created", response: { id: "resp_web" } };
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_web",
        call_id: "call_web",
        namespace: "web",
        name: "run",
        arguments: "",
      },
    };
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_web",
        call_id: "call_web",
        namespace: "web",
        name: "run",
        arguments: '{"search_query":[{"q":"Pi"}]}',
      },
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_web",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    };
  };
  const webRun: Tool = {
    name: "web.run",
    description: "Browse the web",
    parameters: Type.Object({
      search_query: Type.Array(Type.Object({ q: Type.String() })),
    }),
  };
  const imageGeneration: Tool = {
    name: IMAGE_GENERATION_TOOL_NAME,
    description: "Generate an image",
    parameters: IMAGE_GENERATION_PARAMETERS,
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [webRun, imageGeneration],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  const firstRequest = requests[0];
  assert.ok(firstRequest);
  assert.deepEqual((firstRequest.tools as JsonRecord[])[0], {
    type: "namespace",
    name: "web",
    description: "Tools in the web namespace.",
    tools: [
      {
        type: "function",
        name: "run",
        description: "Browse the web",
        parameters: webRun.parameters,
        strict: false,
      },
    ],
  });
  assert.deepEqual((firstRequest.tools as JsonRecord[])[1], {
    type: "namespace",
    name: "image_gen",
    description: "Tools in the image_gen namespace.",
    tools: [
      {
        type: "function",
        name: "imagegen",
        description: "Generate an image",
        parameters: IMAGE_GENERATION_PARAMETERS,
        strict: false,
      },
    ],
  });
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.equal(toolCall?.name, "web.run");
  assert.equal(harness.customEntries.length, 0);
});

void test("persists native output only when Pi cannot round-trip it", async () => {
  const user = userEntry("user-1", "search");
  const harness = createHarness([user]);
  const nativeItem = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "Pi" },
  };
  let replayItems: readonly JsonRecord[] | undefined;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    yield { type: "response.created", response: { id: "resp_search" } };
    yield {
      type: "response.output_item.done",
      item: nativeItem,
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_search",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    };
    options.onContinuationReady?.({
      responseId: "resp_search",
      replaceResponseItems(items) {
        replayItems = structuredClone(items);
        return true;
      },
    });
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  assert.equal(message.responseId, "resp_search");
  assert.equal(harness.customEntries.length, 1);
  assert.equal(harness.customEntries[0]?.customType, NATIVE_RESPONSE_ENTRY_TYPE);
  assert.match(JSON.stringify(harness.customEntries[0]?.data), /web_search_call/);
  assert.equal(JSON.stringify(replayItems), JSON.stringify([nativeItem]));
});

void test("performs percentage compaction before sampling the current user input", async () => {
  const first = userEntry("user-1", "old request");
  const assistant = assistantEntry("assistant-1", "user-1", "old response");
  const current = userEntry("user-2", "continue", "assistant-1");
  const harness = createHarness([first, assistant, current], {
    ...DEFAULT_CONFIG,
    autoCompactAtPercent: 80,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    if (requests.length === 1) yield* compactionEvents();
    else yield* textEvents("continued", "resp_continued");
  };
  const context: Context = {
    systemPrompt: "system prompt",
    messages: [
      first.message as Context["messages"][number],
      assistant.message as AssistantMessage,
      current.message as Context["messages"][number],
    ],
  };

  const message = await harness.runtime
    .streamSimple(codexModel(), context, {
      apiKey: accessToken(),
      sessionId: "session-1",
      transport: "sse",
    })
    .result();

  assert.equal(message.responseId, "resp_continued");
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0]?.input), /continue/);
  assert.match(JSON.stringify(requests[1]?.input), /opaque-state/);
  assert.match(JSON.stringify(requests[1]?.input), /continue/);
  assert.equal(harness.compactions.length, 1);
  assert.ok(harness.compactions[0]?.usage);
  assert.deepEqual(harness.statuses, []);
});

void test("keeps native history separate from hashed or disabled cache identity", async () => {
  const first = userEntry("user-1", "old request");
  const checkpoint = {
    type: "compaction",
    id: "compact-1",
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    summary: "hidden marker",
    firstKeptEntryId: "user-1",
    tokensBefore: 50_000,
    details: {
      kind: CHECKPOINT_ENTRY_TYPE,
      version: 1,
      modelId: "gpt-test",
      history: [
        { role: "user", content: [{ type: "input_text", text: "old request" }] },
        { type: "compaction", encrypted_content: "checkpoint-state" },
      ],
    },
  } as SessionEntry;
  const next = userEntry("user-2", "search", "compact-1");
  const native = {
    type: "custom",
    id: "native-1",
    parentId: "user-2",
    timestamp: new Date().toISOString(),
    customType: NATIVE_RESPONSE_ENTRY_TYPE,
    data: {
      kind: NATIVE_RESPONSE_ENTRY_TYPE,
      version: 1,
      modelId: "gpt-test",
      responseId: "resp_search",
      items: [
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "Pi" },
        },
        {
          type: "message",
          id: "msg_search",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "result", annotations: [] }],
        },
      ],
    },
  } as SessionEntry;
  const assistant = assistantEntry("assistant-search", "native-1", "result");
  (assistant.message as AssistantMessage).responseId = "resp_search";
  const current = userEntry("user-3", "continue", "assistant-search");
  const sessionId = `session-${"x".repeat(80)}`;
  const cacheKey = createHash("sha256").update(sessionId, "utf8").digest("hex");
  const harness = createHarness(
    [first, checkpoint, next, native, assistant, current],
    DEFAULT_CONFIG,
    sessionId,
  );
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    yield* textEvents("done", "resp_done");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [
          first.message as Context["messages"][number],
          next.message as Context["messages"][number],
          assistant.message as AssistantMessage,
          current.message as Context["messages"][number],
        ],
      },
      {
        apiKey: accessToken(),
        sessionId,
        cacheRetention: "none",
        transport: "sse",
      },
    )
    .result();

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [
          first.message as Context["messages"][number],
          next.message as Context["messages"][number],
          assistant.message as AssistantMessage,
          current.message as Context["messages"][number],
        ],
      },
      {
        apiKey: accessToken(),
        sessionId,
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests[0]?.prompt_cache_key, undefined);
  assert.equal(requests[1]?.prompt_cache_key, cacheKey);
  for (const request of requests) {
    const input = request.input as JsonRecord[];
    assert.equal(input[1]?.type, "compaction");
    assert.ok(input.some((item) => item.type === "web_search_call"));
    assert.match(JSON.stringify(input.at(-1)), /continue/);
    assert.doesNotMatch(JSON.stringify(input), /hidden marker/);
  }
});
