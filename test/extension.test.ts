import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

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

  assert.deepEqual(commands, ["codex-settings"]);
  assert.deepEqual(providers, []);
  assert.deepEqual(tools, ["apply_patch", "image_gen.imagegen", "web.run"]);
  assert.ok(events.includes("session_before_compact"));
  assert.ok(events.includes("session_tree"));
  assert.ok(events.includes("message_end"));
  assert.ok(events.includes("before_provider_request"));
  assert.ok(events.includes("model_select"));
});
