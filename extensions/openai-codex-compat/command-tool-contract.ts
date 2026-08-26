import { Type } from "typebox";

export const EXEC_COMMAND_TOOL_NAME = "exec_command";
export const WRITE_STDIN_TOOL_NAME = "write_stdin";
export const SHELL_COMMAND_TOOL_NAME = "shell_command";

const WINDOWS_SHELL_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

export const EXEC_COMMAND_DESCRIPTION =
  process.platform === "win32"
    ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n${WINDOWS_SHELL_GUIDANCE}`
    : "Runs a command in a PTY, returning output or a session ID for ongoing interaction.";

export const WRITE_STDIN_DESCRIPTION =
  "Writes characters to an existing unified exec session and returns recent output.";

export const SHELL_COMMAND_DESCRIPTION =
  process.platform === "win32"
    ? `Runs a Powershell command (Windows) and returns its output.

Examples of valid command strings:

- ls -a (show hidden): "Get-ChildItem -Force"
- recursive find by name: "Get-ChildItem -Recurse -Filter *.py"
- recursive grep: "Get-ChildItem -Path C:\\\\myrepo -Recurse | Select-String -Pattern 'TODO' -CaseSensitive"
- ps aux | grep python: "Get-Process | Where-Object { $_.ProcessName -like '*python*' }"
- setting an env var: "$env:FOO='bar'; echo $env:FOO"
- running an inline Python script: "@'\\\\nprint('Hello, world!')\\\\n'@ | python -"

${WINDOWS_SHELL_GUIDANCE}`
    : `Runs a shell command and returns its output.
- Always set the \`workdir\` param when using the shell_command function. Do not use \`cd\` unless absolutely necessary.`;

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
