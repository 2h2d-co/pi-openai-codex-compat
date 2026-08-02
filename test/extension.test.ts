import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/openai-codex-compat/index.ts";

void test("registers the combined Codex compatibility extension", () => {
  const commands: string[] = [];
  const providers: string[] = [];
  const tools: string[] = [];
  const events: string[] = [];
  const pi = {
    registerCommand(name: string) {
      commands.push(name);
    },
    registerProvider(name: string) {
      providers.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    on(event: string) {
      events.push(event);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.deepEqual(commands, ["codex-settings", "codex-compat"]);
  assert.deepEqual(providers, []);
  assert.deepEqual(tools, ["apply_patch"]);
  assert.ok(events.includes("session_before_compact"));
  assert.ok(events.includes("before_provider_request"));
});
