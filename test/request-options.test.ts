import { requireJsonRecords } from "../extensions/openai-codex-compat/codex-protocol.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  DEFAULT_CONFIG,
  parseEnvironmentConfig,
  parseConfig,
  resolveConfig,
  withoutEnvironmentOverrides,
} from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { applyCodexRequestOptions } from "../extensions/openai-codex-compat/request-options.ts";

test("validates and layers Codex compatibility configuration", () => {
  assert.equal(DEFAULT_CONFIG.speed, "standard");
  assert.equal(DEFAULT_CONFIG.responsesLite, false);
  assert.equal(DEFAULT_CONFIG.applyPatchDebug, false);
  assert.equal(DEFAULT_CONFIG.applyPatchDiagnostics, false);
  assert.equal(DEFAULT_CONFIG.shellTool, "unified_exec");
  assert.equal(DEFAULT_CONFIG.imageGeneration, true);
  assert.equal(DEFAULT_CONFIG.imageDetail, "auto");
  assert.equal(DEFAULT_CONFIG.webRun, false);
  assert.equal(DEFAULT_CONFIG.webSearch, "disabled");
  assert.deepEqual(
    parseConfig({
      speed: "ultrafast",
      responsesLite: false,
      applyPatch: false,
      applyPatchDebug: true,
      applyPatchDiagnostics: true,
      shellTool: "shell_command",
      imageGeneration: false,
      imageDetail: "original",
      webRun: true,
      autoCompactAtPercent: 85,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
      // Removed settings: stale values are ignored.
      reasoningMode: "pro",
      fastMode: true,
    }),
    {
      speed: "ultrafast",
      responsesLite: false,
      applyPatch: false,
      applyPatchDebug: true,
      applyPatchDiagnostics: true,
      shellTool: "shell_command",
      imageGeneration: false,
      imageDetail: "original",
      webRun: true,
      autoCompactAtPercent: 85,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
    },
  );
  assert.deepEqual(
    parseConfig({
      speed: true,
      responsesLite: "yes",
      applyPatch: null,
      applyPatchDebug: "yes",
      applyPatchDiagnostics: "yes",
      shellTool: "invalid",
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
        speed: "fast",
        applyPatch: false,
        applyPatchDebug: true,
        applyPatchDiagnostics: true,
        autoCompactAtPercent: 80,
        webSearch: "live",
        textVerbosity: "high",
      },
      { autoCompactAtPercent: null, webSearch: "disabled", speed: "ultrafast" },
    ),
    {
      ...DEFAULT_CONFIG,
      speed: "ultrafast",
      applyPatch: false,
      applyPatchDebug: true,
      applyPatchDiagnostics: true,
      webSearch: "disabled",
      textVerbosity: "high",
    },
  );
});

test("parses environment overrides with highest precedence", () => {
  assert.equal(CONFIG_ENVIRONMENT_VARIABLES.webSearch, "PI_OPENAI_CODEX_COMPAT_WEB_SEARCH_MODE");
  assert.equal(CONFIG_ENVIRONMENT_VARIABLES.speed, "PI_OPENAI_CODEX_COMPAT_SPEED");

  const environmentConfig = parseEnvironmentConfig({
    [CONFIG_ENVIRONMENT_VARIABLES.speed]: " ultrafast ",
    [CONFIG_ENVIRONMENT_VARIABLES.responsesLite]: "off",
    [CONFIG_ENVIRONMENT_VARIABLES.applyPatch]: "0",
    [CONFIG_ENVIRONMENT_VARIABLES.applyPatchDebug]: "on",
    [CONFIG_ENVIRONMENT_VARIABLES.applyPatchDiagnostics]: "on",
    [CONFIG_ENVIRONMENT_VARIABLES.toolBackground]: "status",
    [CONFIG_ENVIRONMENT_VARIABLES.shellTool]: "shell_command",
    [CONFIG_ENVIRONMENT_VARIABLES.imageGeneration]: "false",
    [CONFIG_ENVIRONMENT_VARIABLES.imageDetail]: "original",
    [CONFIG_ENVIRONMENT_VARIABLES.webRun]: "1",
    [CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent]: "87.5",
    [CONFIG_ENVIRONMENT_VARIABLES.webSearch]: "live",
    [CONFIG_ENVIRONMENT_VARIABLES.textVerbosity]: "high",
    [CONFIG_ENVIRONMENT_VARIABLES.reasoningSummary]: "detailed",
  });

  assert.deepEqual(environmentConfig, {
    speed: "ultrafast",
    responsesLite: false,
    applyPatch: false,
    applyPatchDebug: true,
    applyPatchDiagnostics: true,
    toolBackground: "status",
    shellTool: "shell_command",
    imageGeneration: false,
    imageDetail: "original",
    webRun: true,
    autoCompactAtPercent: 87.5,
    webSearch: "live",
    textVerbosity: "high",
    reasoningSummary: "detailed",
  });
  assert.deepEqual(
    resolveConfig(
      { speed: "standard", autoCompactAtPercent: 80 },
      { speed: "fast", autoCompactAtPercent: 90 },
      environmentConfig,
    ),
    {
      ...DEFAULT_CONFIG,
      ...environmentConfig,
    },
  );
  assert.deepEqual(
    parseEnvironmentConfig({
      [CONFIG_ENVIRONMENT_VARIABLES.speed]: "fast",
      [CONFIG_ENVIRONMENT_VARIABLES.responsesLite]: "disabled",
      [CONFIG_ENVIRONMENT_VARIABLES.applyPatch]: "disabled",
      [CONFIG_ENVIRONMENT_VARIABLES.applyPatchDebug]: "enabled",
      [CONFIG_ENVIRONMENT_VARIABLES.applyPatchDiagnostics]: "enabled",
      [CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent]: "default",
    }),
    {
      speed: "fast",
      responsesLite: false,
      applyPatch: false,
      applyPatchDebug: true,
      applyPatchDiagnostics: true,
      autoCompactAtPercent: null,
    },
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
  // The removed boolean values are not speeds.
  assert.throws(
    () => parseEnvironmentConfig({ [CONFIG_ENVIRONMENT_VARIABLES.speed]: "on" }),
    /PI_OPENAI_CODEX_COMPAT_SPEED.*standard, fast, ultrafast/,
  );

  const persisted = withoutEnvironmentOverrides(
    {
      ...environmentConfig,
      autoCompactAtPercent: 87.5,
      webSearch: "cached",
    },
    { speed: "fast", autoCompactAtPercent: null },
  );
  assert.equal(Object.hasOwn(persisted, "speed"), false);
  assert.equal(Object.hasOwn(persisted, "autoCompactAtPercent"), false);
  assert.equal(persisted.webSearch, "cached");
});

test("applies priority and native request controls", () => {
  const payload: JsonRecord = {
    model: "gpt-5.6-sol",
    text: { format: { type: "json_schema" }, verbosity: "medium" },
    reasoning: { effort: "high", summary: "concise", mode: "pro" },
    tools: [{ type: "function", name: "read" }, { type: "web_search" }],
  };
  const result = applyCodexRequestOptions(
    payload,
    {
      ...DEFAULT_CONFIG,
      speed: "fast",
      webSearch: "cached",
    },
    { modelId: "gpt-5.6-sol", supportsImageSearch: true },
  );
  const tools = requireJsonRecords(result.tools);

  assert.equal(result.service_tier, "priority");
  assert.deepEqual(result.text, {
    format: { type: "json_schema" },
    verbosity: "low",
  });
  assert.deepEqual(result["reasoning"], { effort: "high", summary: "auto" });
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

test("requests the service tier of each speed, and Ultrafast only on GPT-6.2 Sol", () => {
  const tier = (speed: "standard" | "fast" | "ultrafast", modelId: string) =>
    applyCodexRequestOptions(
      { model: modelId },
      { ...DEFAULT_CONFIG, speed },
      { modelId, supportsImageSearch: false },
    ).service_tier;

  for (const modelId of [
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-luna",
  ]) {
    assert.equal(tier("standard", modelId), undefined, modelId);
    assert.equal(tier("fast", modelId), "priority", modelId);
  }
  assert.equal(tier("ultrafast", "gpt-6.2-sol"), "ultrafast");
  // Like the Codex CLI, Ultrafast on another model falls back to Standard rather than Fast.
  for (const modelId of ["gpt-6.2-astra", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
    assert.equal(tier("ultrafast", modelId), undefined, modelId);
  }
});

for (const modelId of ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]) {
  test(`strips reasoning.mode, which the Codex endpoint rejects, for ${modelId}`, () => {
    const payload = { reasoning: { effort: "high", summary: "concise", mode: "pro" } };
    const result = applyCodexRequestOptions(payload, DEFAULT_CONFIG, {
      modelId,
      supportsImageSearch: false,
    });
    assert.deepEqual(result["reasoning"], { effort: "high", summary: "auto" });
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "concise", mode: "pro" });
  });
}

test("disables request tools and omits unsupported reasoning mode and summary", () => {
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
  assert.deepEqual(requireJsonRecords(indexed.tools).at(-1), {
    type: "web_search",
    external_web_access: true,
    indexed_web_access: true,
  });
  assert.deepEqual(indexed.text, { verbosity: "medium" });
});

test("uses standalone web.run instead of hosted web_search when available", () => {
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
