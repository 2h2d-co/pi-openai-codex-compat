import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, writableConfigPath, type CodexCompatConfig } from "./config.ts";
import registerRemoteCompaction from "./remote-compaction.ts";
import registerCodexRequestOptions, { isCodexModel } from "./request-options.ts";
import registerCodexSettings from "./settings-pane.ts";
import registerCodexTools, { setApplyPatchEnabled } from "./tools.ts";

const EXTENSION_ID = "openai-codex-compat";
const DISPLAY_NAME = "OpenAI Codex Compat";

function statusText(config: CodexCompatConfig): string {
  const modes = [
    config.fastMode ? "fast" : undefined,
    config.reasoningMode === "pro" ? "pro" : undefined,
  ]
    .filter(Boolean)
    .join("+");
  return modes ? `Codex ${modes}` : "Codex compat";
}

function updateStatus(ctx: ExtensionContext, config?: CodexCompatConfig): void {
  if (!ctx.hasUI) return;
  const activeConfig = config ?? loadConfig(ctx.cwd, ctx.isProjectTrusted());
  ctx.ui.setStatus(EXTENSION_ID, isCodexModel(ctx.model) ? statusText(activeConfig) : undefined);
}

export default function registerOpenAICodexCompat(pi: ExtensionAPI): void {
  registerCodexTools(pi);
  registerCodexRequestOptions(pi);
  registerRemoteCompaction(pi);
  registerCodexSettings(pi, {
    onChange(config, ctx) {
      setApplyPatchEnabled(pi, config.applyPatch);
      updateStatus(ctx, config);
    },
  });

  pi.registerCommand("codex-compat", {
    description: "Show OpenAI Codex compatibility status",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const message = [
        DISPLAY_NAME,
        `model: ${selected}`,
        `active: ${isCodexModel(ctx.model) ? "yes" : "no"}`,
        `fast mode: ${config.fastMode ? "on" : "off"}`,
        `reasoning mode: ${config.reasoningMode}`,
        "remote compaction: available for OpenAI Codex models",
        `apply_patch: ${config.applyPatch ? "on" : "off"}`,
        `web search: ${config.webSearch}`,
        `text verbosity: ${config.textVerbosity}`,
        `reasoning summary: ${config.reasoningSummary}`,
        `auto-compact threshold: ${config.autoCompactAtPercent ?? "Pi default"}`,
        `config: ${writableConfigPath(ctx.cwd, ctx.isProjectTrusted())}`,
        "settings: /codex-settings",
      ].join("\n");

      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      } else {
        console.log(message);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
  });
}
