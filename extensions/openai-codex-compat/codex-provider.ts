import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCodexInstallationId } from "./codex-installation.ts";
import type { ConfigResolver } from "./codex-provider/codex-provider-contracts.ts";
import { CodexProviderRuntime } from "./codex-provider/codex-provider-runtime.ts";

export type { CodexResponseRetryPolicy } from "./codex-provider/codex-provider-contracts.ts";
export { CodexProviderRuntime } from "./codex-provider/codex-provider-runtime.ts";

const CODEX_PROVIDER = "openai-codex";

export function registerCodexProvider(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver,
): CodexProviderRuntime {
  const runtime = new CodexProviderRuntime(pi, resolveConfig, resolveCodexInstallationId());
  pi.on("session_start", (_event, ctx) => {
    const base =
      ctx.modelRegistry.getRegisteredNativeProvider(CODEX_PROVIDER) ??
      ctx.modelRegistry.getProvider(CODEX_PROVIDER);
    if (!base) throw new Error("Pi's built-in OpenAI Codex provider is unavailable.");
    pi.registerProvider(runtime.createProvider(base));
  });
  pi.on("agent_start", (_event, ctx) => runtime.beginAgentTurn(ctx));
  pi.on("agent_end", (_event, ctx) => runtime.endAgentTurn(ctx));
  return runtime;
}
