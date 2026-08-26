import assert from "node:assert/strict";
import test from "node:test";

import extension from "../extensions/index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionRegistrationRecording = {
  commands: string[];
  events: string[];
  providers: string[];
  tools: string[];
};

function recordingExtensionApi(recording: ExtensionRegistrationRecording): ExtensionAPI {
  // oxlint-disable-next-line typescript/no-unsafe-return -- This guarded broad third-party API boundary lets the focused wiring test fail immediately on every unimplemented member.
  return Object.assign(Object.create(null), {
    appendEntry() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    on(event: string) {
      recording.events.push(event);
    },
    registerCommand(name: string) {
      recording.commands.push(name);
    },
    registerProvider(name: string) {
      recording.providers.push(name);
    },
    registerTool(tool: { name: string }) {
      recording.tools.push(tool.name);
    },
    sendMessage() {},
    setActiveTools() {},
    setModel: async () => true,
  });
}

test("registers the combined Codex compatibility extension", () => {
  const recording: ExtensionRegistrationRecording = {
    commands: [],
    events: [],
    providers: [],
    tools: [],
  };

  extension(recordingExtensionApi(recording));

  assert.deepEqual(recording.commands, ["ps", "codex-settings"]);
  assert.deepEqual(recording.providers, []);
  assert.deepEqual(recording.tools, [
    "exec_command",
    "write_stdin",
    "shell_command",
    "apply_patch",
    "image_gen.imagegen",
    "web.run",
  ]);
  for (const event of [
    "session_start",
    "session_before_compact",
    "session_tree",
    "message_end",
    "before_provider_request",
    "model_select",
  ]) {
    assert.ok(recording.events.includes(event), `missing ${event} registration`);
  }
});
