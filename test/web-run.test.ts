import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import registerWebRun, { recentSearchInput } from "../extensions/openai-codex-compat/web-run.ts";

function codexModel(): Model<any> {
  return {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
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

void test("retains only the latest two visible user turns for standalone search", () => {
  const input = recentSearchInput([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "old user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "old assistant" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "previous user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "previous assistant" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "current user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "current commentary" }],
    },
  ]);

  assert.deepEqual(input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "previous user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "previous assistant" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "current user" }],
    },
  ]);
});

void test("registers a restricted web.run schema and executes alpha/search", async () => {
  let tool: any;
  const requests: Array<{
    path: string;
    body: JsonRecord;
    options: Record<string, unknown>;
  }> = [];
  const branch = [userEntry("user-1", "Find current Pi documentation.")];
  const pi = {
    registerTool(definition: unknown) {
      tool = definition;
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerWebRun(
    pi,
    () => ({ ...DEFAULT_CONFIG, webSearch: "indexed" }),
    async (_model, path, body, options) => {
      requests.push({ path, body: structuredClone(body), options });
      return {
        encrypted_output: "ignored",
        output: "Search result",
        results: [{ type: "text_result", ref_id: "turn0search0" }],
      };
    },
  );

  const properties = tool.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties), [
    "search_query",
    "image_query",
    "open",
    "click",
    "find",
    "screenshot",
    "response_length",
  ]);
  for (const unsupported of ["finance", "sports", "weather", "time"]) {
    assert.equal(properties[unsupported], undefined);
  }

  const context = {
    model: codexModel(),
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "token",
        headers: { "x-test": "value" },
      }),
    },
  } as unknown as ExtensionContext;
  const result = await tool.execute(
    "call-web|fc-web",
    { search_query: [{ q: "Pi" }], response_length: "short" },
    undefined,
    undefined,
    context,
  );

  assert.equal(requests[0]?.path, "alpha/search");
  assert.deepEqual(requests[0]?.body["commands"], {
    search_query: [{ q: "Pi" }],
    response_length: "short",
  });
  assert.deepEqual(requests[0]?.body["settings"], {
    allowed_callers: ["direct"],
    external_web_access: "indexed",
  });
  assert.equal(requests[0]?.body["max_output_tokens"], 2_500);
  assert.match(JSON.stringify(requests[0]?.body["input"]), /Find current Pi documentation/);
  assert.deepEqual(result.content, [{ type: "text", text: "Search result" }]);
  assert.deepEqual(result.details, {
    results: [{ type: "text_result", ref_id: "turn0search0" }],
  });
});
