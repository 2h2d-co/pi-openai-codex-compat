import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONFIG,
  parseConfig,
  resolveConfig,
} from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import {
  applyCodexRequestOptions,
  applyPriorityPricing,
} from "../extensions/openai-codex-compat/request-options.ts";

void test("validates and layers Codex compatibility configuration", () => {
  assert.deepEqual(
    parseConfig({
      fastMode: true,
      applyPatch: false,
      autoCompactAtPercent: 85,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
      reasoningMode: "pro",
    }),
    {
      fastMode: true,
      applyPatch: false,
      autoCompactAtPercent: 85,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
      reasoningMode: "pro",
    },
  );
  assert.deepEqual(
    parseConfig({
      fastMode: "yes",
      applyPatch: null,
      autoCompactAtPercent: 0,
      webSearch: "invalid",
      textVerbosity: false,
      reasoningSummary: "verbose",
      reasoningMode: "ultra",
    }),
    {},
  );

  assert.deepEqual(
    resolveConfig(
      {
        fastMode: true,
        applyPatch: false,
        autoCompactAtPercent: 80,
        webSearch: "live",
        textVerbosity: "high",
        reasoningMode: "pro",
      },
      { autoCompactAtPercent: null, webSearch: "disabled", fastMode: false },
    ),
    {
      ...DEFAULT_CONFIG,
      applyPatch: false,
      webSearch: "disabled",
      textVerbosity: "high",
      reasoningMode: "pro",
    },
  );
});

void test("applies priority, GPT-5.6 reasoning mode, and native request controls", () => {
  const payload: JsonRecord = {
    model: "gpt-5.6-sol",
    text: { format: { type: "json_schema" }, verbosity: "medium" },
    reasoning: { effort: "high", summary: "concise" },
    tools: [{ type: "function", name: "read" }, { type: "web_search" }],
  };
  const result = applyCodexRequestOptions(
    payload,
    {
      ...DEFAULT_CONFIG,
      fastMode: true,
      reasoningMode: "pro",
    },
    { modelId: "gpt-5.6-sol", supportsImageSearch: true },
  );
  const tools = result.tools as JsonRecord[];

  assert.equal(result.service_tier, "priority");
  assert.deepEqual(result.text, {
    format: { type: "json_schema" },
    verbosity: "low",
  });
  assert.deepEqual(result["reasoning"], { effort: "high", summary: "auto", mode: "pro" });
  assert.equal(tools.filter((tool) => tool.type === "web_search").length, 1);
  assert.deepEqual(tools.at(-1), {
    type: "web_search",
    external_web_access: false,
    search_content_types: ["text", "image"],
  });
  assert.deepEqual(payload.text, {
    format: { type: "json_schema" },
    verbosity: "medium",
  });
});

void test("disables request tools and omits unsupported reasoning mode and summary", () => {
  const disabled = applyCodexRequestOptions(
    {
      service_tier: "flex",
      reasoning: { effort: "medium", summary: "auto", mode: "pro" },
      tools: [{ type: "function", name: "read" }, { type: "web_search" }],
    },
    { ...DEFAULT_CONFIG, webSearch: "disabled", reasoningSummary: "off" },
    { modelId: "gpt-5.5", supportsImageSearch: false },
  );

  assert.equal(disabled.service_tier, "flex");
  assert.deepEqual(disabled["reasoning"], { effort: "medium" });
  assert.deepEqual(disabled.tools, [{ type: "function", name: "read" }]);

  const indexed = applyCodexRequestOptions(
    { tools: [] },
    { ...DEFAULT_CONFIG, webSearch: "indexed", textVerbosity: "medium" },
    { modelId: "gpt-5.6-terra", supportsImageSearch: false },
  );
  assert.deepEqual((indexed.tools as JsonRecord[]).at(-1), {
    type: "web_search",
    external_web_access: true,
    indexed_web_access: true,
  });
  assert.deepEqual(indexed.text, { verbosity: "medium" });
});

void test("recomputes canonical priority-tier costs after payload modification", () => {
  const model = {
    id: "gpt-5.5",
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  } as Model<any>;
  const message = {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;

  const priced = applyPriorityPricing(message, model);
  assert.equal(priced.usage.cost.total, 0.0005);
  assert.equal(message.usage.cost.total, 3996);
});
