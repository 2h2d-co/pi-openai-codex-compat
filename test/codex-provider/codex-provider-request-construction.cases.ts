import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { requireString } from "../../extensions/openai-codex-compat/value-contracts.ts";
import {
  assert,
  test,
  Type,
  DEFAULT_CONFIG,
  isObject,
  CODEX_TURN_METADATA_HEADER,
  CODEX_THREAD_MARKER_ENTRY_TYPE,
  MANUAL_COMPACTION_METADATA,
  codexModel,
  userEntry,
  textEvents,
  compactionEvents,
  accessToken,
  createHarness,
  type SessionEntry,
  type Context,
  type Tool,
  type JsonRecord,
  type CodexThreadMarkerData,
} from "./codex-provider-harness.ts";

test("streams ordinary responses without persisting redundant native data", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* textEvents("hello back");
  };
  const context: Context = { messages: [user.message] };

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

test("prewarms only the static prefix before its first WebSocket turn", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const prewarms: JsonRecord[] = [];
  let prewarmCacheDiagnostics: JsonRecord | undefined;
  const requests: JsonRecord[] = [];
  harness.runtime.transport.prewarm = async (_model, body, options) => {
    prewarms.push(structuredClone(body));
    prewarmCacheDiagnostics = requireJsonRecord(options.cacheDiagnostics);
    return true;
  };
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
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
  assert.ok(Array.isArray(prewarm.input));
  assert.equal(prewarm.input.length, 0);
  const prewarmMetadata = requireJsonRecord(prewarm["client_metadata"]);
  const prewarmTurnMetadata = requireString(
    prewarmMetadata["x-codex-turn-metadata"],
    "prewarm turn metadata",
  );
  assert.match(prewarmTurnMetadata, /"request_kind":"prewarm"/);
  assert.equal(prewarmMetadata["turn_id"], "");
  assert.doesNotMatch(prewarmTurnMetadata, /turn_started_at_unix_ms/);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.ok(Array.isArray(request.input));
  assert.equal(request.input.length, 1);
  const requestMetadata = requireJsonRecord(request["client_metadata"]);
  assert.notEqual(requestMetadata["turn_id"], "");
  assert.equal(prewarmCacheDiagnostics?.["prewarmMode"], "static");
  assert.equal(prewarmCacheDiagnostics?.["staticInputItems"], 0);
});

test("sends GPT-5.6 requests through the Responses Lite envelope", async () => {
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
    prewarmCacheDiagnostics = requireJsonRecord(options.cacheDiagnostics);
    return true;
  };
  harness.runtime.transport.request = async function* (_model, body) {
    request = structuredClone(requireJsonRecord(body));
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        systemPrompt: "Stable instructions",
        messages: [user.message],
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
  assert.equal(requireJsonRecord(request["reasoning"])["context"], "all_turns");
  const input = requireJsonRecords(request.input);
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

test("uses ordinary Responses when Responses Lite is disabled", async () => {
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
    request = structuredClone(requireJsonRecord(body));
    cacheDiagnostics = requireJsonRecord(options.cacheDiagnostics);
    yield* textEvents("hello back");
  };

  await harness.runtime
    .streamSimple(
      codexModel("gpt-5.6-sol"),
      {
        systemPrompt: "Stable instructions",
        messages: [user.message],
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
  assert.equal(requireJsonRecords(request.input)[0]?.role, "user");
  assert.equal(
    requireJsonRecord(request["client_metadata"])[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ],
    undefined,
  );
  assert.equal(cacheDiagnostics?.["envelope"], "responses");
  assert.equal(cacheDiagnostics?.["staticInputItems"], 0);
});

test("reuses one turn id throughout an agent run", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  const turnIds: string[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    const metadata = requireJsonRecord(requireJsonRecord(body)["client_metadata"]);
    turnIds.push(requireString(metadata["turn_id"], "turn id"));
    yield* textEvents("hello back", `response-${String(turnIds.length)}`);
  };
  const context = { messages: [user.message] };
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

test("switches branch thread metadata while preserving prompt-cache identity", async () => {
  const root = userEntry("user-1", "root");
  const harness = createHarness([root]);
  const requests: JsonRecord[] = [];
  const closedSessions: Array<string | undefined> = [];
  harness.runtime.transport.close = (sessionId) => {
    closedSessions.push(sessionId);
  };
  harness.runtime.transport.request = async function* (_model, body) {
    const requestBody = requireJsonRecord(body);
    requests.push(structuredClone(requestBody));
    if (
      Array.isArray(requestBody.input) &&
      requestBody.input.some((item) => isObject(item) && item.type === "compaction_trigger")
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

  await harness.runtime.streamSimple(codexModel(), { messages: [root.message] }, options).result();
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
  } satisfies SessionEntry);
  const branchUser = userEntry("user-2", "branch", "thread-marker");
  harness.branch().push(branchUser);
  harness.runtime.captureScope(harness.extensionContext);

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [root.message, branchUser.message],
      },
      options,
    )
    .result();

  harness.branch().splice(1);
  harness.runtime.captureScope(harness.extensionContext);
  await harness.runtime.streamSimple(codexModel(), { messages: [root.message] }, options).result();

  assert.deepEqual(closedSessions, ["session-1", "session-1"]);
  assert.equal(requests[0]?.prompt_cache_key, "session-1");
  assert.equal(requests[2]?.prompt_cache_key, "session-1");
  assert.equal(requests[3]?.prompt_cache_key, "session-1");
  const rootMetadata = requireJsonRecord(requests[0]?.["client_metadata"]);
  const branchMetadata = requireJsonRecord(requests[2]?.["client_metadata"]);
  const resumedRootMetadata = requireJsonRecord(requests[3]?.["client_metadata"]);
  assert.equal(rootMetadata["thread_id"], "session-1");
  assert.equal(branchMetadata["thread_id"], markerData.threadId);
  assert.equal(branchMetadata["x-codex-window-id"], `${markerData.threadId}:0`);
  assert.equal(resumedRootMetadata["x-codex-window-id"], "session-1:1");
  const branchTurnMetadata = requireJsonRecord(
    JSON.parse(requireString(branchMetadata[CODEX_TURN_METADATA_HEADER], "branch turn metadata")),
  );
  assert.equal(branchTurnMetadata["forked_from_thread_id"], "session-1");
});
