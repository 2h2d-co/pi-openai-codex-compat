import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/openai-codex-compat/index.ts";

void test("registers the codex-compat command", () => {
  const commands: string[] = [];
  const pi = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.deepEqual(commands, ["codex-compat"]);
});
