import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { requireString } from "../../extensions/openai-codex-compat/value-contracts.ts";
import {
  assert,
  createHash,
  test,
  DEFAULT_CONFIG,
  NATIVE_RESPONSE_ENTRY_TYPE,
  CHECKPOINT_ENTRY_TYPE,
  CODEX_TURN_METADATA_HEADER,
  codexModel,
  userEntry,
  assistantEntry,
  textEvents,
  compactionEvents,
  accessToken,
  createHarness,
  type SessionEntry,
  type Context,
  type JsonRecord,
} from "./codex-provider-harness.ts";

test("performs percentage compaction before sampling the current user input", async () => {
  const first = userEntry("user-1", "old request");
  const assistant = assistantEntry("assistant-1", "user-1", "old response");
  const current = userEntry("user-2", "continue", "assistant-1");
  const harness = createHarness([first, assistant, current], {
    ...DEFAULT_CONFIG,
    autoCompactAtPercent: 80,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    if (requests.length === 1) yield* compactionEvents();
    else yield* textEvents("continued", "resp_continued");
  };
  const context: Context = {
    systemPrompt: "system prompt",
    messages: [first.message, assistant.message, current.message],
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
  const compactionMetadata = requireJsonRecord(requests[0]?.["client_metadata"]);
  const continuedMetadata = requireJsonRecord(requests[1]?.["client_metadata"]);
  assert.equal(compactionMetadata["x-codex-window-id"], "session-1:0");
  const compactionTurnMetadata = requireJsonRecord(
    JSON.parse(
      requireString(compactionMetadata[CODEX_TURN_METADATA_HEADER], "compaction turn metadata"),
    ),
  );
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
  assert.deepEqual(requireJsonRecord(recordedCompaction.details)["compactionDecision"], {
    reason: "provider-boundary",
    willRetry: true,
  });
});

test("keeps native history separate from hashed or disabled cache identity", async () => {
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
  } satisfies SessionEntry;
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
  } satisfies SessionEntry;
  const assistant = assistantEntry("assistant-search", "native-1", "result");
  assistant.message.responseId = "resp_search";
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
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* textEvents("done", "resp_done");
  };

  await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [first.message, next.message, assistant.message, current.message],
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
        messages: [first.message, next.message, assistant.message, current.message],
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
    const input = requireJsonRecords(request.input);
    assert.equal(input[1]?.type, "compaction");
    assert.ok(input.some((item) => item.type === "web_search_call"));
    assert.match(JSON.stringify(input.at(-1)), /continue/);
    assert.doesNotMatch(JSON.stringify(input), /hidden marker/);
  }
});
