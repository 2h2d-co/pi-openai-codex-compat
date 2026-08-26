import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  effectiveExecCommandYieldTimeMs,
  effectiveWriteStdinYieldTimeMs,
  executeShellCommand,
  UnifiedExecManager,
  type ExecCommandRequest,
  type ShellCommandRequest,
  type WriteStdinRequest,
} from "./command-runtime.ts";
import type { CommandProcessSpawner } from "./command-process.ts";
import {
  commandShellDisplayName,
  resolveCommandShellCatalog,
  type CommandShellCatalog,
} from "./command-shell.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { renderCommandCall, renderCommandResult } from "./command-render.ts";
import {
  EXEC_COMMAND_PARAMETERS,
  EXEC_COMMAND_TOOL_NAME,
  execCommandPromptMetadata,
  SHELL_COMMAND_PARAMETERS,
  SHELL_COMMAND_TOOL_NAME,
  shellCommandPromptMetadata,
  WRITE_STDIN_PARAMETERS,
  WRITE_STDIN_TOOL_NAME,
  writeStdinPromptMetadata,
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

// Pi validates the prepared value against SHELL_COMMAND_PARAMETERS immediately
// after this compatibility rewrite.
export function prepareShellCommandArguments(
  args: unknown,
): Static<typeof SHELL_COMMAND_PARAMETERS>;
export function prepareShellCommandArguments(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const prepared: Record<string, unknown> = { ...args };
  if (Object.hasOwn(prepared, "timeout")) {
    if (Object.hasOwn(prepared, "timeout_ms")) {
      throw new Error("failed to parse function arguments: duplicate field `timeout_ms`");
    }
    prepared["timeout_ms"] = prepared["timeout"];
    Reflect.deleteProperty(prepared, "timeout");
  }
  return prepared;
}

function writeStdinSummary(request: Partial<WriteStdinRequest>): string {
  const id = typeof request.session_id === "number" ? request.session_id : "?";
  const chars = typeof request.chars === "string" ? request.chars : "";
  if (!chars) return `poll session ${id}`;
  const singleLine = chars.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return `write ${JSON.stringify(singleLine)} to session ${id}`;
}

function formatYieldDuration(milliseconds: number): string {
  return milliseconds >= 1_000 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

function resolveYieldDuration(
  value: number | undefined,
  resolveMilliseconds: (value: number | undefined) => number,
): string | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  return formatYieldDuration(resolveMilliseconds(value));
}

export default function registerCommandTools(
  pi: CommandToolsApi,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  spawnProcess?: CommandProcessSpawner,
  shellCatalog: CommandShellCatalog = resolveCommandShellCatalog(),
): CommandToolsController {
  const manager = new UnifiedExecManager(spawnProcess, shellCatalog.defaultShell);
  const shellName = commandShellDisplayName(shellCatalog.defaultShell);
  const alternativeShells = shellCatalog.availableShells
    .filter((shell) => shell.path !== shellCatalog.defaultShell.path)
    .map((shell) => shell.path);
  const execCommandPrompt = execCommandPromptMetadata(shellName, alternativeShells);
  const writeStdinPrompt = writeStdinPromptMetadata();
  const shellCommandPrompt = shellCommandPromptMetadata(shellName);

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
    description: execCommandPrompt.description,
    promptSnippet: execCommandPrompt.promptSnippet,
    promptGuidelines: execCommandPrompt.promptGuidelines,
    parameters: EXEC_COMMAND_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return manager.execCommand(params satisfies ExecCommandRequest, ctx, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        EXEC_COMMAND_TOOL_NAME,
        typeof args.cmd === "string" ? args.cmd : "",
        resolveYieldDuration(args.yield_time_ms, effectiveExecCommandYieldTimeMs),
        typeof args.workdir === "string" ? args.workdir : undefined,
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
    description: writeStdinPrompt.description,
    promptSnippet: writeStdinPrompt.promptSnippet,
    promptGuidelines: writeStdinPrompt.promptGuidelines,
    parameters: WRITE_STDIN_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate) {
      return manager.writeStdin(params satisfies WriteStdinRequest, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        WRITE_STDIN_TOOL_NAME,
        writeStdinSummary(args),
        resolveYieldDuration(args.yield_time_ms, (value) =>
          effectiveWriteStdinYieldTimeMs(value, !(args.chars ?? "")),
        ),
        undefined,
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
    description: shellCommandPrompt.description,
    promptSnippet: shellCommandPrompt.promptSnippet,
    promptGuidelines: shellCommandPrompt.promptGuidelines,
    parameters: SHELL_COMMAND_PARAMETERS,
    prepareArguments: prepareShellCommandArguments,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeShellCommand(
        params satisfies ShellCommandRequest,
        ctx,
        signal,
        onUpdate,
        spawnProcess,
        shellCatalog.defaultShell,
      );
    },
    renderCall(args, theme, context) {
      return renderCommandCall(
        SHELL_COMMAND_TOOL_NAME,
        typeof args.command === "string" ? args.command : "",
        undefined,
        typeof args.workdir === "string" ? args.workdir : undefined,
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
