import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import {
  EXEC_COMMAND_DESCRIPTION,
  EXEC_COMMAND_PARAMETERS,
  EXEC_COMMAND_TOOL_NAME,
  SHELL_COMMAND_DESCRIPTION,
  SHELL_COMMAND_PARAMETERS,
  SHELL_COMMAND_TOOL_NAME,
  WRITE_STDIN_DESCRIPTION,
  WRITE_STDIN_PARAMETERS,
  WRITE_STDIN_TOOL_NAME,
} from "./command-tool-contract.ts";

export {
  EXEC_COMMAND_PARAMETERS,
  EXEC_COMMAND_TOOL_NAME,
  SHELL_COMMAND_PARAMETERS,
  SHELL_COMMAND_TOOL_NAME,
  WRITE_STDIN_PARAMETERS,
  WRITE_STDIN_TOOL_NAME,
} from "./command-tool-contract.ts";

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
    description: EXEC_COMMAND_DESCRIPTION,
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
    description: WRITE_STDIN_DESCRIPTION,
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
    description: SHELL_COMMAND_DESCRIPTION,
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
