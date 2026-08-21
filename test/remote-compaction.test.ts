import {
  isJsonValue,
  isObject,
  requireJsonRecord,
  requireJsonRecords,
  type JsonRecord,
  type JsonValue,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import { isString, requireString } from "../extensions/openai-codex-compat/value-contracts.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  CHECKPOINT_ENTRY_TYPE,
  parseCheckpoint,
} from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { CodexProviderRuntime } from "../extensions/openai-codex-compat/codex-provider.ts";
import type { CodexProviderRuntimeApi } from "../extensions/openai-codex-compat/codex-provider/codex-provider-runtime.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { CODEX_TURN_METADATA_HEADER } from "../extensions/openai-codex-compat/codex-metadata.ts";
import {
  nativeResponseData,
  NATIVE_RESPONSE_ENTRY_TYPE,
} from "../extensions/openai-codex-compat/native-history.ts";
import registerRemoteCompaction, {
  type RemoteCompactionApi,
  type RemoteCompactionContext,
  type RemoteCompactionContextHandler,
  type RemoteCompactionHeadersHandler,
  type RemoteCompactionHookHandler,
  type RemoteCompactionLifecycleHandler,
} from "../extensions/openai-codex-compat/remote-compaction.ts";
import type { ResponsesOutputMessageItem } from "../extensions/openai-codex-compat/responses-item-schema.ts";

interface TestCompactionResult {
  compaction: {
    details: JsonRecord;
    usage?: JsonValue;
  };
}

interface TestContextResult {
  messages: Array<{ role: string }>;
}

function requireCompactionResult(value: unknown): TestCompactionResult {
  if (!isObject(value) || !isObject(value["compaction"])) {
    throw new Error("Expected a compaction result.");
  }
  const details = requireJsonRecord(value["compaction"]["details"], "compaction details");
  const result: TestCompactionResult = { compaction: { details } };
  const usage = value["compaction"]["usage"];
  if (isJsonValue(usage)) result.compaction.usage = usage;
  return result;
}

function requireContextResult(value: unknown): TestContextResult {
  if (!isObject(value) || !Array.isArray(value["messages"])) {
    throw new Error("Expected a context result.");
  }
  const messages = value["messages"].flatMap((message) =>
    isObject(message) && isString(message.role) ? [{ role: message.role }] : [],
  );
  if (messages.length !== value["messages"].length) {
    throw new Error("Expected context messages with string roles.");
  }
  return { messages };
}

function codexModel(): Model<Api> {
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
  } satisfies Model<Api>;
}

function userEntry(id: string, text: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } satisfies SessionEntry;
}

function compactionEvents(encryptedContent = "opaque-state"): JsonRecord[] {
  return [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
    },
    {
      type: "response.completed",
      response: {
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

class RemoteCompactionTestApi implements RemoteCompactionApi, CodexProviderRuntimeApi {
  beforeProviderHeaders: RemoteCompactionHeadersHandler | undefined;
  context: RemoteCompactionContextHandler | undefined;
  sessionBeforeCompact: RemoteCompactionHookHandler | undefined;
  sessionShutdown: RemoteCompactionLifecycleHandler | undefined;
  sessionStart: RemoteCompactionLifecycleHandler | undefined;

  appendEntry(): void {}
  getActiveTools(): string[] {
    return [];
  }
  getAllTools(): ToolInfo[] {
    return [];
  }

  onBeforeProviderHeaders(handler: RemoteCompactionHeadersHandler): void {
    this.beforeProviderHeaders = handler;
  }
  onContext(handler: RemoteCompactionContextHandler): void {
    this.context = handler;
  }
  onSessionBeforeCompact(handler: RemoteCompactionHookHandler): void {
    this.sessionBeforeCompact = handler;
  }
  onSessionShutdown(handler: RemoteCompactionLifecycleHandler): void {
    this.sessionShutdown = handler;
  }
  onSessionStart(handler: RemoteCompactionLifecycleHandler): void {
    this.sessionStart = handler;
  }
}

function createHarness(branch: SessionEntry[]) {
  const selected = codexModel();
  const notices: string[] = [];
  const pi = new RemoteCompactionTestApi();
  const runtime = new CodexProviderRuntime(pi, () => DEFAULT_CONFIG);
  const requests: JsonRecord[] = [];
  const requestHeaders: Array<ProviderHeaders | undefined> = [];
  runtime.transport.request = async function* (_model, body, options) {
    requests.push(structuredClone(requireJsonRecord(body)));
    requestHeaders.push(options.headers);
    yield* compactionEvents();
  };

  const manager = {
    getSessionId: () => "session-1",
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id ?? null,
    appendCompaction: () => "",
  };
  const context = {
    model: selected,
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: manager,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: accessToken(),
        headers: { "x-remove": null },
      }),
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
    getSystemPrompt: () => "system prompt",
  } satisfies RemoteCompactionContext;

  registerRemoteCompaction(pi, runtime, () => DEFAULT_CONFIG);
  return { hooks: pi, runtime, context, requests, requestHeaders, notices };
}

test("requires a callable Pi compaction append capability when capturing runtime scope", () => {
  const harness = createHarness([userEntry("user-1", "Remember BLUE-42.")]);
  const { getBranch, getLeafId, getSessionId } = harness.context.sessionManager;

  for (const sessionManager of [
    { getBranch, getLeafId, getSessionId },
    { getBranch, getLeafId, getSessionId, appendCompaction: "not callable" },
  ]) {
    assert.throws(() => harness.runtime.captureScope({ ...harness.context, sessionManager }), {
      message: "OpenAI Codex requires Pi's compaction-capable session manager.",
    });
  }
});

test("routes manual compaction through the custom provider runtime", async () => {
  const user = userEntry("user-1", "Remember BLUE-42.");
  const harness = createHarness([user]);
  const handler = harness.hooks.sessionBeforeCompact;
  assert.ok(handler);

  const result = requireCompactionResult(
    await handler(
      {
        branchEntries: [user],
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      harness.context,
    ),
  );

  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.ok(request);
  assert.match(JSON.stringify(request.input), /Remember BLUE-42/);
  assert.deepEqual(requireJsonRecords(request.input).at(-1), {
    type: "compaction_trigger",
  });
  assert.deepEqual(harness.requestHeaders[0], {
    "x-codex-beta-features": "remote_compaction_v2",
    "x-remove": null,
  });
  const metadata = requireJsonRecord(request.client_metadata);
  const turnMetadata = requireJsonRecord(
    JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
  );
  assert.deepEqual(turnMetadata["compaction"], {
    trigger: "manual",
    reason: "user_requested",
    implementation: "responses_compaction_v2",
    phase: "standalone_turn",
    strategy: "memento",
  });
  assert.equal(result.compaction.details.kind, CHECKPOINT_ENTRY_TYPE);
  assert.deepEqual(result.compaction.details["compactionDecision"], {
    reason: "manual",
    willRetry: false,
  });
  assert.equal(
    requireJsonRecords(result.compaction.details.history).at(-1)?.encrypted_content,
    "opaque-state",
  );
  assert.ok(result.compaction.usage);
});

test("classifies every Pi compaction lifecycle in official Codex metadata", async (t) => {
  const cases = [
    {
      reason: "manual",
      willRetry: false,
      expected: {
        trigger: "manual",
        reason: "user_requested",
        implementation: "responses_compaction_v2",
        phase: "standalone_turn",
        strategy: "memento",
      },
    },
    {
      reason: "threshold",
      willRetry: false,
      expected: {
        trigger: "auto",
        reason: "context_limit",
        implementation: "responses_compaction_v2",
        phase: "pre_turn",
        strategy: "memento",
      },
    },
    {
      reason: "overflow",
      willRetry: true,
      expected: {
        trigger: "auto",
        reason: "context_limit",
        implementation: "responses_compaction_v2",
        phase: "mid_turn",
        strategy: "memento",
      },
    },
  ] as const;

  for (const candidate of cases) {
    await t.test(candidate.reason, async () => {
      const user = userEntry("user-1", "Remember BLUE-42.");
      const harness = createHarness([user]);
      const handler = harness.hooks.sessionBeforeCompact;
      assert.ok(handler);
      const result = requireCompactionResult(
        await handler(
          {
            branchEntries: [user],
            preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
            reason: candidate.reason,
            willRetry: candidate.willRetry,
            signal: new AbortController().signal,
          },
          harness.context,
        ),
      );

      const metadata = requireJsonRecord(harness.requests[0]?.client_metadata);
      const turnMetadata = requireJsonRecord(
        JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
      );
      assert.deepEqual(turnMetadata["compaction"], candidate.expected);
      assert.deepEqual(result.compaction.details["compactionDecision"], {
        reason: candidate.reason,
        willRetry: candidate.willRetry,
      });
    });
  }
});

test("preserves a proven committed prefix in overflow compaction", async () => {
  const user = userEntry("user-1", "finish this task");
  const committedItem: ResponsesOutputMessageItem = {
    type: "message",
    id: "msg_committed",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "committed progress", annotations: [] }],
  };
  const native = {
    type: "custom",
    id: "native-1",
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    customType: NATIVE_RESPONSE_ENTRY_TYPE,
    data: nativeResponseData(
      "gpt-test",
      "resp_overflow",
      [committedItem],
      [
        {
          itemCount: 1,
          terminalType: "response.incomplete",
          terminalReason: "max_output_tokens",
        },
        {
          itemCount: 0,
          terminalType: "response.failed",
          terminalReason: "context_length_exceeded",
        },
      ],
    ),
  } satisfies SessionEntry;
  const failed = {
    type: "message",
    id: "assistant-error",
    parentId: "native-1",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "committed progress" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      responseId: "resp_overflow",
      usage: {
        input: 100_000,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100_005,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "context_length_exceeded",
      timestamp: Date.now(),
    },
  } satisfies SessionEntry;
  const branch = [user, native, failed];
  const harness = createHarness(branch);
  const handler = harness.hooks.sessionBeforeCompact;
  assert.ok(handler);

  const result = requireCompactionResult(
    await handler(
      {
        branchEntries: branch,
        preparation: { firstKeptEntryId: "user-1", tokensBefore: 100_005 },
        reason: "overflow",
        willRetry: true,
        signal: new AbortController().signal,
      },
      harness.context,
    ),
  );

  assert.equal(harness.requests.length, 1);
  const input = requireJsonRecords(harness.requests[0]?.input);
  assert.match(JSON.stringify(input), /finish this task.*committed progress/);
  assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
  assert.doesNotMatch(JSON.stringify(input), /context_length_exceeded/);
  assert.deepEqual(result.compaction.details["compactionDecision"], {
    reason: "overflow",
    willRetry: true,
  });
});

test("captures session scope and suppresses Pi's marker summary", () => {
  const user = userEntry("user-1", "Remember BLUE-42.");
  const checkpoint = {
    type: "compaction",
    id: "compact-1",
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    summary: "marker",
    firstKeptEntryId: "user-1",
    tokensBefore: 50_000,
    details: {
      kind: CHECKPOINT_ENTRY_TYPE,
      version: 1,
      modelId: "gpt-test",
      history: [
        { role: "user", content: [{ type: "input_text", text: "Remember BLUE-42." }] },
        { type: "compaction", encrypted_content: "opaque-state" },
      ],
    },
  } satisfies SessionEntry;
  const harness = createHarness([user, checkpoint]);
  const handler = harness.hooks.context;
  assert.ok(handler);

  const result = requireContextResult(
    handler(
      {
        messages: [
          {
            role: "compactionSummary",
            summary: "marker",
            tokensBefore: 1,
            timestamp: Date.now(),
          },
          { role: "user", content: "next", timestamp: Date.now() },
        ],
      },
      harness.context,
    ),
  );

  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user"],
  );
});

test("preserves validated compaction decisions in checkpoint data", () => {
  const checkpoint = {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: 1,
    modelId: "gpt-test",
    history: [{ type: "compaction", encrypted_content: "opaque-state" }],
    compactionDecision: { reason: "overflow", willRetry: true },
  };

  assert.deepEqual(parseCheckpoint(checkpoint)?.compactionDecision, {
    reason: "overflow",
    willRetry: true,
  });
  assert.equal(
    parseCheckpoint({
      ...checkpoint,
      compactionDecision: { reason: "unknown", willRetry: true },
    }),
    undefined,
  );
});

test("fails closed when runtime compaction fails", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield* [];
    throw new Error("backend failure");
  };
  const handler = harness.hooks.sessionBeforeCompact;
  assert.ok(handler);

  const result = await handler(
    {
      branchEntries: [user],
      preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    harness.context,
  );

  assert.deepEqual(result, { cancel: true });
  assert.match(harness.notices[0] ?? "", /native compaction failed/);
});

test("normalizes non-Error runtime compaction failures", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield* [];
    // oxlint-disable-next-line typescript/only-throw-error -- This test verifies normalization of an external non-Error failure.
    throw "backend failure";
  };
  const handler = harness.hooks.sessionBeforeCompact;
  assert.ok(handler);

  const result = await handler(
    {
      branchEntries: [user],
      preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    harness.context,
  );

  assert.deepEqual(result, { cancel: true });
  assert.match(harness.notices[0] ?? "", /native compaction failed with a non-Error value/);
});
