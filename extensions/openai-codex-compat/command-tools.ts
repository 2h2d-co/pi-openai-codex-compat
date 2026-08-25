import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeShellCommand,
  UnifiedExecManager,
  type ExecCommandRequest,
  type ShellCommandRequest,
  type WriteStdinRequest,
} from "./command-runtime.ts";
import type { CommandProcessSpawner } from "./command-process.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { renderCommandCall, renderCommandResult } from "./command-render.ts";

export const EXEC_COMMAND_TOOL_NAME = "exec_command";
export const WRITE_STDIN_TOOL_NAME = "write_stdin";
export const SHELL_COMMAND_TOOL_NAME = "shell_command";

const yieldTimeDescription =
  process.platform === "win32"
    ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
    : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.";

export const EXEC_COMMAND_PARAMETERS = Type.Object(
  {
    cmd: Type.String({ description: "Shell command to execute." }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory for the command. Defaults to the Pi session cwd.",
      }),
    ),
    shell: Type.Optional(
      Type.String({
        description: "Shell binary to launch. Defaults to Pi's bash-compatible shell.",
      }),
    ),
    login: Type.Optional(
      Type.Boolean({
        description: "True runs the shell with login semantics. Defaults to true.",
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
          "Output token budget. Defaults to 10000 approximate tokens and is capped by Pi's output policy.",
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
        description:
          "Characters to write to stdin. Defaults to empty, which polls without writing.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 approximate tokens and is capped by Pi's output policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SHELL_COMMAND_PARAMETERS = Type.Object(
  {
    command: Type.String({
      description: "Shell script to run in Pi's bash-compatible shell.",
    }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory for the command. Defaults to the Pi session cwd.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({
        description:
          "Maximum command runtime. Defaults to 10000 ms and cannot exceed 2147483647 ms.",
      }),
    ),
    login: Type.Optional(
      Type.Boolean({
        description: "True runs with login shell semantics. Defaults to true.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type CommandToolsApi = Pick<ExtensionAPI, "on" | "registerTool">;

export type CommandToolsController = {
  terminateUnifiedExecSessions: () => void;
};

function writeStdinSummary(request: Partial<WriteStdinRequest>): string {
  const id = typeof request.session_id === "number" ? request.session_id : "?";
  const chars = typeof request.chars === "string" ? request.chars : "";
  if (!chars) return `poll session ${id}`;
  const singleLine = chars.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return `write ${JSON.stringify(singleLine)} to session ${id}`;
}

export default function registerCommandTools(
  pi: CommandToolsApi,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  spawnProcess?: CommandProcessSpawner,
): CommandToolsController {
  const manager = new UnifiedExecManager(spawnProcess);

  pi.registerTool({
    name: EXEC_COMMAND_TOOL_NAME,
    label: EXEC_COMMAND_TOOL_NAME,
    description:
      "Runs a shell command, returning output immediately when it finishes or a session ID for ongoing interaction. Output has Pi's 2000-line/50KB hard cap and saves complete truncated output to a temp file.",
    promptSnippet: "Run shell commands with optional persistent PTY sessions",
    promptGuidelines: [
      "Use exec_command for shell commands and use write_stdin to poll or interact with a returned session ID.",
    ],
    parameters: EXEC_COMMAND_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return manager.execCommand(params satisfies ExecCommandRequest, ctx, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        EXEC_COMMAND_TOOL_NAME,
        typeof args.cmd === "string" ? args.cmd : "",
        theme,
        context,
        resolveToolBackground,
      );
    },
    renderResult(result, options, theme, context) {
      return renderCommandResult(result, options, theme, context, resolveToolBackground);
    },
  });

  pi.registerTool({
    name: WRITE_STDIN_TOOL_NAME,
    label: WRITE_STDIN_TOOL_NAME,
    description:
      "Writes characters to an existing exec_command session, or polls it without writing, and returns recent output.",
    promptSnippet: "Write to or poll a persistent exec_command session",
    promptGuidelines: [
      "Use write_stdin only with a session ID returned by exec_command; omit chars to poll without writing.",
    ],
    parameters: WRITE_STDIN_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate) {
      return manager.writeStdin(params satisfies WriteStdinRequest, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        WRITE_STDIN_TOOL_NAME,
        writeStdinSummary(args),
        theme,
        context,
        resolveToolBackground,
      );
    },
    renderResult(result, options, theme, context) {
      return renderCommandResult(result, options, theme, context, resolveToolBackground);
    },
  });

  pi.registerTool({
    name: SHELL_COMMAND_TOOL_NAME,
    label: SHELL_COMMAND_TOOL_NAME,
    description:
      "Runs a one-shot shell command in the requested working directory. Output keeps the last 2000 lines or 50KB and saves complete truncated output to a temp file.",
    promptSnippet: "Run one-shot shell commands",
    promptGuidelines: [
      "Use shell_command for shell commands and set workdir explicitly when the command is project-specific.",
    ],
    parameters: SHELL_COMMAND_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeShellCommand(
        params satisfies ShellCommandRequest,
        ctx,
        signal,
        onUpdate,
        spawnProcess,
      );
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        SHELL_COMMAND_TOOL_NAME,
        typeof args.command === "string" ? args.command : "",
        theme,
        context,
        resolveToolBackground,
      );
    },
    renderResult(result, options, theme, context) {
      return renderCommandResult(result, options, theme, context, resolveToolBackground);
    },
  });

  pi.on("session_shutdown", () => manager.terminateAll());

  return {
    terminateUnifiedExecSessions() {
      manager.terminateAll().catch((error: unknown) => {
        console.error("Could not terminate unified exec sessions.", error);
      });
    },
  };
}
