import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  loadConfig,
  writableConfigPath,
  type CodexCompatConfig,
} from "./config.ts";
import { registerCodexProvider } from "./codex-provider.ts";
import { installCodexFooter } from "./footer.ts";
import registerCodexModelPolicy from "./model-policy.ts";
import registerRemoteCompaction from "./remote-compaction.ts";
import registerCodexRequestOptions from "./request-options.ts";
import registerCodexSettings from "./settings-pane.ts";
import registerCodexTools, { syncCodexTools } from "./tools.ts";

export {
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  type OpenAICodexWebSocketDebugStats,
} from "./codex-transport.ts";

const DISPLAY_NAME = "OpenAI Codex Compat";

function settingsSummary(ctx: ExtensionContext, config: CodexCompatConfig): string {
  return [
    DISPLAY_NAME,
    `fast mode: ${config.fastMode ? "on" : "off"}`,
    `reasoning mode: ${config.reasoningMode}`,
    `Codex tool background: ${config.toolBackground}`,
    `apply_patch: ${config.applyPatch ? "on" : "off"}`,
    `image_gen.imagegen: ${config.imageGeneration ? "on" : "off"}`,
    `image result detail: ${config.imageDetail}`,
    `web.run: ${config.webRun ? "on" : "off"}`,
    `web search: ${config.webSearch}`,
    `text verbosity: ${config.textVerbosity}`,
    `reasoning summary: ${config.reasoningSummary}`,
    `auto-compact threshold: ${config.autoCompactAtPercent ?? "Pi default"}`,
    `save target: ${writableConfigPath(ctx.cwd, ctx.isProjectTrusted())}`,
    "settings: /codex-settings (Enter saves & closes; Esc discards; Ctrl+S saves)",
  ].join("\n");
}

export default function registerOpenAICodexCompat(pi: ExtensionAPI): void {
  let activeConfig: CodexCompatConfig | undefined;
  const resolveConfig = (ctx: ExtensionContext): CodexCompatConfig => {
    activeConfig ??= loadConfig(ctx.cwd, ctx.isProjectTrusted());
    return activeConfig;
  };
  const resolveToolBackground = () => activeConfig?.toolBackground ?? DEFAULT_CONFIG.toolBackground;

  pi.on("session_start", (event, ctx) => {
    activeConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    installCodexFooter(ctx, resolveConfig);
    if (event.reason !== "reload" && ctx.mode === "tui") {
      ctx.ui.notify(settingsSummary(ctx, activeConfig), "info");
    }
  });

  registerCodexTools(pi, resolveConfig, resolveToolBackground);
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
