import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  DEFAULT_CONFIG,
  parseEnvironmentConfig,
  parseConfig,
  resolveConfig,
  withoutEnvironmentOverrides,
} from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import {
  applyCodexRequestOptions,
  applyPriorityPricing,
} from "../extensions/openai-codex-compat/request-options.ts";

void test("validates and layers Codex compatibility configuration", () => {
  assert.equal(DEFAULT_CONFIG.imageGeneration, true);
  assert.equal(DEFAULT_CONFIG.imageDetail, "auto");
  assert.equal(DEFAULT_CONFIG.webRun, false);
  assert.equal(DEFAULT_CONFIG.webSearch, "disabled");
  assert.deepEqual(
    parseConfig({
      fastMode: true,
      applyPatch: false,
      imageGeneration: false,
      imageDetail: "original",
      webRun: true,
      autoCompactAtPercent: 85,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
      reasoningMode: "pro",
    }),
    {
      fastMode: true,
      applyPatch: false,
      imageGeneration: false,
      imageDetail: "original",
      webRun: true,
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
      imageGeneration: "yes",
      imageDetail: "medium",
      webRun: null,
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

void test("parses environment overrides with highest precedence", () => {
  assert.equal(CONFIG_ENVIRONMENT_VARIABLES.webSearch, "PI_OPENAI_CODEX_COMPAT_WEB_SEARCH_MODE");

  const environmentConfig = parseEnvironmentConfig({
    [CONFIG_ENVIRONMENT_VARIABLES.fastMode]: "on",
    [CONFIG_ENVIRONMENT_VARIABLES.applyPatch]: "0",
    [CONFIG_ENVIRONMENT_VARIABLES.toolBackground]: "status",
    [CONFIG_ENVIRONMENT_VARIABLES.imageGeneration]: "false",
    [CONFIG_ENVIRONMENT_VARIABLES.imageDetail]: "original",
    [CONFIG_ENVIRONMENT_VARIABLES.webRun]: "1",
    [CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent]: "87.5",
    [CONFIG_ENVIRONMENT_VARIABLES.webSearch]: "live",
    [CONFIG_ENVIRONMENT_VARIABLES.textVerbosity]: "high",
    [CONFIG_ENVIRONMENT_VARIABLES.reasoningSummary]: "detailed",
    [CONFIG_ENVIRONMENT_VARIABLES.reasoningMode]: "pro",
  });

  assert.deepEqual(environmentConfig, {
    fastMode: true,
    applyPatch: false,
    toolBackground: "status",
    imageGeneration: false,
    imageDetail: "original",
    webRun: true,
    autoCompactAtPercent: 87.5,
    webSearch: "live",
    textVerbosity: "high",
    reasoningSummary: "detailed",
    reasoningMode: "pro",
  });
  assert.deepEqual(
    resolveConfig(
      { fastMode: false, autoCompactAtPercent: 80 },
      { fastMode: false, autoCompactAtPercent: 90 },
      environmentConfig,
    ),
    {
      ...DEFAULT_CONFIG,
      ...environmentConfig,
    },
  );
  assert.deepEqual(
    parseEnvironmentConfig({
      [CONFIG_ENVIRONMENT_VARIABLES.fastMode]: "enabled",
      [CONFIG_ENVIRONMENT_VARIABLES.applyPatch]: "disabled",
      [CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent]: "default",
    }),
    { fastMode: true, applyPatch: false, autoCompactAtPercent: null },
  );
  assert.deepEqual(
    parseEnvironmentConfig({
      [CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent]: "off",
    }),
    { autoCompactAtPercent: null },
  );
  assert.throws(
    () =>
      parseEnvironmentConfig({
        [CONFIG_ENVIRONMENT_VARIABLES.imageDetail]: "medium",
      }),
    /PI_OPENAI_CODEX_COMPAT_IMAGE_DETAIL/,
  );

  const persisted = withoutEnvironmentOverrides(
    {
      ...environmentConfig,
      autoCompactAtPercent: 87.5,
      webSearch: "cached",
    },
    { fastMode: true, autoCompactAtPercent: null },
  );
  assert.equal(Object.hasOwn(persisted, "fastMode"), false);
  assert.equal(Object.hasOwn(persisted, "autoCompactAtPercent"), false);
  assert.equal(persisted.webSearch, "cached");
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
      webSearch: "cached",
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

void test("omits the default GPT-5.6 reasoning mode", () => {
  const result = applyCodexRequestOptions(
    {
      reasoning: { effort: "high", summary: "concise", mode: "pro" },
    },
    DEFAULT_CONFIG,
    { modelId: "gpt-5.6-sol", supportsImageSearch: false },
  );

  assert.deepEqual(result["reasoning"], { effort: "high", summary: "auto" });
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

void test("uses standalone web.run instead of hosted web_search when available", () => {
  const result = applyCodexRequestOptions(
    {
      tools: [
        {
          type: "namespace",
          name: "web",
          description: "Tools in the web namespace.",
          tools: [{ type: "function", name: "run" }],
        },
        { type: "web_search", external_web_access: false },
      ],
    },
    { ...DEFAULT_CONFIG, webSearch: "live" },
    { modelId: "gpt-5.6-sol", supportsImageSearch: true },
  );

  assert.deepEqual(result.tools, [
    {
      type: "namespace",
      name: "web",
      description: "Tools in the web namespace.",
      tools: [{ type: "function", name: "run" }],
    },
  ]);
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
