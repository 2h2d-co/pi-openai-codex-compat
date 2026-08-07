import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  configLayer,
  loadConfig,
  saveConfig,
} from "../extensions/openai-codex-compat/config.ts";
import { footerModel, footerSettingLabels } from "../extensions/openai-codex-compat/footer.ts";
import registerCodexSettings, {
  settingItems,
  settingPatch,
} from "../extensions/openai-codex-compat/settings-pane.ts";
import { setApplyPatchEnabled, syncCodexTools } from "../extensions/openai-codex-compat/tools.ts";

void test("persists dedicated settings without discarding unknown configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(
    join(agentDir, CONFIG_FILE),
    JSON.stringify({ fastMode: false, customFutureSetting: { keep: true } }),
  );
  const savedPath = await saveConfig(cwd, false, {
    fastMode: true,
    responsesLite: false,
    toolBackground: "none",
    imageGeneration: false,
    imageDetail: "high",
    webRun: false,
    reasoningMode: "pro",
  });
  const stored = JSON.parse(await readFile(savedPath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(stored["customFutureSetting"], { keep: true });
  assert.equal(stored["fastMode"], true);
  assert.equal(stored["responsesLite"], false);
  assert.equal(stored["toolBackground"], "none");
  assert.equal(stored["imageGeneration"], false);
  assert.equal(stored["imageDetail"], "high");
  assert.equal(stored["webRun"], false);
  assert.equal(stored["reasoningMode"], "pro");
  assert.equal(loadConfig(cwd, false).fastMode, true);
});

void test("updates an existing trusted project settings file instead of global settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-project-settings-"));
  const projectDir = join(root, ".pi");
  await mkdir(projectDir, { recursive: true });
  const projectPath = join(projectDir, CONFIG_FILE);
  await writeFile(projectPath, JSON.stringify({ webSearch: "cached" }));
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(await saveConfig(root, true, { webSearch: "disabled" }), projectPath);
  assert.equal(loadConfig(root, true).webSearch, "disabled");
});

void test("exposes every request and tool control in the settings pane", () => {
  const config = {
    fastMode: true,
    responsesLite: false,
    toolBackground: "status",
    applyPatch: false,
    imageGeneration: true,
    imageDetail: "original",
    webRun: false,
    webSearch: "live",
    textVerbosity: "high",
    reasoningSummary: "detailed",
    reasoningMode: "pro",
    autoCompactAtPercent: 90,
  } as const;
  const items = settingItems(config);

  assert.deepEqual(
    items.map((item) => [item.id, item.currentValue]),
    [
      ["fastMode", "on"],
      ["responsesLite", "off"],
      ["textVerbosity", "high"],
      ["reasoningSummary", "detailed"],
      ["reasoningMode", "pro"],
      ["toolBackground", "status"],
      ["applyPatch", "off"],
      ["imageGeneration", "on"],
      ["imageDetail", "original"],
      ["webRun", "off"],
      ["webSearch", "live"],
      ["autoCompactAtPercent", "90%"],
    ],
  );
  assert.deepEqual(settingPatch("reasoningMode", "standard"), {
    reasoningMode: "standard",
  });
  assert.deepEqual(settingPatch("responsesLite", "on"), {
    responsesLite: true,
  });
  assert.deepEqual(settingPatch("toolBackground", "none"), {
    toolBackground: "none",
  });
  assert.deepEqual(settingPatch("imageGeneration", "off"), {
    imageGeneration: false,
  });
  assert.deepEqual(settingPatch("imageDetail", "high"), {
    imageDetail: "high",
  });
  assert.deepEqual(settingPatch("webRun", "on"), {
    webRun: true,
  });
  assert.deepEqual(settingPatch("autoCompactAtPercent", "Pi default"), {
    autoCompactAtPercent: null,
  });
  assert.deepEqual(configLayer(config), config);
  assert.deepEqual(footerSettingLabels(config), [
    "fast",
    "pro",
    "verbosity high",
    "summary detailed",
  ]);
  assert.equal(
    footerModel(
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://example.test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 10_000,
      },
      "xhigh",
      config,
    )?.id,
    "gpt-5.6-sol • xhigh • fast • pro • verbosity high • summary detailed",
  );
});

void test("marks environment-controlled settings as locked", () => {
  const items = settingItems(
    { ...DEFAULT_CONFIG, fastMode: true, autoCompactAtPercent: 90 },
    { fastMode: true, autoCompactAtPercent: 90 },
  );
  const fastMode = items.find((item) => item.id === "fastMode");
  const threshold = items.find((item) => item.id === "autoCompactAtPercent");
  const applyPatch = items.find((item) => item.id === "applyPatch");

  assert.equal(fastMode?.currentValue, "on (env)");
  assert.equal(fastMode?.values, undefined);
  assert.match(fastMode?.description ?? "", new RegExp(CONFIG_ENVIRONMENT_VARIABLES.fastMode));
  assert.equal(threshold?.currentValue, "90% (env)");
  assert.equal(threshold?.values, undefined);
  assert.deepEqual(applyPatch?.values, ["off", "on"]);
});

void test("saves on Enter or Ctrl+S and discards unsaved changes on Escape", async (t) => {
  initTheme("dark", false);
  const root = await mkdtemp(join(tmpdir(), "pi-codex-session-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, CONFIG_FILE), JSON.stringify({ fastMode: false }));
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  let sessionConfig = loadConfig(cwd, false);
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand(
      _name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      command = options.handler;
    },
  } as unknown as ExtensionAPI;
  registerCodexSettings(pi, {
    getConfig: () => sessionConfig,
    onChange: (config) => {
      sessionConfig = config;
    },
  });
  assert.ok(command);

  const runSettings = async (inputs: string[]) => {
    let closeCount = 0;
    const context = {
      cwd,
      mode: "tui",
      isProjectTrusted: () => false,
      ui: {
        notify() {},
        async custom(factory: (...args: any[]) => any) {
          let resolveDone: (() => void) | undefined;
          const closed = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          const component = factory(
            { requestRender() {} },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            {
              matches: (data: string, id: string) =>
                id === "tui.select.cancel" && (data === "\u001b" || data === "\u0003"),
            },
            () => {
              closeCount++;
              resolveDone?.();
            },
          );
          for (const input of inputs) component.handleInput?.(input);
          await closed;
        },
      },
    } as unknown as ExtensionCommandContext;
    await command!("", context);
    return closeCount;
  };

  assert.equal(await runSettings([" ", "\u001b"]), 1);
  assert.equal(sessionConfig.fastMode, false);
  assert.equal(loadConfig(cwd, false).fastMode, false);

  assert.equal(await runSettings([" ", "\r"]), 1);
  assert.equal(sessionConfig.fastMode, true);
  assert.equal(loadConfig(cwd, false).fastMode, true);

  assert.equal(await runSettings([" ", "\u0013", " ", "\u001b"]), 1);
  assert.equal(sessionConfig.fastMode, false);
  assert.equal(loadConfig(cwd, false).fastMode, false);
});

void test("uses apply_patch instead of Pi's active edit and write tools", () => {
  let active = ["read", "edit", "write"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
  } as unknown as ExtensionAPI;

  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, false);
  assert.deepEqual(active, ["read", "edit", "write"]);
});

void test("does not restore Pi edit tools that were inactive before apply_patch", () => {
  let active = ["read"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
  } as unknown as ExtensionAPI;

  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, false);
  assert.deepEqual(active, ["read"]);
});

void test("toggles image_gen.imagegen and web.run independently on Codex models", () => {
  let active = ["read", "edit", "write"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
  } as unknown as ExtensionAPI;
  const model = {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  } as Model<any>;

  syncCodexTools(pi, model, {
    ...DEFAULT_CONFIG,
    applyPatch: false,
    imageGeneration: true,
    webRun: false,
  });
  assert.deepEqual(active, ["read", "edit", "write", "image_gen.imagegen"]);

  syncCodexTools(pi, model, {
    ...DEFAULT_CONFIG,
    applyPatch: false,
    imageGeneration: false,
    webRun: true,
    webSearch: "cached",
  });
  assert.deepEqual(active, ["read", "edit", "write", "web.run"]);

  syncCodexTools(pi, model, {
    ...DEFAULT_CONFIG,
    applyPatch: false,
    imageGeneration: false,
    webRun: true,
    webSearch: "disabled",
  });
  assert.deepEqual(active, ["read", "edit", "write", "web.run"]);
});

void test("refuses to replace invalid existing settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-invalid-settings-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const filePath = join(agentDir, CONFIG_FILE);
  await writeFile(filePath, "{ not valid json");
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(saveConfig(root, false, { fastMode: true }), /Cannot update/);
  assert.equal(await readFile(filePath, "utf8"), "{ not valid json");
});
