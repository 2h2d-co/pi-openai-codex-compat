import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import registerApplyPatch, { APPLY_PATCH_TOOL_NAME, type ApplyPatchApi } from "./apply-patch.ts";
import registerCommandTools, {
  EXEC_COMMAND_TOOL_NAME,
  SHELL_COMMAND_TOOL_NAME,
  WRITE_STDIN_TOOL_NAME,
  type CommandToolsApi,
  type CommandToolsController,
} from "./command-tools.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import type { CodexCompatConfig, CodexShellTool } from "./config.ts";
import type { ConfigResolver } from "./config-context.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import registerImageGeneration, { type ImageGenerationApi } from "./image-generation.ts";
import { IMAGE_GENERATION_TOOL_NAME, WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import { isCodexModel } from "./request-options.ts";
import registerWebRun, { type WebRunApi } from "./web-run.ts";

const PI_EDIT_TOOLS = ["edit", "write"] as const;
const PI_BASH_TOOL = "bash";
const CODEX_COMMAND_TOOLS = [
  EXEC_COMMAND_TOOL_NAME,
  WRITE_STDIN_TOOL_NAME,
  SHELL_COMMAND_TOOL_NAME,
] as const;
const CODEX_EXTENSION_TOOLS = [
  APPLY_PATCH_TOOL_NAME,
  IMAGE_GENERATION_TOOL_NAME,
  WEB_RUN_TOOL_NAME,
] as const;
export type CodexToolActivationApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
export type CodexToolsApi = CodexToolActivationApi &
  ApplyPatchApi &
  CommandToolsApi &
  ImageGenerationApi &
  WebRunApi;

const suppressedEditTools = new WeakMap<CodexToolActivationApi, Set<string>>();
const suppressedBashTools = new WeakMap<CodexToolActivationApi, boolean>();

export function setApplyPatchEnabled(pi: CodexToolActivationApi, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  active.delete(APPLY_PATCH_TOOL_NAME);
  if (enabled) {
    let suppressed = suppressedEditTools.get(pi);
    if (!suppressed) {
      suppressed = new Set(PI_EDIT_TOOLS.filter((tool) => active.has(tool)));
      suppressedEditTools.set(pi, suppressed);
    }
    for (const tool of PI_EDIT_TOOLS) active.delete(tool);
    active.add(APPLY_PATCH_TOOL_NAME);
  } else {
    active.delete(APPLY_PATCH_TOOL_NAME);
    const suppressed = suppressedEditTools.get(pi);
    if (suppressed) {
      for (const tool of suppressed) active.add(tool);
      suppressedEditTools.delete(pi);
    }
  }
  pi.setActiveTools([...active]);
}

/**
 * Whether the session already declared a Codex command tool. This extension enables one only in
 * place of an active Pi `bash` tool, so a resumed session that declared one started with `bash`.
 * Pi restores the declared tools on resume, which no longer include `bash`.
 */
export function declaresCodexCommandTool(entries: readonly SessionEntry[]): boolean {
  const commandTools: readonly string[] = CODEX_COMMAND_TOOLS;
  return entries.some((entry) => {
    const message =
      entry.type === "compaction"
        ? entry.systemMessage
        : entry.type === "message" && entry.message.role === "system"
          ? entry.message
          : undefined;
    return (message?.toolsAdded ?? []).some((tool) => commandTools.includes(tool.name));
  });
}

/**
 * Swap Pi's `bash` for the selected Codex command tools. `bashReplaced` marks a resumed session
 * whose `bash` this extension already replaced.
 */
export function setCodexCommandTool(
  pi: CodexToolActivationApi,
  shellTool: CodexShellTool | undefined,
  bashReplaced = false,
): boolean {
  const active = new Set(pi.getActiveTools());
  for (const tool of CODEX_COMMAND_TOOLS) active.delete(tool);

  if (shellTool === undefined) {
    if (suppressedBashTools.get(pi)) active.add(PI_BASH_TOOL);
    suppressedBashTools.delete(pi);
    pi.setActiveTools([...active]);
    return false;
  }

  if (!suppressedBashTools.has(pi)) {
    suppressedBashTools.set(pi, active.has(PI_BASH_TOOL) || bashReplaced);
  }
  active.delete(PI_BASH_TOOL);
  const replacementEnabled = suppressedBashTools.get(pi) === true;
  if (replacementEnabled) {
    if (shellTool === "unified_exec") {
      active.add(EXEC_COMMAND_TOOL_NAME);
      active.add(WRITE_STDIN_TOOL_NAME);
    } else {
      active.add(SHELL_COMMAND_TOOL_NAME);
    }
  }
  pi.setActiveTools([...active]);
  return replacementEnabled && shellTool === "unified_exec";
}

export function syncCodexTools(
  pi: CodexToolActivationApi,
  model: Model<Api> | undefined,
  config: CodexCompatConfig,
  commandTools?: CommandToolsController,
  bashReplaced = false,
): void {
  const codexSelected = isCodexModel(model);
  setApplyPatchEnabled(pi, codexSelected && config.applyPatch);
  const unifiedExecActive = setCodexCommandTool(
    pi,
    codexSelected ? config.shellTool : undefined,
    bashReplaced,
  );
  if (!unifiedExecActive) commandTools?.terminateUnifiedExecSessions();

  const active = new Set(pi.getActiveTools());
  for (const tool of CODEX_EXTENSION_TOOLS) {
    if (tool !== APPLY_PATCH_TOOL_NAME) active.delete(tool);
  }
  if (codexSelected) {
    if (config.imageGeneration) active.add(IMAGE_GENERATION_TOOL_NAME);
    if (config.webRun) active.add(WEB_RUN_TOOL_NAME);
  }
  pi.setActiveTools([...active]);
}

export default function registerCodexTools(
  pi: CodexToolsApi,
  resolveConfig: ConfigResolver,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  resolveApplyPatchDebug: () => boolean = () => DEFAULT_CONFIG.applyPatchDebug,
  resolveApplyPatchDiagnostics: () => boolean = () => DEFAULT_CONFIG.applyPatchDiagnostics,
): CommandToolsController {
  const commandTools = registerCommandTools(pi, resolveToolBackground);
  registerApplyPatch(
    pi,
    resolveToolBackground,
    resolveApplyPatchDebug,
    resolveApplyPatchDiagnostics,
  );
  registerImageGeneration(pi, resolveConfig, resolveToolBackground);
  registerWebRun(pi, resolveConfig, resolveToolBackground);
  return commandTools;
}
