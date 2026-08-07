import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { CodexProviderRuntime } from "../extensions/openai-codex-compat/codex-provider.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { CODEX_TURN_METADATA_HEADER } from "../extensions/openai-codex-compat/codex-metadata.ts";
import registerRemoteCompaction from "../extensions/openai-codex-compat/remote-compaction.ts";

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

function userEntry(id: string, text: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as SessionEntry;
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

function createHarness(branch: SessionEntry[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const selected = codexModel();
  const notices: string[] = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    appendEntry() {},
  } as unknown as ExtensionAPI;
  const runtime = new CodexProviderRuntime(pi, () => DEFAULT_CONFIG);
  const requests: JsonRecord[] = [];
  runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(body));
    yield* compactionEvents();
  };

  const manager = {
    getSessionId: () => "session-1",
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id ?? null,
  };
  const context = {
    model: selected,
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    scopedModels: [],
    sessionManager: manager,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: accessToken(),
        headers: {},
      }),
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      setStatus() {},
    },
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
    getSystemPrompt: () => "system prompt",
  } as unknown as ExtensionContext;

  registerRemoteCompaction(pi, runtime, () => DEFAULT_CONFIG);
  return { handlers, runtime, context, requests, notices };
}

void test("routes manual compaction through the custom provider runtime", async () => {
  const user = userEntry("user-1", "Remember BLUE-42.");
  const harness = createHarness([user]);
  const handler = harness.handlers.get("session_before_compact");
  assert.ok(handler);

  const result = (await handler(
    {
      branchEntries: [user],
      preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    harness.context,
  )) as { compaction: { details: JsonRecord; usage?: unknown } };

  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0]!;
  assert.match(JSON.stringify(request.input), /Remember BLUE-42/);
  assert.deepEqual((request.input as JsonRecord[]).at(-1), {
    type: "compaction_trigger",
  });
  const metadata = request.client_metadata as JsonRecord;
  const turnMetadata = JSON.parse(String(metadata[CODEX_TURN_METADATA_HEADER])) as JsonRecord;
  assert.deepEqual(turnMetadata["compaction"], {
    trigger: "manual",
    reason: "user_requested",
    implementation: "responses_compaction_v2",
    phase: "standalone_turn",
    strategy: "memento",
  });
  assert.equal(result.compaction.details.kind, CHECKPOINT_ENTRY_TYPE);
  assert.equal(
    (result.compaction.details.history as JsonRecord[]).at(-1)?.encrypted_content,
    "opaque-state",
  );
  assert.ok(result.compaction.usage);
});

void test("classifies every Pi compaction lifecycle in official Codex metadata", async (t) => {
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
      const handler = harness.handlers.get("session_before_compact");
      assert.ok(handler);
      await handler(
        {
          branchEntries: [user],
          preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
          reason: candidate.reason,
          willRetry: candidate.willRetry,
          signal: new AbortController().signal,
        },
        harness.context,
      );

      const metadata = harness.requests[0]?.client_metadata as JsonRecord;
      const turnMetadata = JSON.parse(String(metadata[CODEX_TURN_METADATA_HEADER])) as JsonRecord;
      assert.deepEqual(turnMetadata["compaction"], candidate.expected);
    });
  }
});

void test("captures session scope and suppresses Pi's marker summary", () => {
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
  } as SessionEntry;
  const harness = createHarness([user, checkpoint]);
  const handler = harness.handlers.get("context");
  assert.ok(handler);

  const result = handler(
    {
      messages: [
        { role: "compactionSummary", content: "marker" },
        { role: "user", content: "next", timestamp: Date.now() },
      ],
    },
    harness.context,
  ) as { messages: Array<{ role: string }> };

  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user"],
  );
});

void test("fails closed when runtime compaction fails", async () => {
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user]);
  harness.runtime.transport.request = async function* () {
    yield* [];
    throw new Error("backend failure");
  };
  const handler = harness.handlers.get("session_before_compact");
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
