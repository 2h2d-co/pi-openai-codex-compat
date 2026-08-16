import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Model, OpenAICodexResponsesOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import { addRemoteCompactionFeature, type JsonRecord } from "./codex-protocol.ts";
import {
  activeResponsesTools,
  providerHistory,
  searchCheckpoint,
  type GrammarToolInputProperties,
} from "./compaction-checkpoint.ts";
import { loadConfig, type CodexCompatConfig } from "./config.ts";
import type { CodexProviderRuntime } from "./codex-provider.ts";
import { responsesCompactionV2Metadata, type CodexCompactionMetadata } from "./codex-metadata.ts";
import { APPLY_PATCH_INPUT_PROPERTY, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

function selectedCodexModel(model: Model<any> | undefined): model is Model<any> {
  return Boolean(model && model.provider === CODEX_PROVIDER && model.api === CODEX_API);
}

function resolveFileConfig(ctx: ExtensionContext): CodexCompatConfig {
  return loadConfig(ctx.cwd, ctx.isProjectTrusted());
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
  if (!tool || typeof tool.parameters !== "object" || tool.parameters === null) return undefined;
  const schema = tool.parameters as {
    required?: unknown;
    properties?: Record<string, { type?: unknown } | undefined>;
  };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  if (required.length !== 1 || !schema.properties) return undefined;
  return schema.properties[required[0]!]?.type === "string" ? required[0] : undefined;
}

function requestGrammarToolInputProperties(
  payload: JsonRecord,
  tools: readonly ToolInfo[],
): GrammarToolInputProperties {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const properties = new Map<string, string>();
  if (!Array.isArray(payload.tools)) return properties;

  for (const declaration of payload.tools) {
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
      continue;
    }
    const tool = declaration as JsonRecord;
    if (tool.type !== "custom" || typeof tool.name !== "string") continue;
    const property = toolInputProperty(byName.get(tool.name));
    if (property) properties.set(tool.name, property);
  }
  return properties;
}

function fallbackGrammarToolInputProperties(
  activeNames: readonly string[],
  model: Model<any>,
): GrammarToolInputProperties {
  const compat = model.compat as { supportsOpenAIGrammarTools?: boolean } | undefined;
  return activeNames.includes(APPLY_PATCH_TOOL_NAME) && compat?.supportsOpenAIGrammarTools
    ? new Map([[APPLY_PATCH_TOOL_NAME, APPLY_PATCH_INPUT_PROPERTY]])
    : new Map();
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  pi: ExtensionAPI,
  runtime: CodexProviderRuntime,
  resolveConfig: ConfigResolver = resolveFileConfig,
): void {
  pi.on("session_start", (_event, ctx) => runtime.captureScope(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    runtime.clearSession(ctx.sessionManager.getSessionId());
  });

  pi.on("context", (event, ctx) => {
    runtime.captureScope(ctx);
    const checkpoint = searchCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
    if (checkpoint.kind === "absent") return undefined;
    return {
      messages: event.messages.filter((message) => message.role !== "compactionSummary"),
    };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (selectedCodexModel(ctx.model)) appendFeatureHeader(event.headers);
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
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
        branch: event.branchEntries as SessionEntry[],
        wireModel: ctx.model,
        allTools,
        grammarToolInputProperties,
        imageDetail: config.imageDetail,
        dropLatestFailedAssistant: event.reason === "overflow" && event.willRetry,
      });
      const template =
        matching?.payload ??
        ({
          tools: activeResponsesTools(allTools, pi.getActiveTools(), grammarToolInputProperties),
        } satisfies JsonRecord);
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

      return {
        compaction: {
          summary: markerSummary(),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          ...(compacted.usage ? { usage: compacted.usage } : {}),
          details: compacted.checkpoint,
        },
      };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify(`OpenAI Codex native compaction failed: ${explain(error)}`, "error");
      }
      return { cancel: true };
    }
  });
}
