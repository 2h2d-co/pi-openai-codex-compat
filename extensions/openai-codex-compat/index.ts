import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, writableConfigPath, type CodexCompatConfig } from "./config.ts";
import { registerCodexProvider } from "./codex-provider.ts";
import { installCodexFooter } from "./footer.ts";
import registerCodexModelPolicy from "./model-policy.ts";
import registerRemoteCompaction from "./remote-compaction.ts";
import registerCodexRequestOptions from "./request-options.ts";
import registerCodexSettings from "./settings-pane.ts";
import registerCodexTools, { syncCodexTools } from "./tools.ts";

const DISPLAY_NAME = "OpenAI Codex Compat";

function settingsSummary(ctx: ExtensionContext, config: CodexCompatConfig): string {
  return [
    DISPLAY_NAME,
    `fast mode: ${config.fastMode ? "on" : "off"}`,
    `reasoning mode: ${config.reasoningMode}`,
    `apply_patch: ${config.applyPatch ? "on" : "off"}`,
    `web search: ${config.webSearch}`,
    `text verbosity: ${config.textVerbosity}`,
    `reasoning summary: ${config.reasoningSummary}`,
    `auto-compact threshold: ${config.autoCompactAtPercent ?? "Pi default"}`,
    `save target: ${writableConfigPath(ctx.cwd, ctx.isProjectTrusted())}`,
    "settings: /codex-settings (session-only until Ctrl+S)",
  ].join("\n");
}

export default function registerOpenAICodexCompat(pi: ExtensionAPI): void {
  let activeConfig: CodexCompatConfig | undefined;
  const resolveConfig = (ctx: ExtensionContext): CodexCompatConfig => {
    activeConfig ??= loadConfig(ctx.cwd, ctx.isProjectTrusted());
    return activeConfig;
  };

  pi.on("session_start", (event, ctx) => {
    activeConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    installCodexFooter(ctx, resolveConfig);
    if (event.reason !== "reload" && ctx.mode === "tui") {
      ctx.ui.notify(settingsSummary(ctx, activeConfig), "info");
    }
  });

  registerCodexTools(pi);
  const codexProvider = registerCodexProvider(pi, resolveConfig);
  registerCodexRequestOptions(pi, resolveConfig);
  registerRemoteCompaction(pi, codexProvider, resolveConfig);
  registerCodexModelPolicy(pi, resolveConfig);
  registerCodexSettings(pi, {
    getConfig: resolveConfig,
    onChange(config, ctx) {
      activeConfig = config;
      syncCodexTools(pi, ctx.model, config);
    },
  });
}
