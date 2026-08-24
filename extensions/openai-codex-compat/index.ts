import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type CodexCompatConfig } from "./config.ts";
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
      ctx.ui.notify("pi-openai-codex-compat loaded · /codex-settings", "info");
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
