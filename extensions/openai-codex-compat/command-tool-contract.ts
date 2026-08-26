import { Type } from "typebox";

export const EXEC_COMMAND_TOOL_NAME = "exec_command";
export const WRITE_STDIN_TOOL_NAME = "write_stdin";
export const SHELL_COMMAND_TOOL_NAME = "shell_command";

export type CommandToolPromptMetadata = {
  description: string;
  promptSnippet: string;
  promptGuidelines: [string];
};

function inlineCodeList(values: readonly string[]): string {
  const formatted = values.map((value) => `\`${value}\``);
  if (formatted.length === 1) return formatted[0] ?? "";
  if (formatted.length === 2) return `${formatted[0]} or ${formatted[1]}`;
  return `${formatted.slice(0, -1).join(", ")}, or ${formatted.at(-1)}`;
}

function alternativeShellDescription(shell: string, alternatives: readonly string[]): string[] {
  if (alternatives.length === 0) return [];
  return [
    `- Set \`shell\` if you want to use a shell different from ${shell}. You can use ${inlineCodeList(alternatives)}.`,
  ];
}

export function execCommandPromptMetadata(
  shell: string,
  alternativeShells: readonly string[],
): CommandToolPromptMetadata {
  return {
    promptSnippet: `Run commands using ${shell}, with optional persistent PTY sessions`,
    promptGuidelines: [
      `Use \`exec_command\` to execute commands using ${shell}; always set \`workdir\` to the directory in which the command should run. Use \`write_stdin\` to poll or interact with a session ID returned from \`exec_command\`.`,
    ],
    description: [
      `Runs a command using ${shell}, optionally in a PTY, and returns its available output and process status.`,
      ...alternativeShellDescription(shell, alternativeShells),
      "- Always set the `workdir` param when using the exec_command function. Do not use `cd` unless absolutely necessary.",
      "- If `workdir` is omitted, it defaults to the turn cwd.",
      "- The call waits up to `yield_time_ms` for the process to exit. If it exits, the result contains its output and exit code, without a session ID. If it remains running, the result contains the output produced so far and a session ID.",
      "- Pass the session ID to `write_stdin` to poll for more output or interact with the process. Each interaction returns only the output produced since the previous interaction.",
      "- Commands can inspect current Pi session and model details through the `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` environment variables.",
    ].join("\n"),
  };
}

export function writeStdinPromptMetadata(): CommandToolPromptMetadata {
  return {
    promptSnippet: "Write to or poll a long-running exec_command session",
    promptGuidelines: [
      "Use `write_stdin` only with a session ID returned from `exec_command`; omit `chars` to wait for more output or for the process to exit.",
    ],
    description: `Writes characters to or polls an existing \`exec_command\` session and returns its new output and process status.
- Pass the session ID returned from \`exec_command\` as \`session_id\`.
- Omit \`chars\` to wait for more output or for the process to exit without writing to stdin.
- If the process remains running, the result contains output produced since the previous interaction and the same session ID. If it exits, the result contains any remaining output and its exit code, without a session ID; the session is then complete.
- Arbitrary input requires an \`exec_command\` session started with \`tty: true\`; non-PTY sessions accept Ctrl-C only.`,
  };
}

export function shellCommandPromptMetadata(shell: string): CommandToolPromptMetadata {
  return {
    promptSnippet: `Run commands using ${shell}`,
    promptGuidelines: [
      `Use \`shell_command\` to execute commands using ${shell}; always set \`workdir\` to the directory in which the command should run.`,
    ],
    description: `Runs a command using ${shell} and returns its output.
- Always set the \`workdir\` param when using the shell_command function. Do not use \`cd\` unless absolutely necessary.
- If \`workdir\` is omitted, it defaults to the turn cwd.
- Commands can inspect current Pi session and model details through the \`PI_SESSION_ID\`, \`PI_SESSION_FILE\`, \`PI_PROVIDER\`, \`PI_MODEL\`, and \`PI_REASONING_LEVEL\` environment variables.`,
  };
}

const yieldTimeDescription =
  process.platform === "win32"
    ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
    : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.";

export const EXEC_COMMAND_PARAMETERS = Type.Object(
  {
    cmd: Type.String({ description: "Shell command to execute." }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory for the command. Defaults to the turn cwd.",
      }),
    ),
    shell: Type.Optional(
      Type.String({
        description: "Shell binary to launch. Defaults to the user's default shell.",
      }),
    ),
    login: Type.Optional(
      Type.Boolean({
        description:
          "True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
      }),
    ),
    tty: Type.Optional(
      Type.Boolean({
        description: "True allocates a PTY for the command; false or omitted uses plain pipes.",
      }),
    ),
    yield_time_ms: Type.Optional(Type.Number({ description: yieldTimeDescription })),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const WRITE_STDIN_PARAMETERS = Type.Object(
  {
    session_id: Type.Number({
      description: "Identifier of the running unified exec session.",
    }),
    chars: Type.Optional(
      Type.String({
        description: "Bytes to write to stdin. Defaults to empty, which polls without writing.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SHELL_COMMAND_PARAMETERS = Type.Object(
  {
    command: Type.String({
      description: "Shell script to run in the user's default shell.",
    }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory for the command. Defaults to the turn cwd.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({
        description: "Maximum command runtime. Defaults to 10000 ms.",
      }),
    ),
    login: Type.Optional(
      Type.Boolean({
        description: "True runs with login shell semantics; false disables them. Defaults to true.",
      }),
    ),
  },
  { additionalProperties: false },
);
