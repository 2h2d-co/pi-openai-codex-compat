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
import {
  type BackgroundProcessBrowserAction,
  type BackgroundProcessDetailsAction,
  createBackgroundProcessBrowser,
  createBackgroundProcessDetails,
  formatBackgroundProcesses,
  singleLineCommand,
} from "./background-process-browser.ts";

export const BACKGROUND_PROCESSES_COMMAND_NAME = "ps";

export { formatBackgroundProcesses } from "./background-process-browser.ts";

export type CommandToolsApi = Pick<ExtensionAPI, "on" | "registerCommand" | "registerTool">;

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

  pi.registerCommand(BACKGROUND_PROCESSES_COMMAND_NAME, {
    description: "browse background terminals",
    handler: async (_args, ctx) => {
      let opened = false;
      for (;;) {
        const processes = manager.listProcesses();
        if (processes.length === 0 || ctx.mode !== "tui") {
          if (!opened || ctx.mode !== "tui") {
            ctx.ui.notify(formatBackgroundProcesses(processes), "info");
          }
          return;
        }
        opened = true;
        const action = await ctx.ui.custom<BackgroundProcessBrowserAction>(
          (tui, theme, _keybindings, done) =>
            createBackgroundProcessBrowser(processes, theme, done, () => tui.requestRender()),
        );
        if (action.type === "close") return;
        let stopSessionId = action.type === "stop" ? action.sessionId : undefined;

        if (action.type === "inspect") {
          const observeProcess = manager.observeProcess(action.sessionId);
          if (!observeProcess) continue;
          const detailsAction = await ctx.ui.custom<BackgroundProcessDetailsAction>(
            (tui, theme, _keybindings, done) =>
              createBackgroundProcessDetails(observeProcess, theme, done, () =>
                tui.requestRender(),
              ),
            {
              overlay: true,
              overlayOptions: {
                width: "85%",
                minWidth: 50,
                maxHeight: "85%",
                margin: 1,
              },
            },
          );
          if (detailsAction === "close") continue;
          stopSessionId = action.sessionId;
        }

        if (action.type === "stop-all") {
          const confirmed = await ctx.ui.confirm(
            "Stop all background terminals?",
            `Terminate all ${processes.length} running terminal${processes.length === 1 ? "" : "s"}?`,
          );
          if (!confirmed) continue;
          await manager.terminateAll();
          ctx.ui.notify(
            `Stopped ${processes.length} background terminal${processes.length === 1 ? "" : "s"}.`,
            "info",
          );
          return;
        }

        if (stopSessionId === undefined) continue;
        const process = processes.find((candidate) => candidate.sessionId === stopSessionId);
        if (!process) continue;
        const confirmed = await ctx.ui.confirm(
          `Stop terminal session ${process.sessionId}?`,
          `${singleLineCommand(process.command)}\n${process.cwd}`,
        );
        if (!confirmed) continue;
        const stopped = await manager.terminateProcess(process.sessionId);
        ctx.ui.notify(
          stopped
            ? `Stopped background terminal session ${process.sessionId}.`
            : `Background terminal session ${process.sessionId} is no longer running.`,
          "info",
        );
      }
    },
  });

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
