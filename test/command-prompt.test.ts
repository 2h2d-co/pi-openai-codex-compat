import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import type { CommandShellCatalog } from "../extensions/openai-codex-compat/command-shell.ts";
import {
  execCommandPromptMetadata,
  shellCommandPromptMetadata,
  writeStdinPromptMetadata,
} from "../extensions/openai-codex-compat/command-tool-contract.ts";
import registerCommandTools, {
  type CommandToolsApi,
} from "../extensions/openai-codex-compat/command-tools.ts";

type PromptTool = Pick<
  ToolDefinition,
  "description" | "name" | "promptGuidelines" | "promptSnippet"
>;

function registeredCommandTools(catalog: CommandShellCatalog): Map<string, PromptTool> {
  const tools = new Map<string, PromptTool>();
  const pi: CommandToolsApi = {
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  registerCommandTools(pi, () => "none", undefined, catalog);
  return tools;
}

test("renders every command-shell prompt label", () => {
  for (const shell of ["zsh", "bash", "sh", "PowerShell", "cmd"]) {
    const exec = execCommandPromptMetadata(shell, []);
    assert.equal(
      exec.promptSnippet,
      `Run commands using ${shell}, with optional persistent PTY sessions`,
    );
    assert.match(
      exec.promptGuidelines[0],
      new RegExp(String.raw`execute commands using ${shell}`, "u"),
    );
    assert.ok(exec.description.startsWith(`Runs a command using ${shell}, optionally in a PTY,`));

    const classic = shellCommandPromptMetadata(shell);
    assert.equal(classic.promptSnippet, `Run commands using ${shell}`);
    assert.match(
      classic.promptGuidelines[0],
      new RegExp(String.raw`execute commands using ${shell}`, "u"),
    );
    assert.ok(classic.description.startsWith(`Runs a command using ${shell} and returns`));
  }
});

test("renders every alternative-shell sentence shape", () => {
  const selectionLine = (alternatives: string[]): string | undefined => {
    return execCommandPromptMetadata("zsh", alternatives)
      .description.split("\n")
      .find((line) => line.startsWith("- Set `shell`"));
  };

  assert.equal(selectionLine([]), undefined);
  assert.equal(
    selectionLine(["/bin/bash"]),
    "- Set `shell` if you want to use a shell different from zsh. You can use `/bin/bash`.",
  );
  assert.equal(
    selectionLine(["/bin/bash", "/bin/sh"]),
    "- Set `shell` if you want to use a shell different from zsh. You can use `/bin/bash` or `/bin/sh`.",
  );
  assert.equal(
    selectionLine(["/one", "/two", "/three"]),
    "- Set `shell` if you want to use a shell different from zsh. You can use `/one`, `/two`, or `/three`.",
  );
});

test("registers generated command prompt metadata", () => {
  const catalog: CommandShellCatalog = {
    defaultShell: { type: "zsh", path: "/bin/zsh" },
    availableShells: [
      { type: "zsh", path: "/bin/zsh" },
      { type: "bash", path: "/bin/bash" },
      { type: "sh", path: "/bin/sh" },
    ],
  };
  const tools = registeredCommandTools(catalog);
  const exec = tools.get("exec_command");
  const write = tools.get("write_stdin");
  const classic = tools.get("shell_command");

  assert.ok(exec);
  assert.ok(write);
  assert.ok(classic);
  assert.deepEqual(
    {
      description: exec.description,
      promptGuidelines: exec.promptGuidelines,
      promptSnippet: exec.promptSnippet,
    },
    execCommandPromptMetadata("zsh", ["/bin/bash", "/bin/sh"]),
  );
  assert.deepEqual(
    {
      description: write.description,
      promptGuidelines: write.promptGuidelines,
      promptSnippet: write.promptSnippet,
    },
    writeStdinPromptMetadata(),
  );
  assert.deepEqual(
    {
      description: classic.description,
      promptGuidelines: classic.promptGuidelines,
      promptSnippet: classic.promptSnippet,
    },
    shellCommandPromptMetadata("zsh"),
  );
});

test("renders registered unified tools in Pi's default system prompt", () => {
  const catalog: CommandShellCatalog = {
    defaultShell: { type: "zsh", path: "/bin/zsh" },
    availableShells: [
      { type: "zsh", path: "/bin/zsh" },
      { type: "bash", path: "/bin/bash" },
      { type: "sh", path: "/bin/sh" },
    ],
  };
  const tools = registeredCommandTools(catalog);
  const activeTools = ["exec_command", "write_stdin"];
  const prompt = buildSystemPrompt({
    cwd: "/workspace",
    selectedTools: activeTools,
    toolSnippets: Object.fromEntries(
      activeTools.map((name) => [name, tools.get(name)?.promptSnippet ?? ""]),
    ),
    promptGuidelines: activeTools.flatMap((name) => tools.get(name)?.promptGuidelines ?? []),
  });

  assert.match(
    prompt,
    /Available tools:\n- exec_command: Run commands using zsh, with optional persistent PTY sessions\n- write_stdin: Write to or poll a long-running exec_command session/u,
  );
  assert.match(
    prompt,
    /Guidelines:\n- Use `exec_command` to execute commands using zsh; always set `workdir` to the directory in which the command should run\. Use `write_stdin` to poll or interact with a session ID returned from `exec_command`\.\n- Use `write_stdin` only with a session ID returned from `exec_command`; omit `chars` to wait for more output or for the process to exit\./u,
  );
});
