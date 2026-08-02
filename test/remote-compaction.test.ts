import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY_TYPE } from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { CONFIG_FILE, type CodexCompatConfig } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
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

function assistantEntry(id: string, parentId: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      usage: {
        input: 80_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 80_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as SessionEntry;
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

function successfulStream(encryptedContent = "opaque-state"): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function configuredProject(
  t: TestContext,
  config: Partial<CodexCompatConfig>,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-compat-compaction-"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", CONFIG_FILE), JSON.stringify(config));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function createHarness(
  t: TestContext,
  options: {
    branch?: SessionEntry[];
    percent?: number | null;
    config?: Partial<CodexCompatConfig>;
  } = {},
) {
  const selected = codexModel();
  let branch = options.branch ?? [];
  let aborted = false;
  const handlers = new Map<string, (...args: any[]) => any>();
  const notices: string[] = [];
  const authenticatedModels: Model<any>[] = [];
  const cwd = await configuredProject(t, options.config ?? {});

  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    appendEntry(customType: string, data: unknown) {
      const entry = {
        type: "custom",
        id: `custom-${branch.length}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } as SessionEntry;
      branch = [...branch, entry];
    },
  } as unknown as ExtensionAPI;

  const context = {
    model: selected,
    cwd,
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    scopedModels: [],
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "openai-codex" && id === selected.id ? selected : undefined,
      getApiKeyAndHeaders: async (model: Model<any>) => {
        authenticatedModels.push(model);
        return { ok: true, apiKey: accessToken(), headers: {} };
      },
    },
    ui: {
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
    },
    isProjectTrusted: () => true,
    getContextUsage: () => ({
      tokens: options.percent === null ? null : (options.percent ?? 10) * 1_000,
      contextWindow: 100_000,
      percent: options.percent ?? 10,
    }),
    getSystemPrompt: () => "system prompt",
    abort() {
      aborted = true;
    },
  };

  registerRemoteCompaction(pi);
  return {
    handlers,
    context,
    notices,
    authenticatedModels,
    branch: () => branch,
    replaceBranch(next: SessionEntry[]) {
      branch = next;
    },
    aborted: () => aborted,
  };
}

void test("uses canonical Codex auth and configured priority tier for compaction", async (t) => {
  let requestUrl = "";
  let requestBody: JsonRecord = {};
  let requestHeaders = new Headers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    if (typeof body !== "string") assert.fail("Expected a string request body");
    requestBody = JSON.parse(body) as JsonRecord;
    requestHeaders = new Headers(init?.headers);
    return successfulStream();
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const user = userEntry("user-1", "Remember BLUE-42.");
  const harness = await createHarness(t, {
    branch: [user],
    config: { fastMode: true },
  });
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
  )) as { cancel?: boolean; compaction: { details: JsonRecord } };

  assert.equal(result.cancel, undefined);
  assert.equal(result.compaction.details.kind, CHECKPOINT_ENTRY_TYPE);
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(requestBody.service_tier, "priority");
  assert.deepEqual((requestBody.input as JsonRecord[]).at(-1), {
    type: "compaction_trigger",
  });
  assert.match(requestHeaders.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
  assert.equal(harness.authenticatedModels[0]?.provider, "openai-codex");
  assert.equal(harness.handlers.has("session_before_tree"), false);
});

void test("replays opaque checkpoint history instead of Pi's marker summary", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => successfulStream();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = userEntry("user-1", "Remember BLUE-42.");
  const harness = await createHarness(t, { branch: [first] });
  const compact = harness.handlers.get("session_before_compact");
  const patchRequest = harness.handlers.get("before_provider_request");
  assert.ok(compact);
  assert.ok(patchRequest);

  const compacted = (await compact(
    {
      branchEntries: [first],
      preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    harness.context,
  )) as { compaction: { summary: string; details: unknown } };

  const checkpoint = {
    type: "compaction",
    id: "compact-1",
    parentId: "user-1",
    timestamp: new Date().toISOString(),
    summary: compacted.compaction.summary,
    firstKeptEntryId: "user-1",
    tokensBefore: 50_000,
    details: compacted.compaction.details,
  } as SessionEntry;
  const next = userEntry("user-2", "What was the code?", "compact-1");
  harness.replaceBranch([first, checkpoint, next]);

  const patched = (await patchRequest(
    {
      payload: {
        model: "gpt-test",
        input: [{ role: "user", content: compacted.compaction.summary }],
      },
    },
    harness.context,
  )) as JsonRecord;
  const input = patched.input as JsonRecord[];

  assert.doesNotMatch(JSON.stringify(patched), new RegExp(compacted.compaction.summary));
  assert.equal(input[0]?.role, "user");
  assert.equal(input[1]?.type, "compaction");
  assert.equal(input[1]?.encrypted_content, "opaque-state");
  assert.equal(input[2]?.role, "user");
});

void test("auto-compacts at the configured inclusive percentage threshold", async (t) => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    return successfulStream("automatic-state");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const user = userEntry("user-1", "continue");
  const assistant = assistantEntry("assistant-1", "user-1");
  const harness = await createHarness(t, {
    branch: [user, assistant],
    percent: 80,
    config: { autoCompactAtPercent: 80 },
  });
  const handler = harness.handlers.get("before_provider_request");
  assert.ok(handler);
  const patched = (await handler(
    {
      payload: {
        model: "gpt-test",
        input: [{ role: "user", content: [{ type: "input_text", text: "continue" }] }],
      },
    },
    harness.context,
  )) as JsonRecord;

  assert.equal(requests, 1);
  assert.equal((patched.input as JsonRecord[]).at(-1)?.encrypted_content, "automatic-state");
  assert.equal(harness.branch().at(-1)?.type, "custom");
  assert.match(harness.notices[0] ?? "", /80\.0%/);
});

void test("cancels Pi compaction rather than falling back after a remote failure", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const user = userEntry("user-1", "hello");
  const harness = await createHarness(t, { branch: [user] });
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
  assert.equal(harness.aborted(), false);
});
