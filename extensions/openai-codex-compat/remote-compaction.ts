import {
  convertToLlm,
  type BeforeProviderHeadersEvent,
  type CompactionResult,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getCurrentTools,
  type Api,
  type Model,
  type OpenAICodexResponsesOptions,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { addRemoteCompactionFeature, type JsonRecord } from "./codex-protocol.ts";
import { CODEX_API, CODEX_PROVIDER } from "./codex-identifiers.ts";
import {
  branchInstructions,
  branchTranscript,
  providerHistory,
  remoteCompactionMarkerSummary,
  requestGrammarToolInputProperties,
  requestTools,
  searchCheckpoint,
  toolDefinitionFingerprint,
} from "./compaction-checkpoint.ts";
import { resolveFileConfig, type ConfigResolver } from "./config-context.ts";
import type { CodexProviderRuntime } from "./codex-provider.ts";
import { responsesCompactionV2Metadata, type CodexCompactionMetadata } from "./codex-metadata.ts";
import { errorFromThrown } from "./error-from-thrown.ts";
import { selectedRegistryModel } from "./model-context.ts";

export type RemoteCompactionContext = Parameters<ConfigResolver>[0] & {
  getContextUsage: ExtensionContext["getContextUsage"];
  getSystemPrompt: ExtensionContext["getSystemPrompt"];
  hasUI: boolean;
  model: Model<Api> | undefined;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getLeafId" | "getSessionId"
  >;
  ui: Pick<ExtensionContext["ui"], "notify">;
};

export type RemoteCompactionLifecycleHandler = (
  event: { type?: string },
  ctx: RemoteCompactionContext,
) => void;

export type RemoteCompactionContextHandler = (
  event: Pick<ContextWithSystemEvent, "messages">,
  ctx: RemoteCompactionContext,
) => { messages: ContextWithSystemEvent["messages"] } | undefined;

export type RemoteCompactionHeadersHandler = (
  event: Pick<BeforeProviderHeadersEvent, "headers">,
  ctx: RemoteCompactionContext,
) => void;

type RemoteCompactionHookResult =
  | {
      cancel: true;
      compaction?: never;
    }
  | {
      cancel?: never;
      compaction: CompactionResult;
    };

export type RemoteCompactionHookHandler = (
  event: {
    branchEntries: SessionBeforeCompactEvent["branchEntries"];
    customInstructions?: string;
    preparation: Pick<
      SessionBeforeCompactEvent["preparation"],
      "firstKeptEntryId" | "tokensBefore"
    >;
    reason: SessionBeforeCompactEvent["reason"];
    signal: AbortSignal;
    willRetry: boolean;
  },
  ctx: RemoteCompactionContext,
) => Promise<RemoteCompactionHookResult | undefined>;

export type RemoteCompactionApi = {
  onBeforeProviderHeaders: (handler: RemoteCompactionHeadersHandler) => void;
  onContext: (handler: RemoteCompactionContextHandler) => void;
  onSessionBeforeCompact: (handler: RemoteCompactionHookHandler) => void;
  onSessionShutdown: (handler: RemoteCompactionLifecycleHandler) => void;
  onSessionStart: (handler: RemoteCompactionLifecycleHandler) => void;
};

export function remoteCompactionApi(pi: ExtensionAPI): RemoteCompactionApi {
  const context = (ctx: ExtensionContext): RemoteCompactionContext => {
    return {
      cwd: ctx.cwd,
      getContextUsage: () => ctx.getContextUsage(),
      getSystemPrompt: () => ctx.getSystemPrompt(),
      hasUI: ctx.hasUI,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      model: selectedRegistryModel(ctx),
      modelRegistry: ctx.modelRegistry,
      sessionManager: ctx.sessionManager,
      ui: ctx.ui,
    };
  };

  return {
    onBeforeProviderHeaders: (handler) =>
      pi.on("before_provider_headers", (event, ctx) => handler(event, context(ctx))),
    // The full-transcript event returns messages verbatim. A changed `context`
    // result would fold every later system message into the leading one, so
    // `instructions` would no longer be the branch's leading prompt and the
    // inline developer items in `input` would repeat the folded updates.
    onContext: (handler) =>
      pi.on("context_with_system", (event, ctx) => handler(event, context(ctx))),
    onSessionBeforeCompact: (handler) =>
      pi.on("session_before_compact", (event, ctx) => handler(event, context(ctx))),
    onSessionShutdown: (handler) =>
      pi.on("session_shutdown", (event, ctx) => handler(event, context(ctx))),
    onSessionStart: (handler) =>
      pi.on("session_start", (event, ctx) => handler(event, context(ctx))),
  };
}

function selectedCodexModel(model: Model<Api> | undefined): model is Model<typeof CODEX_API> {
  return Boolean(model && model.provider === CODEX_PROVIDER && model.api === CODEX_API);
}

function appendFeatureHeader(headers: Record<string, string | null>): void {
  const key = Object.keys(headers).find(
    (header) => header.toLowerCase() === "x-codex-beta-features",
  );
  if (key) headers[key] = addRemoteCompactionFeature(headers[key]);
  else headers["x-codex-beta-features"] = addRemoteCompactionFeature(undefined);
}

function featureHeaders(headers: ProviderHeaders | undefined): ProviderHeaders {
  const result: ProviderHeaders = { ...headers };
  appendFeatureHeader(result);
  return result;
}

function instructionsForCompaction(systemPrompt: string, customInstructions?: string): string {
  const custom = customInstructions?.trim();
  return custom
    ? `${systemPrompt}\n\nAdditional guidance for this compaction:\n${custom}`
    : systemPrompt;
}

function compactionMetadata(reason: SessionBeforeCompactEvent["reason"]): CodexCompactionMetadata {
  switch (reason) {
    case "manual":
      return responsesCompactionV2Metadata("manual", "user_requested", "standalone_turn");
    case "threshold":
      return responsesCompactionV2Metadata("auto", "context_limit", "pre_turn");
    case "overflow":
      return responsesCompactionV2Metadata("auto", "context_limit", "mid_turn");
  }
}

export default function registerRemoteCompaction(
  pi: RemoteCompactionApi,
  runtime: CodexProviderRuntime,
  resolveConfig: ConfigResolver = resolveFileConfig,
): void {
  pi.onSessionStart((_event, ctx) => runtime.captureScope(ctx));
  pi.onSessionShutdown((_event, ctx) => {
    runtime.clearSession(ctx.sessionManager.getSessionId());
  });

  pi.onContext((event, ctx) => {
    runtime.captureScope(ctx);
    if (selectedCodexModel(ctx.model)) {
      runtime.noteTranscriptTools(
        ctx.sessionManager.getSessionId(),
        getCurrentTools(convertToLlm(event.messages)),
      );
    }
    const checkpoint = searchCheckpoint(ctx.sessionManager.getBranch());
    if (checkpoint.kind === "absent") return undefined;
    return {
      messages: event.messages.filter((message) => message.role !== "compactionSummary"),
    };
  });

  pi.onBeforeProviderHeaders((event, ctx) => {
    if (selectedCodexModel(ctx.model)) appendFeatureHeader(event.headers);
  });

  pi.onSessionBeforeCompact(async (event, ctx) => {
    if (!selectedCodexModel(ctx.model)) return undefined;
    if (event.signal.aborted) return { cancel: true };
    runtime.captureScope(ctx);

    try {
      const authentication = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!authentication.ok) throw new Error(authentication.error);
      if (!authentication.apiKey) throw new Error("OpenAI Codex authentication is unavailable.");

      const sessionId = ctx.sessionManager.getSessionId();
      const cached = runtime.latestTemplate(sessionId);
      const matching = cached?.modelId === ctx.model.id ? cached : undefined;
      // Turn requests declare the transcript's current tools. The last turn's
      // exact declarations are reused while the branch still declares the tools
      // that turn's transcript declared: Pi strips hidden declarations (codemode
      // `only` mode) from requests after extensions see the transcript, so only
      // the cached declarations reproduce them. Otherwise, such as after resume
      // or a branch switch, the declarations are rebuilt from the branch as turn
      // requests build them.
      const transcript = branchTranscript(event.branchEntries);
      const transcriptTools = getCurrentTools(transcript);
      const declared =
        matching?.transcriptToolFingerprint === toolDefinitionFingerprint(transcriptTools) &&
        Array.isArray(matching.payload.tools)
          ? { ...matching, tools: matching.payload.tools }
          : undefined;
      const config = resolveConfig(ctx);
      const grammarToolInputProperties =
        declared?.grammarToolInputProperties ??
        requestGrammarToolInputProperties(ctx.model, transcript);
      const history = providerHistory({
        branch: event.branchEntries,
        wireModel: ctx.model,
        grammarToolInputProperties,
        imageDetail: config.imageDetail,
        recoverLatestOverflowPrefix: event.reason === "overflow" && event.willRetry,
      });
      const template: JsonRecord = {
        ...matching?.payload,
        tools: declared?.tools ?? requestTools(ctx.model, transcriptTools),
      };
      const requestOptions: OpenAICodexResponsesOptions = {
        ...matching?.requestOptions,
        apiKey: authentication.apiKey,
        headers: featureHeaders(authentication.headers),
        sessionId,
        signal: event.signal,
      };
      const compacted = await runtime.compact({
        model: ctx.model,
        requestOptions,
        history,
        // Turn requests send the branch's leading system message as `instructions`
        // and carry later system messages inline in the history. A branch without
        // a leading system message (a pre-0.86 session) falls back to Pi's
        // current prompt so the compaction still sees instructions.
        instructions: instructionsForCompaction(
          branchInstructions(ctx.model, event.branchEntries) || ctx.getSystemPrompt(),
          event.customInstructions,
        ),
        grammarToolInputProperties,
        template,
        priority: config.fastMode,
        compactionMetadata: compactionMetadata(event.reason),
        compactionDecision: {
          reason: event.reason,
          willRetry: event.willRetry,
        },
      });

      const compaction: CompactionResult = {
        summary: remoteCompactionMarkerSummary(),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: compacted.checkpoint,
      };
      if (compacted.usage) compaction.usage = compacted.usage;
      return { compaction };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) {
        const failure = errorFromThrown(
          error,
          "OpenAI Codex native compaction failed with a non-Error value.",
        );
        ctx.ui.notify(`OpenAI Codex native compaction failed: ${failure.message}`, "error");
      }
      return { cancel: true };
    }
  });
}
