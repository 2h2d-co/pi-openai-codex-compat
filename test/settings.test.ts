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
import {
  CONFIG_FILE,
  configLayer,
  loadConfig,
  saveConfig,
} from "../extensions/openai-codex-compat/config.ts";
import { footerModel, footerSettingLabels } from "../extensions/openai-codex-compat/footer.ts";
import registerCodexSettings, {
  settingItems,
  settingPatch,
} from "../extensions/openai-codex-compat/settings-pane.ts";
import { setApplyPatchEnabled } from "../extensions/openai-codex-compat/tools.ts";

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
    reasoningMode: "pro",
  });
  const stored = JSON.parse(await readFile(savedPath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(stored["customFutureSetting"], { keep: true });
  assert.equal(stored["fastMode"], true);
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
    applyPatch: false,
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
      ["textVerbosity", "high"],
      ["reasoningSummary", "detailed"],
      ["reasoningMode", "pro"],
      ["applyPatch", "off"],
      ["webSearch", "live"],
      ["autoCompactAtPercent", "90%"],
    ],
  );
  assert.deepEqual(settingPatch("reasoningMode", "standard"), {
    reasoningMode: "standard",
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

void test("keeps settings changes session-local until Ctrl+S", async (t) => {
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
    const context = {
      cwd,
      mode: "tui",
      isProjectTrusted: () => false,
      ui: {
        notify() {},
        async custom(factory: (...args: any[]) => any) {
          const component = await factory(
            { requestRender() {} },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            {},
            () => {},
          );
          for (const input of inputs) component.handleInput?.(input);
        },
      },
    } as unknown as ExtensionCommandContext;
    await command!("", context);
  };

  await runSettings(["\r", "\u001b"]);
  assert.equal(sessionConfig.fastMode, true);
  assert.equal(loadConfig(cwd, false).fastMode, false);

  await runSettings(["\u0013", "\u001b"]);
  assert.equal(loadConfig(cwd, false).fastMode, true);
});

void test("toggles apply_patch without changing other active tools", () => {
  let active = ["read", "apply_patch"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools(names: string[]) {
      active = names;
    },
  } as unknown as ExtensionAPI;

  setApplyPatchEnabled(pi, false);
  assert.deepEqual(active, ["read"]);
  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
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
