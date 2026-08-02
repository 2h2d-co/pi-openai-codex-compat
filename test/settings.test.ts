import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, loadConfig, saveConfig } from "../extensions/openai-codex-compat/config.ts";
import { settingItems, settingPatch } from "../extensions/openai-codex-compat/settings-pane.ts";
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
  const items = settingItems({
    fastMode: true,
    applyPatch: false,
    webSearch: "live",
    textVerbosity: "high",
    reasoningSummary: "detailed",
    reasoningMode: "pro",
    autoCompactAtPercent: 90,
  });

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
