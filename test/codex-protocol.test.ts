import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  approximateTokens,
  installCompactionItem,
  messageTextTokens,
  remoteCompactionHeaders,
  remoteCompactionPayload,
  requestRemoteCompaction,
  selectRetainedContext,
  type ResponsesItem,
} from "../extensions/openai-codex-compat/codex-protocol.ts";

const codexModel = {
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

function user(text: string): ResponsesItem {
  return { role: "user", content: [{ type: "input_text", text }] };
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

void test("counts and retains context with Codex's four-byte approximation", () => {
  assert.equal(approximateTokens("abcd"), 1);
  assert.equal(approximateTokens("abcde"), 2);
  assert.equal(approximateTokens("😀"), 1);
  assert.equal(messageTextTokens(user("😀abcd")), 2);

  const history = [
    user("a".repeat(12)),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "not retained" }],
    },
    user("b".repeat(12)),
    user("c".repeat(12)),
  ] as ResponsesItem[];
  assert.deepEqual(selectRetainedContext(history, 6), [user("b".repeat(12)), user("c".repeat(12))]);

  const boundary = selectRetainedContext([user("abcdefgh"), user("ijklmnop")], 3);
  assert.equal(boundary.length, 2);
  assert.ok(messageTextTokens(boundary[0]!) <= 1);
  assert.deepEqual(boundary[1], user("ijklmnop"));
});

void test("builds the remote-compaction-v2 request and checkpoint history", () => {
  const payload = remoteCompactionPayload({
    template: {
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "medium" },
    },
    modelId: codexModel.id,
    history: [user("hello")],
    instructions: "system prompt",
    sessionId: "session-1",
    priority: true,
  });

  assert.deepEqual((payload.input as ResponsesItem[]).at(-1), {
    type: "compaction_trigger",
  });
  assert.equal(payload.service_tier, "priority");
  assert.deepEqual(payload["reasoning"], { effort: "high", summary: "auto" });
  assert.deepEqual(payload.text, { verbosity: "medium" });

  const installed = installCompactionItem(
    [user("old request"), { type: "message", role: "assistant", content: [] }],
    { type: "compaction", encrypted_content: "opaque" },
  );
  assert.deepEqual(installed[0], user("old request"));
  assert.deepEqual(installed.at(-1), {
    type: "compaction",
    encrypted_content: "opaque",
  });
});

void test("authenticates and parses remote compaction streams with priority pricing", async () => {
  const headers = remoteCompactionHeaders({
    token: accessToken(),
    sessionId: "session-1",
  });
  assert.equal(headers.get("chatgpt-account-id"), "account-1");
  assert.match(headers.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);

  const events = [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 20 },
        },
      },
    },
  ];
  const fetcher: typeof fetch = async () =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  const result = await requestRemoteCompaction({
    endpoint: "https://example.test/codex/responses",
    headers,
    payload: {},
    accountingModel: codexModel,
    priority: true,
    fetcher,
  });

  assert.equal(result.item.encrypted_content, "opaque");
  assert.equal(result.usage?.input, 80);
  assert.equal(result.usage?.cacheRead, 20);
  assert.ok(Math.abs((result.usage?.cost.total ?? 0) - 0.000204) < 1e-12);
});
