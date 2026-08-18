import { isString } from "./value-contracts.ts";
import { randomUUID } from "node:crypto";
import type {
  BeforeProviderHeadersEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Model,
  OpenAICodexResponsesOptions,
  ProviderHeaders,
  Usage,
} from "@earendil-works/pi-ai";
import { addRemoteCompactionFeature, isObject, type JsonRecord } from "./codex-protocol.ts";
import {
  activeResponsesTools,
  providerHistory,
  responsesCompatibility,
  searchCheckpoint,
  type GrammarToolInputProperties,
} from "./compaction-checkpoint.ts";
import { resolveFileConfig, type ConfigResolver } from "./config-context.ts";
import type { CodexProviderRuntime } from "./codex-provider.ts";
import { responsesCompactionV2Metadata, type CodexCompactionMetadata } from "./codex-metadata.ts";
import { APPLY_PATCH_INPUT_PROPERTY, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import { errorFromThrown } from "./error-from-thrown.ts";
import { selectedRegistryModel } from "./model-context.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";

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
  event: Pick<ContextEvent, "messages">,
  ctx: RemoteCompactionContext,
) => { messages: ContextEvent["messages"] } | undefined;

export type RemoteCompactionHeadersHandler = (
  event: Pick<BeforeProviderHeadersEvent, "headers">,
  ctx: RemoteCompactionContext,
) => void;

type RemoteCompactionHookResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
    usage?: Usage;
  };
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
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  onBeforeProviderHeaders(handler: RemoteCompactionHeadersHandler): void;
  onContext(handler: RemoteCompactionContextHandler): void;
  onSessionBeforeCompact(handler: RemoteCompactionHookHandler): void;
  onSessionShutdown(handler: RemoteCompactionLifecycleHandler): void;
  onSessionStart(handler: RemoteCompactionLifecycleHandler): void;
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
    getActiveTools: () => pi.getActiveTools(),
    getAllTools: () => pi.getAllTools(),
    onBeforeProviderHeaders: (handler) =>
      pi.on("before_provider_headers", (event, ctx) => handler(event, context(ctx))),
    onContext: (handler) => pi.on("context", (event, ctx) => handler(event, context(ctx))),
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

function markerSummary(): string {
  return `OpenAI Codex remote compaction checkpoint (${randomUUID()}).`;
}

function instructionsForCompaction(systemPrompt: string, customInstructions?: string): string {
  const custom = customInstructions?.trim();
  return custom
    ? `${systemPrompt}\n\nAdditional guidance for this compaction:\n${custom}`
    : systemPrompt;
}

function toolInputProperty(tool: ToolInfo | undefined): string | undefined {
  if (tool?.name === APPLY_PATCH_TOOL_NAME) return APPLY_PATCH_INPUT_PROPERTY;
  if (!tool || !isObject(tool.parameters)) return undefined;
  const required = Array.isArray(tool.parameters["required"])
    ? tool.parameters["required"].filter((name): name is string => typeof name === "string")
    : [];
  if (required.length !== 1 || !isObject(tool.parameters["properties"])) return undefined;
  const requiredProperty = required[0];
  if (requiredProperty === undefined) return undefined;
  const property = tool.parameters["properties"][requiredProperty];
  return isObject(property) && property.type === "string" ? requiredProperty : undefined;
}

function requestGrammarToolInputProperties(
  payload: JsonRecord,
  tools: readonly ToolInfo[],
): GrammarToolInputProperties {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const properties = new Map<string, string>();
  if (!Array.isArray(payload.tools)) return properties;

  for (const declaration of payload.tools) {
    if (!isObject(declaration)) continue;
    const tool = declaration;
    if (tool.type !== "custom" || !isString(tool.name)) continue;
    const property = toolInputProperty(byName.get(tool.name));
    if (property) properties.set(tool.name, property);
  }
  return properties;
}

function fallbackGrammarToolInputProperties(
  activeNames: readonly string[],
  model: Model<Api>,
): GrammarToolInputProperties {
  const compat = responsesCompatibility(model.compat);
  return activeNames.includes(APPLY_PATCH_TOOL_NAME) && compat?.supportsOpenAIGrammarTools
    ? new Map([[APPLY_PATCH_TOOL_NAME, APPLY_PATCH_INPUT_PROPERTY]])
    : new Map();
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
      const allTools = pi.getAllTools();
      const cached = runtime.latestTemplate(sessionId);
      const matching = cached?.modelId === ctx.model.id ? cached : undefined;
      const config = resolveConfig(ctx);
      const grammarToolInputProperties =
        matching?.grammarToolInputProperties ??
        fallbackGrammarToolInputProperties(pi.getActiveTools(), ctx.model);
      const history = providerHistory({
        branch: event.branchEntries,
        wireModel: ctx.model,
        allTools,
        grammarToolInputProperties,
        imageDetail: config.imageDetail,
        recoverLatestOverflowPrefix: event.reason === "overflow" && event.willRetry,
      });
      let template = matching?.payload;
      if (!template) {
        template = {};
        const tools = activeResponsesTools(
          allTools,
          pi.getActiveTools(),
          grammarToolInputProperties,
        );
        if (tools) template.tools = tools;
      }
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
        instructions: instructionsForCompaction(ctx.getSystemPrompt(), event.customInstructions),
        grammarToolInputProperties:
          matching?.grammarToolInputProperties ??
          requestGrammarToolInputProperties(template, allTools),
        template,
        priority: config.fastMode,
        compactionMetadata: compactionMetadata(event.reason),
        compactionDecision: {
          reason: event.reason,
          willRetry: event.willRetry,
        },
      });

      const result = {
        compaction: {
          summary: markerSummary(),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: compacted.checkpoint,
        },
      };
      if (compacted.usage) Object.assign(result.compaction, { usage: compacted.usage });
      return result;
      // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- The compaction hook reports the failure and returns Pi's explicit cancellation result.
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
