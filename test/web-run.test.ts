import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type WebSearchMode } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { CODEX_NAMESPACED_TOOL_NAMES } from "../extensions/openai-codex-compat/namespaced-tools.ts";
import { convertResponsesTools } from "../extensions/openai-codex-compat/vendor/pi-ai/openai-responses-serialization.ts";
import registerWebRun, { recentSearchInput } from "../extensions/openai-codex-compat/web-run.ts";

const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE_PATTERN, "");
}

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

void test("registers the complete reserved web.run schema and executes alpha/search", async () => {
  let tool: any;
  let webSearch: WebSearchMode = "indexed";
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
    () => ({ ...DEFAULT_CONFIG, webSearch }),
    () => DEFAULT_CONFIG.toolBackground,
    async (_model, path, body, options) => {
      requests.push({ path, body: structuredClone(body), options });
      return {
        encrypted_output: "ignored",
        output: "Raw search output that should remain collapsed.",
        results: [
          {
            type: "text_result",
            domain: "example.com",
            ref_id: "turn0search0",
            snippet: "A concise source excerpt.",
            title: "Example search result",
            url: "https://example.com/result",
          },
        ],
      };
    },
  );

  const properties = tool.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties), [
    "click",
    "finance",
    "find",
    "image_query",
    "open",
    "response_length",
    "screenshot",
    "search_query",
    "sports",
    "time",
    "weather",
  ]);
  assert.equal(
    createHash("sha256").update(tool.description).digest("hex"),
    "1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e",
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(tool.parameters)).digest("hex"),
    "cee1fb436b2d198ef7d8d2883cb3161d75f31c10fe40249480031ca2673b364c",
  );
  const wireTools = convertResponsesTools([tool], {
    supportsStrictMode: true,
    namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
  });
  assert.equal(wireTools[0]?.["type"], "namespace");
  assert.equal(wireTools[0]?.["name"], "web");
  const namespaceTools = wireTools[0]?.["tools"];
  assert.ok(Array.isArray(namespaceTools));
  assert.equal(namespaceTools[0]?.["name"], "run");
  assert.equal(namespaceTools[0]?.["strict"], false);
  assert.equal(
    createHash("sha256").update(JSON.stringify(namespaceTools[0]?.["parameters"])).digest("hex"),
    "cee1fb436b2d198ef7d8d2883cb3161d75f31c10fe40249480031ca2673b364c",
  );

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
  const commands = {
    search_query: [{ q: "Pi" }],
    finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
    sports: [{ fn: "schedule", league: "nba", team: "GSW" }],
    time: [{ utc_offset: "+03:00" }],
    weather: [{ location: "United States, California, San Francisco" }],
    response_length: "short",
  };
  const result = await tool.execute("call-web|fc-web", commands, undefined, undefined, context);

  assert.equal(tool.renderShell, "self");
  assert.equal(requests[0]?.path, "alpha/search");
  assert.deepEqual(requests[0]?.body["commands"], commands);
  assert.deepEqual(requests[0]?.body["settings"], {
    allowed_callers: ["direct"],
    external_web_access: "indexed",
  });
  assert.equal(requests[0]?.body["max_output_tokens"], 2_500);
  assert.match(JSON.stringify(requests[0]?.body["input"]), /Find current Pi documentation/);
  assert.deepEqual(result.content, [
    { type: "text", text: "Raw search output that should remain collapsed." },
  ]);
  assert.deepEqual(result.details, {
    results: [
      {
        type: "text_result",
        domain: "example.com",
        ref_id: "turn0search0",
        snippet: "A concise source excerpt.",
        title: "Example search result",
        url: "https://example.com/result",
      },
    ],
  });

  webSearch = "disabled";
  await tool.execute("call-web-disabled|fc-web-disabled", commands, undefined, undefined, context);
  assert.deepEqual(requests[1]?.body["settings"], {
    allowed_callers: ["direct"],
    external_web_access: false,
  });

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getBgAnsi: (color: string) =>
      color === "toolPendingBg" ? "\u001b[48;2;40;40;50m" : "\u001b[48;2;40;50;40m",
    getColorMode: () => "truecolor",
    name: "dark",
  } as unknown as Theme;
  const renderContext = {
    args: commands,
    toolCallId: "call-web|fc-web",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
  const callText = stripAnsi(
    tool.renderCall(commands, theme, renderContext).render(100).join("\n"),
  );
  assert.match(callText, /web\.run  search "Pi"/);
  assert.doesNotMatch(callText, /"search_query":/);

  const collapsed = tool
    .renderResult(result, { expanded: false, isPartial: false }, theme, renderContext)
    .render(100)
    .join("\n");
  const collapsedText = stripAnsi(collapsed);
  assert.match(collapsedText, /Found 1 source · example\.com/);
  assert.doesNotMatch(collapsedText, /Raw search output/);
  assert.doesNotMatch(collapsedText, /A concise source excerpt/);
  assert.ok(collapsed.includes("\u001b[48;2;26;26;33m"));

  const expandedText = stripAnsi(
    tool
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        ...renderContext,
        expanded: true,
      })
      .render(100)
      .join("\n"),
  );
  assert.match(expandedText, /Example search result/);
  assert.match(expandedText, /turn0search0/);
  assert.match(expandedText, /https:\/\/example\.com\/result/);
  assert.match(expandedText, /A concise source excerpt/);
  assert.doesNotMatch(expandedText, /Raw search output/);

  const navigationResult = {
    content: [{ type: "text", text: "Opened page title\nL10: expanded page content" }],
    details: { results: [] },
  };
  const navigationContext = {
    ...renderContext,
    args: { open: [{ ref_id: "turn0search0", lineno: 10 }] },
  };
  const collapsedNavigation = stripAnsi(
    tool
      .renderResult(
        navigationResult,
        { expanded: false, isPartial: false },
        theme,
        navigationContext,
      )
      .render(100)
      .join("\n"),
  );
  assert.match(collapsedNavigation, /Opened turn0search0/);
  assert.doesNotMatch(collapsedNavigation, /expanded page content/);
  const expandedNavigation = stripAnsi(
    tool
      .renderResult(navigationResult, { expanded: true, isPartial: false }, theme, {
        ...navigationContext,
        expanded: true,
      })
      .render(100)
      .join("\n"),
  );
  assert.match(expandedNavigation, /L10\s+│ expanded page content/);
});
