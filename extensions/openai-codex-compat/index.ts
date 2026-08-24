import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  loadConfig,
  writableConfigPath,
  type CodexCompatConfig,
} from "./config.ts";
import type { ConfigContext } from "./config-context.ts";
import { registerCodexProvider } from "./codex-provider.ts";
import { installCodexFooter } from "./footer.ts";
import registerCodexModelPolicy, { codexModelPolicyApi } from "./model-policy.ts";
import registerOutputLimitContinuation, {
  outputLimitContinuationApi,
} from "./output-limit-continuation.ts";
import registerRemoteCompaction, { remoteCompactionApi } from "./remote-compaction.ts";
import registerCodexRequestOptions from "./request-options.ts";
import registerCodexSettings from "./settings-pane.ts";
import registerCodexThreadLineage, { codexThreadLineageApi } from "./codex-thread-lineage.ts";
import registerCodexTools, { syncCodexTools } from "./tools.ts";

export {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  type OpenAICodexWebSocketDebugStats,
} from "./codex-transport.ts";

const DISPLAY_NAME = "OpenAI Codex Compat";

function settingsSummary(ctx: ExtensionContext, config: CodexCompatConfig): string {
  return [
    DISPLAY_NAME,
    `fast mode: ${config.fastMode ? "on" : "off"}`,
    `Responses Lite: ${config.responsesLite ? "on" : "off"}`,
    `reasoning mode: ${config.reasoningMode}`,
    `Codex tool background: ${config.toolBackground}`,
    `apply_patch: ${config.applyPatch ? "on" : "off"}`,
    `apply_patch debug output: ${config.applyPatchDebug ? "on" : "off"}`,
    `apply_patch diagnostics capture: ${config.applyPatchDiagnostics ? "on" : "off"}`,
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
  const resolveConfig = (ctx: ConfigContext): CodexCompatConfig => {
    activeConfig ??= loadConfig(ctx.cwd, ctx.isProjectTrusted());
    return activeConfig;
  };
  const resolveToolBackground = () => activeConfig?.toolBackground ?? DEFAULT_CONFIG.toolBackground;
  const resolveApplyPatchDebug = () =>
    activeConfig?.applyPatchDebug ?? DEFAULT_CONFIG.applyPatchDebug;
  const resolveApplyPatchDiagnostics = () =>
    activeConfig?.applyPatchDiagnostics ?? DEFAULT_CONFIG.applyPatchDiagnostics;

  pi.on("session_start", (event, ctx) => {
    activeConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    installCodexFooter(ctx, resolveConfig);
    if (event.reason !== "reload" && ctx.mode === "tui") {
      ctx.ui.notify(settingsSummary(ctx, activeConfig), "info");
    }
  });

  registerCodexTools(
    pi,
    resolveConfig,
    resolveToolBackground,
    resolveApplyPatchDebug,
    resolveApplyPatchDiagnostics,
  );
  registerCodexThreadLineage(codexThreadLineageApi(pi));
  const codexProvider = registerCodexProvider(pi, resolveConfig);
  registerCodexRequestOptions(pi, resolveConfig);
  registerOutputLimitContinuation(outputLimitContinuationApi(pi));
  registerRemoteCompaction(remoteCompactionApi(pi), codexProvider, resolveConfig);
  registerCodexModelPolicy(codexModelPolicyApi(pi), resolveConfig);
  registerCodexSettings(pi, {
    getConfig: resolveConfig,
    onChange(config, ctx) {
      activeConfig = config;
      codexProvider.updateSessionConfig(ctx.sessionId, config);
      syncCodexTools(pi, ctx.model, config);
    },
  });
}
