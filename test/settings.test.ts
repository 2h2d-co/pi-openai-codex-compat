import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  CONFIG_FILE,
  DEFAULT_CONFIG,
} from "../extensions/openai-codex-compat/config.ts";
import registerCodexSettings, {
  settingFields,
  type CodexSettingsContext,
  type CodexSettingsHandler,
} from "../extensions/openai-codex-compat/settings-pane.ts";
import { footerModel, footerSettingLabels } from "../extensions/openai-codex-compat/footer.ts";
import {
  setApplyPatchEnabled,
  setCodexCommandTool,
  syncCodexTools,
  type CodexToolActivationApi,
} from "../extensions/openai-codex-compat/tools.ts";

test("Codex settings stage edits, block command-session loss, and persist only changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-settings-"));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
  await mkdir(join(root, "agent"));
  t.after(async () => {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    await rm(root, { recursive: true, force: true });
  });
  initTheme("dark", false);
  let current = { ...DEFAULT_CONFIG };
  let command: CodexSettingsHandler | undefined;
  let component: Component | undefined;
  let processes = true;
  let report: (text: string) => void = () => {};
  registerCodexSettings(
    {
      registerCommand: (_name, entry) => {
        command = entry.handler;
      },
    },
    {
      getConfig: () => current,
      hasPersistentSessions: () => processes,
      onChange: (config) => {
        current = config;
      },
    },
  );
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const ctx: CodexSettingsContext = {
    cwd: root,
    mode: "tui",
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "synthetic" },
    isProjectTrusted: () => false,
    isIdle: () => true,
    waitForIdle: async () => {},
    ui: {
      notify: (message) => assert.fail(message),
      custom: (factory) =>
        new Promise((resolve) => {
          component = factory(
            {
              requestRender: () => {
                report(component?.render(160).join("\n") ?? "");
              },
            },
            { fg: (_color, text) => text, bold: (text) => text },
            getKeybindings(),
            resolve,
          );
          component.render(160);
          opened();
        }),
    },
  };
  assert.ok(command);
  const pending = command("", ctx);
  await ready;
  assert.ok(component);
  component.handleInput?.("Command tool");
  component.handleInput?.("\r");
  component.handleInput?.("\u001b[B");
  component.handleInput?.("\r");
  assert.equal(current.shellTool, "unified_exec");
  const blocked = new Promise<void>((resolve) => {
    report = (text) => {
      if (text.includes("Collect pending output")) resolve();
    };
  });
  component.handleInput?.("\u0013");
  await blocked;
  assert.equal(current.shellTool, "unified_exec");
  processes = false;
  const saved = new Promise<void>((resolve) => {
    report = (text) => {
      if (text.includes("Saved and applied")) resolve();
    };
  });
  component.handleInput?.("\u0013");
  await saved;
  assert.equal(current.shellTool, "shell_command");
  const data: unknown = JSON.parse(await readFile(join(root, "agent", CONFIG_FILE), "utf8"));
  assert.deepEqual(data, { shellTool: "shell_command" });
  component.handleInput?.("\u001b");
  await pending;
});

test("every configuration key has an editor without stale model lists", () => {
  assert.deepEqual(
    settingFields.map((field) => field.id).sort(),
    Object.keys(CONFIG_ENVIRONMENT_VARIABLES).sort(),
  );
  assert.equal(
    settingFields.find((field) => field.id === "autoCompactAtPercent")?.number?.integer,
    undefined,
  );
  assert.deepEqual(
    footerSettingLabels({
      ...DEFAULT_CONFIG,
      fastMode: true,
      reasoningMode: "pro",
      textVerbosity: "high",
      reasoningSummary: "detailed",
    }),
    ["fast", "pro", "verbosity high", "summary detailed"],
  );
  assert.equal(footerModel(model, "high", DEFAULT_CONFIG)?.id, "gpt-test");
});

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
} satisfies Model<Api>;

test("uses apply_patch instead of Pi's active edit and write tools", () => {
  let active = ["read", "edit", "write"];
  const pi: CodexToolActivationApi = {
    getActiveTools: () => active,
    setActiveTools(names) {
      active = names;
    },
  };
  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, false);
  assert.deepEqual(active, ["read", "edit", "write"]);
});

test("does not restore Pi edit tools that were inactive before apply_patch", () => {
  let active = ["read"];
  const pi: CodexToolActivationApi = {
    getActiveTools: () => active,
    setActiveTools(names) {
      active = names;
    },
  };
  setApplyPatchEnabled(pi, true);
  assert.deepEqual(active, ["read", "apply_patch"]);
  setApplyPatchEnabled(pi, false);
  assert.deepEqual(active, ["read"]);
});

test("replaces only an active Pi bash tool with the selected Codex command family", () => {
  let active = ["read", "bash", "exec_command", "write_stdin", "shell_command"];
  const pi: CodexToolActivationApi = {
    getActiveTools: () => active,
    setActiveTools(names) {
      active = names;
    },
  };
  assert.equal(setCodexCommandTool(pi, "unified_exec"), true);
  assert.deepEqual(active, ["read", "exec_command", "write_stdin"]);
  assert.equal(setCodexCommandTool(pi, "shell_command"), false);
  assert.deepEqual(active, ["read", "shell_command"]);
  assert.equal(setCodexCommandTool(pi, undefined), false);
  assert.deepEqual(active, ["read", "bash"]);
});

test("does not bypass a Pi session that started without bash", () => {
  let active = ["read", "exec_command", "write_stdin", "shell_command"];
  const pi: CodexToolActivationApi = {
    getActiveTools: () => active,
    setActiveTools(names) {
      active = names;
    },
  };
  assert.equal(setCodexCommandTool(pi, "unified_exec"), false);
  assert.deepEqual(active, ["read"]);
  setCodexCommandTool(pi, undefined);
  assert.deepEqual(active, ["read"]);
});

test("toggles image_gen.imagegen and web.run independently on Codex models", () => {
  let active = ["read", "edit", "write"];
  const pi: CodexToolActivationApi = {
    getActiveTools: () => active,
    setActiveTools(names) {
      active = names;
    },
  };
  syncCodexTools(pi, model, {
    ...DEFAULT_CONFIG,
    applyPatch: false,
    imageGeneration: true,
    webRun: false,
  });
  assert.deepEqual(active, ["read", "edit", "write", "image_gen.imagegen"]);
  for (const webSearch of ["cached", "disabled"] as const) {
    syncCodexTools(pi, model, {
      ...DEFAULT_CONFIG,
      applyPatch: false,
      imageGeneration: false,
      webRun: true,
      webSearch,
    });
    assert.deepEqual(active, ["read", "edit", "write", "web.run"]);
  }
});
