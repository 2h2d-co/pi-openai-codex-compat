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
import { isObject, type JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import {
  getOpenAICodexWebSocketDebugStats,
  type CodexTransportDiagnostic,
} from "../extensions/openai-codex-compat/codex-transport.ts";
import { IMAGE_GENERATION_PARAMETERS } from "../extensions/openai-codex-compat/image-generation-schema.ts";
import { NATIVE_RESPONSE_ENTRY_TYPE } from "../extensions/openai-codex-compat/native-history.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "../extensions/openai-codex-compat/namespaced-tools.ts";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import {
  CODEX_TURN_METADATA_HEADER,
  responsesCompactionV2Metadata,
} from "../extensions/openai-codex-compat/codex-metadata.ts";
import {
  CODEX_THREAD_MARKER_ENTRY_TYPE,
  type CodexThreadMarkerData,
} from "../extensions/openai-codex-compat/codex-thread-lineage.ts";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

const MANUAL_COMPACTION_METADATA = responsesCompactionV2Metadata(
  "manual",
  "user_requested",
  "standalone_turn",
);

function codexModel(id = "gpt-test"): Model<any> {
  return {
    id,
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

function responseDecisions(message: AssistantMessage): JsonRecord[] {
  return (message.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.type === "codex_response_decision")
    .map((diagnostic) => diagnostic.details ?? {});
}

const REPORT_TOOL = {
  name: "report",
  description: "Report a value",
  parameters: Type.Object({ value: Type.String() }),
} as Tool;

const SAMPLE_GRAMMAR_TOOL = {
  name: "sample_tool",
  description: "Sample tool",
  parameters: Type.Object({ input: Type.String() }),
  constrainedSampling: {
    type: "grammar" as const,
    variants: { openai_lark: "start: /.+/" },
  },
} as Tool;

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
  responseRetryPolicy = { maxRetries: 0, baseDelayMs: 0 },
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
  const runtime = new CodexProviderRuntime(
    pi,
    () => config,
    "11111111-1111-4111-8111-111111111111",
    responseRetryPolicy,
  );
  runtime.transport.prewarm = async () => false;
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
    extensionContext,
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

void test("prewarms only the static prefix before its first WebSocket turn", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const prewarms: JsonRecord[] = [];
  let prewarmCacheDiagnostics: JsonRecord | undefined;
  const requests: JsonRecord[] = [];
  harness.runtime.transport.prewarm = async (_model, body, options) => {
    prewarms.push(structuredClone(body));
    prewarmCacheDiagnostics = options.cacheDiagnostics as unknown as JsonRecord;
    return true;
  };
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
        sessionId: "session-1",
        transport: "auto",
      },
    )
    .result();

  assert.equal(prewarms.length, 1);
  const prewarm = prewarms[0];
  assert.ok(prewarm);
  assert.equal((prewarm.input as unknown[]).length, 0);
  const prewarmMetadata = prewarm["client_metadata"] as JsonRecord;
  assert.match(String(prewarmMetadata["x-codex-turn-metadata"]), /"request_kind":"prewarm"/);
  assert.equal(prewarmMetadata["turn_id"], "");
  assert.doesNotMatch(String(prewarmMetadata["x-codex-turn-metadata"]), /turn_started_at_unix_ms/);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal((request.input as unknown[]).length, 1);
  const requestMetadata = request["client_metadata"] as JsonRecord;
  assert.notEqual(requestMetadata["turn_id"], "");
  assert.equal(prewarmCacheDiagnostics?.["prewarmMode"], "static");
  assert.equal(prewarmCacheDiagnostics?.["staticInputItems"], 0);
});

void test("sends GPT-5.6 requests through the Responses Lite envelope", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user], {
    ...DEFAULT_CONFIG,
    responsesLite: true,
  });
  let prewarm: JsonRecord | undefined;
  let prewarmCacheDiagnostics: JsonRecord | undefined;
  let request: JsonRecord | undefined;
  harness.runtime.transport.prewarm = async (_model, body, options) => {
    prewarm = structuredClone(body);
    prewarmCacheDiagnostics = options.cacheDiagnostics as unknown as JsonRecord;
    return true;
  };
  harness.runtime.transport.request = async function* (_model, body) {
    request = structuredClone(body);
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        systemPrompt: "Stable instructions",
        messages: [user.message as Context["messages"][number]],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "auto",
      },
    )
    .result();

  assert.ok(request);
  assert.equal(request.instructions, undefined);
  assert.equal(request.tools, undefined);
  assert.equal(request.parallel_tool_calls, false);
  assert.equal((request["reasoning"] as JsonRecord)["context"], "all_turns");
  const input = request.input as JsonRecord[];
  assert.equal(input[0]?.type, "additional_tools");
  assert.deepEqual(input[1], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Stable instructions" }],
  });
  assert.equal(input[2]?.role, "user");
  assert.ok(prewarm);
  assert.deepEqual(prewarm.input, input.slice(0, 2));
  assert.equal(prewarmCacheDiagnostics?.["envelope"], "responses_lite");
  assert.equal(prewarmCacheDiagnostics?.["staticInputItems"], 2);
});

void test("uses ordinary Responses when Responses Lite is disabled", async () => {
  const user = userEntry("user-1", "hello");
  const report: Tool = {
    name: "report",
    description: "Report status",
    parameters: Type.Object({ status: Type.String() }),
  };
  const harness = createHarness([user]);
  harness.runtime.updateSessionConfig("session-1", {
    ...DEFAULT_CONFIG,
    responsesLite: false,
  });
  let request: JsonRecord | undefined;
  let cacheDiagnostics: JsonRecord | undefined;
  harness.runtime.transport.request = async function* (_model, body, options) {
    request = structuredClone(body);
    cacheDiagnostics = options.cacheDiagnostics as unknown as JsonRecord;
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        systemPrompt: "Stable instructions",
        messages: [user.message as Context["messages"][number]],
        tools: [report],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
        temperature: 0.7,
      },
    )
    .result();

  assert.ok(request);
  assert.equal(request.instructions, "Stable instructions");
  assert.deepEqual(request.tools, [
    {
      type: "function",
      name: "report",
      description: "Report status",
      parameters: report.parameters,
      strict: false,
    },
  ]);
  assert.equal(request["temperature"], undefined);
  assert.equal(request.parallel_tool_calls, true);
  assert.equal((request.input as JsonRecord[])[0]?.role, "user");
  assert.equal(
    (request["client_metadata"] as JsonRecord)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ],
    undefined,
  );
  assert.equal(cacheDiagnostics?.["envelope"], "responses");
  assert.equal(cacheDiagnostics?.["staticInputItems"], 0);
});

void test("reuses one turn id throughout an agent run", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const turnIds: string[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    const metadata = body["client_metadata"] as JsonRecord;
    turnIds.push(String(metadata["turn_id"]));
    yield* textEvents("hello back", `response-${String(turnIds.length)}`);
  };
  const context = { messages: [user.message as Context["messages"][number]] };
  const options = {
    apiKey: accessToken(),
    sessionId: "session-1",
    transport: "sse" as const,
  };

  harness.runtime.beginAgentTurn(harness.extensionContext);
  await harness.runtime.streamSimple(codexModel(), context, options).result();
  await harness.runtime.streamSimple(codexModel(), context, options).result();
  harness.runtime.endAgentTurn(harness.extensionContext);
  harness.runtime.beginAgentTurn(harness.extensionContext);
  await harness.runtime.streamSimple(codexModel(), context, options).result();
  harness.runtime.endAgentTurn(harness.extensionContext);

  assert.equal(turnIds.length, 3);
  assert.equal(turnIds[0], turnIds[1]);
  assert.notEqual(turnIds[1], turnIds[2]);
});

void test("switches branch thread metadata while preserving prompt-cache identity", async () => {
  const root = userEntry("user-1", "root");
  const harness = createHarness([root]);
  const requests: JsonRecord[] = [];
  const closedSessions: Array<string | undefined> = [];
  harness.runtime.transport.close = (sessionId) => {
    closedSessions.push(sessionId);
  };
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    if (
      Array.isArray(body.input) &&
      body.input.some((item) => isObject(item) && item.type === "compaction_trigger")
    ) {
      yield* compactionEvents();
      return;
    }
    yield* textEvents("done", `response-${String(requests.length)}`);
  };
  const options = {
    apiKey: accessToken(),
    sessionId: "session-1",
    transport: "sse" as const,
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [root.message as Context["messages"][number]] },
      options,
    )
    .result();
  await harness.runtime.compact({
    model: codexModel(),
    requestOptions: {
      apiKey: accessToken(),
      sessionId: "session-1",
      transport: "sse",
    },
    history: [],
    instructions: "Compact",
    grammarToolInputProperties: new Map(),
    template: {},
    priority: false,
    compactionMetadata: MANUAL_COMPACTION_METADATA,
    compactionDecision: { reason: "manual", willRetry: false },
  });

  const markerData: CodexThreadMarkerData = {
    version: 1,
    sessionId: "session-1",
    threadId: "019fd600-abcb-7ba3-972c-b289f0a08206",
    forkedFromThreadId: "session-1",
    branchParentEntryId: "user-1",
  };
  harness.branch().push({
    type: "custom",
    id: "thread-marker",
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    customType: CODEX_THREAD_MARKER_ENTRY_TYPE,
    data: markerData,
  } as SessionEntry);
  const branchUser = userEntry("user-2", "branch", "thread-marker");
  harness.branch().push(branchUser);
  harness.runtime.captureScope(harness.extensionContext);

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [
          root.message as Context["messages"][number],
          branchUser.message as Context["messages"][number],
        ],
      },
      options,
    )
    .result();

  harness.branch().splice(1);
  harness.runtime.captureScope(harness.extensionContext);
  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [root.message as Context["messages"][number]] },
      options,
    )
    .result();

  assert.deepEqual(closedSessions, ["session-1", "session-1"]);
  assert.equal(requests[0]?.prompt_cache_key, "session-1");
  assert.equal(requests[2]?.prompt_cache_key, "session-1");
  assert.equal(requests[3]?.prompt_cache_key, "session-1");
  const rootMetadata = requests[0]?.["client_metadata"] as JsonRecord;
  const branchMetadata = requests[2]?.["client_metadata"] as JsonRecord;
  const resumedRootMetadata = requests[3]?.["client_metadata"] as JsonRecord;
  assert.equal(rootMetadata["thread_id"], "session-1");
  assert.equal(branchMetadata["thread_id"], markerData.threadId);
  assert.equal(branchMetadata["x-codex-window-id"], `${markerData.threadId}:0`);
  assert.equal(resumedRootMetadata["x-codex-window-id"], "session-1:1");
  const branchTurnMetadata = JSON.parse(
    String(branchMetadata[CODEX_TURN_METADATA_HEADER]),
  ) as JsonRecord;
  assert.equal(branchTurnMetadata["forked_from_thread_id"], "session-1");
});

void test("continues response.completed end_turn false without synthetic input", async () => {
  const user = userEntry("user-1", "finish the task");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    const responseNumber = requests.length;
    const responseEvents = textEvents(
      responseNumber === 1 ? "first phase" : "second phase",
      `resp_${String(responseNumber)}`,
    );
    if (responseNumber === 1) {
      const terminal = responseEvents.at(-1);
      assert.ok(terminal && isObject(terminal.response));
      terminal.response["end_turn"] = false;
    }
    yield* responseEvents;
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

  assert.equal(requests.length, 2);
  assert.equal(message.responseId, "resp_2");
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(
    message.content.filter((block) => block.type === "text").map((block) => block.text),
    ["first phase", "second phase"],
  );
  assert.equal(message.usage.input, 20);
  assert.equal(message.usage.output, 10);
  assert.equal(message.usage.cacheRead, 0);
  assert.equal(message.usage.cacheWrite, 0);
  assert.equal(message.usage.reasoning, 0);
  assert.equal(message.usage.totalTokens, 30);
  assert.ok(Math.abs(message.usage.cost.input - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.output - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.total - 0.00004) < 1e-12);
  const firstRequest = requests[0];
  const secondRequest = requests[1];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  const firstInput = firstRequest.input as JsonRecord[];
  const secondInput = secondRequest.input as JsonRecord[];
  assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput);
  assert.equal(secondInput.at(-1)?.type, "message");
  assert.equal(secondInput.at(-1)?.role, "assistant");
  assert.match(JSON.stringify(secondInput.at(-1)), /first phase/);
  assert.equal(
    (firstRequest["client_metadata"] as JsonRecord)["turn_id"],
    (secondRequest["client_metadata"] as JsonRecord)["turn_id"],
  );
  assert.equal(harness.customEntries.length, 1);
  assert.match(JSON.stringify(harness.customEntries[0]?.data), /first phase.*second phase/);
});

void test("resamples retryable failed and incomplete responses from completed output history", async () => {
  for (const firstTerminal of ["response.failed", "response.incomplete"] as const) {
    const user = userEntry("user-1", `test ${firstTerminal}`);
    const harness = createHarness([user], DEFAULT_CONFIG, `session-${firstTerminal}`, {
      maxRetries: 1,
      baseDelayMs: 0,
    });
    const requests: JsonRecord[] = [];
    harness.runtime.transport.request = async function* (_model, body) {
      requests.push(structuredClone(body));
      if (requests.length === 2) {
        yield* textEvents("after retry", "resp_recovered");
        return;
      }

      const firstEvents = textEvents("before retry", "resp_retryable");
      firstEvents[firstEvents.length - 1] =
        firstTerminal === "response.failed"
          ? {
              type: "response.failed",
              response: {
                id: "resp_retryable",
                status: "failed",
                error: { code: "rate_limit_exceeded", message: "retry this response" },
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            }
          : {
              type: "response.incomplete",
              response: {
                id: "resp_retryable",
                status: "incomplete",
                incomplete_details: { reason: "content_filter" },
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            };
      yield* firstEvents;
    };

    const message = await harness.runtime
      .streamSimple(
        codexModel(),
        { messages: [user.message as Context["messages"][number]] },
        {
          apiKey: accessToken(),
          sessionId: `session-${firstTerminal}`,
          transport: "sse",
        },
      )
      .result();

    assert.equal(requests.length, 2);
    assert.equal(message.stopReason, "stop");
    assert.equal(message.responseId, "resp_recovered");
    assert.deepEqual(
      message.content.filter((block) => block.type === "text").map((block) => block.text),
      ["before retry", "after retry"],
    );
    assert.equal(message.usage.input, 14);
    assert.equal(message.usage.output, 7);
    const firstInput = requests[0]?.input as JsonRecord[];
    const secondInput = requests[1]?.input as JsonRecord[];
    assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput);
    assert.match(JSON.stringify(secondInput.slice(firstInput.length)), /before retry/);
    assert.equal(harness.customEntries.length, 1);
    assert.match(JSON.stringify(harness.customEntries[0]?.data), /before retry.*after retry/);
  }
});

void test("returns complete function call batches at the output limit without provider continuation", async () => {
  const user = userEntry("user-1", "inspect both");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-function-limit", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  const calls = [
    {
      type: "function_call",
      id: "fc_one",
      call_id: "call_one",
      name: "report",
      status: "completed",
      arguments: '{"value":"one"}',
    },
    {
      type: "function_call",
      id: "fc_two",
      call_id: "call_two",
      name: "report",
      status: "completed",
      arguments: '{"value":"two"}',
    },
  ];
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    for (const [outputIndex, item] of calls.entries()) {
      yield { type: "response.output_item.done", output_index: outputIndex, item };
    }
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_function_limit",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: calls,
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-function-limit",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 1);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.filter((block) => block.type === "toolCall").map((block) => block.arguments),
    [{ value: "one" }, { value: "two" }],
  );
  assert.deepEqual(responseDecisions(message), [
    {
      attempt: 1,
      terminalType: "response.incomplete",
      incompleteReason: "max_output_tokens",
      itemSource: "terminal",
      outputItemTypes: { function_call: 2 },
      streamedCallsStarted: 2,
      streamedCallsCompleted: 2,
      terminalCalls: 2,
      authoritativeCalls: 2,
      terminalOmittedStreamedCalls: 0,
      allCallsComplete: true,
      decision: "return_tool_use",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(responseDecisions(message)), /call_one|call_two|report/);
});

void test("hydrates a complete terminal-only custom call without provider continuation", async () => {
  const user = userEntry("user-1", "apply the custom operation");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-terminal-custom", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_terminal_custom",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "custom_tool_call",
            id: "ctc_custom",
            call_id: "call_custom",
            name: "sample_tool",
            status: "completed",
            input: "complete input",
          },
        ],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [SAMPLE_GRAMMAR_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-terminal-custom",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "toolUse");
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall?.arguments, { input: "complete input" });
  assert.equal(responseDecisions(message)[0]?.["decision"], "return_tool_use");
  assert.equal(responseDecisions(message)[0]?.["itemSource"], "terminal");
  assert.equal(responseDecisions(message)[0]?.["streamedCallsStarted"], 0);
});

void test("executes none of a mixed complete and partial call batch", async () => {
  const user = userEntry("user-1", "inspect both");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-partial-batch", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_partial_batch",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            id: "fc_complete",
            call_id: "call_complete",
            name: "report",
            status: "completed",
            arguments: '{"value":"complete"}',
          },
          {
            type: "function_call",
            id: "fc_partial",
            call_id: "call_partial",
            name: "report",
            status: "incomplete",
            arguments: '{"value":',
          },
        ],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-partial-batch",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "length");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.equal(harness.customEntries.length, 0);
  assert.equal(responseDecisions(message)[0]?.["decision"], "return_length_incomplete_call");
  assert.equal(responseDecisions(message)[0]?.["allCallsComplete"], false);
});

void test("rejects a streamed call omitted from terminal output", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-omitted-call", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  const call = {
    type: "function_call",
    id: "fc_omitted",
    call_id: "call_omitted",
    name: "report",
    status: "completed",
    arguments: '{"value":"omitted"}',
  };
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield { type: "response.output_item.added", output_index: 0, item: call };
    yield { type: "response.output_item.done", output_index: 0, item: call };
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_omitted_call",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-omitted-call",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "length");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.equal(responseDecisions(message)[0]?.["decision"], "reject_terminal_stream_mismatch");
  assert.equal(responseDecisions(message)[0]?.["terminalOmittedStreamedCalls"], 1);
});

void test("retries failed call-bearing responses from pre-attempt input", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-failed-call-retry", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    if (requests.length > 1) {
      yield* textEvents("recovered", "resp_recovered_call");
      return;
    }
    yield {
      type: "response.failed",
      response: {
        id: "resp_failed_call",
        status: "failed",
        error: { code: "rate_limit_exceeded", message: "retry" },
        output: [
          {
            type: "function_call",
            id: "fc_failed",
            call_id: "call_failed",
            name: "report",
            status: "completed",
            arguments: '{"value":"failed"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-failed-call-retry",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.input, requests[0]?.input);
  assert.doesNotMatch(JSON.stringify(requests[1]?.input), /function_call|call_failed/);
  assert.equal(message.stopReason, "stop");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.deepEqual(
    responseDecisions(message).map((decision) => decision["decision"]),
    ["retry_original_input", "return_terminal"],
  );
});

void test("preserves non-retryable failed call-bearing responses", async () => {
  const user = userEntry("user-1", "invalid request");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-failed-call-fatal", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.failed",
      response: {
        id: "resp_failed_call_fatal",
        status: "failed",
        error: { code: "invalid_prompt", message: "Invalid request." },
        output: [
          {
            type: "function_call",
            id: "fc_fatal",
            call_id: "call_fatal",
            name: "report",
            status: "completed",
            arguments: '{"value":"fatal"}',
          },
        ],
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-failed-call-fatal",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid request.");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.equal(responseDecisions(message)[0]?.["decision"], "preserve_terminal_error");
});

void test("does not resample official fatal response.failed codes", async () => {
  const user = userEntry("user-1", "invalid request");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-fatal-response", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.failed",
      response: {
        id: "resp_fatal",
        status: "failed",
        error: { code: "invalid_prompt", message: "Invalid request." },
      },
    };
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message as Context["messages"][number]] },
      {
        apiKey: accessToken(),
        sessionId: "session-fatal-response",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid request.");
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

void test("preserves flat default tool calls in Responses Lite continuations", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user], {
    ...DEFAULT_CONFIG,
    responsesLite: true,
  });
  let replayItems: readonly JsonRecord[] | undefined;
  harness.runtime.transport.request = async function* (_model, _body, options) {
    yield { type: "response.created", response: { id: "resp_tool" } };
    yield {
      type: "response.output_item.done",
      item: {
        id: "fc_report",
        type: "function_call",
        status: "completed",
        call_id: "call_report",
        name: "report",
        arguments: "{}",
      },
    };
    yield {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
    options.onContinuationReady?.({
      responseId: "resp_tool",
      replaceResponseItems(items) {
        replayItems = structuredClone(items);
        return true;
      },
    });
  };

  const tool = {
    name: "report",
    description: "Report",
    parameters: Type.Object({}),
  } as Tool;
  const message = await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        messages: [user.message as Context["messages"][number]],
        tools: [tool],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "websocket-cached",
      },
    )
    .result();

  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(replayItems, [
    {
      type: "function_call",
      id: "fc_report",
      call_id: "call_report",
      name: "report",
      arguments: "{}",
    },
  ]);
  assert.equal(harness.customEntries.length, 0);
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

void test("persists transparent Codex recovery diagnostics on successful assistants", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const diagnostic: CodexTransportDiagnostic = {
    type: "codex_transport_recovery",
    timestamp: Date.now(),
    details: {
      trigger: "previous_response_not_found",
      configuredTransport: "auto",
      previousResponseId: "response-previous",
      cacheIdentity: {
        promptCacheKey: "session-1",
        sessionHeader: "session-1",
        threadHeader: "session-1",
        clientRequestHeader: "session-1",
        routingHint: null,
        accountId: "account-1",
      },
      attempts: [
        {
          transport: "websocket",
          connection: "reused",
          contextMode: "delta",
          inputItems: 1,
          fullInputItems: 3,
          fullRequestBytes: 300,
          wireRequestBytes: 100,
          outcome: "previous_response_not_found",
        },
        {
          transport: "websocket",
          connection: "new",
          contextMode: "full",
          inputItems: 3,
          fullInputItems: 3,
          fullRequestBytes: 300,
          wireRequestBytes: 300,
          outcome: "retry_scheduled",
        },
      ],
      cacheAffinityEnabled: true,
      cacheIdentityPreserved: true,
      promptKeyAndHeaderAligned: true,
      accountIdentityPreserved: true,
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

  assert.equal(message.stopReason, "stop");
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
      compactionMetadata: MANUAL_COMPACTION_METADATA,
      compactionDecision: { reason: "manual", willRetry: false },
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
      compactionMetadata: MANUAL_COMPACTION_METADATA,
      compactionDecision: { reason: "manual", willRetry: false },
    }),
    /exactly one is required/,
  );
  assert.ok(reportedFailure instanceof Error);
  assert.match(reportedFailure.message, /exactly one is required/);
});

void test("advances Codex window metadata after successful direct compaction", async () => {
  const user = userEntry("user-1", "continue");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    if (requests.length === 1) yield* compactionEvents();
    else yield* textEvents("continued", "resp_continued");
  };

  await harness.runtime.compact({
    model: codexModel(),
    requestOptions: {
      apiKey: accessToken(),
      sessionId: "session-1",
      transport: "sse",
    },
    history: [],
    instructions: "Compact",
    grammarToolInputProperties: new Map(),
    template: {},
    priority: false,
    compactionMetadata: MANUAL_COMPACTION_METADATA,
    compactionDecision: { reason: "manual", willRetry: false },
  });
  await harness.runtime
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

  const compactMetadata = requests[0]?.["client_metadata"] as JsonRecord;
  const turnMetadata = requests[1]?.["client_metadata"] as JsonRecord;
  assert.equal(compactMetadata["x-codex-window-id"], "session-1:0");
  assert.equal(turnMetadata["x-codex-window-id"], "session-1:1");
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
  const compactionMetadata = requests[0]?.["client_metadata"] as JsonRecord;
  const continuedMetadata = requests[1]?.["client_metadata"] as JsonRecord;
  assert.equal(compactionMetadata["x-codex-window-id"], "session-1:0");
  const compactionTurnMetadata = JSON.parse(
    String(compactionMetadata[CODEX_TURN_METADATA_HEADER]),
  ) as JsonRecord;
  assert.deepEqual(compactionTurnMetadata["compaction"], {
    trigger: "auto",
    reason: "context_limit",
    implementation: "responses_compaction_v2",
    phase: "pre_turn",
    strategy: "memento",
  });
  assert.equal(continuedMetadata["x-codex-window-id"], "session-1:1");
  assert.equal(harness.compactions.length, 1);
  const recordedCompaction = harness.compactions[0];
  assert.ok(recordedCompaction?.usage);
  assert.deepEqual((recordedCompaction.details as JsonRecord)["compactionDecision"], {
    reason: "provider-boundary",
    willRetry: true,
  });
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
