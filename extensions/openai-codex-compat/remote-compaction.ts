import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import {
  addRemoteCompactionFeature,
  isObject,
  isResponsesItem,
  remoteCompactionHeaders,
  remoteCompactionPayload,
  requestRemoteCompaction,
  responsesEndpoint,
  withoutConversationInput,
  type JsonRecord,
  type ResponsesItem,
} from "./codex-protocol.ts";
import { loadConfig, type CodexCompatConfig } from "./config.ts";
import {
  activeResponsesTools,
  CHECKPOINT_ENTRY_TYPE,
  checkpointData,
  providerHistory,
  searchCheckpoint,
  type CheckpointData,
} from "./compaction-checkpoint.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const STATUS_ID = "openai-codex-compat-compaction";

type CodexRuntime = {
  model: Model<any>;
  priority: boolean;
};

type RequestTemplate = {
  modelId: string;
  payload: JsonRecord;
};

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

function selectedCodexModel(model: Model<any> | undefined): model is Model<any> {
  return Boolean(model && model.provider === CODEX_PROVIDER && model.api === CODEX_API);
}

function resolveFileConfig(ctx: ExtensionContext): CodexCompatConfig {
  return loadConfig(ctx.cwd, ctx.isProjectTrusted());
}

function resolveRuntime(
  ctx: ExtensionContext,
  resolveConfig: ConfigResolver,
): CodexRuntime | undefined {
  if (!selectedCodexModel(ctx.model)) return undefined;
  return {
    model: ctx.model,
    priority: resolveConfig(ctx).fastMode,
  };
}

function appendFeatureHeader(headers: Record<string, string | null>): void {
  const matchingKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === "x-codex-beta-features",
  );
  if (matchingKey) {
    headers[matchingKey] = addRemoteCompactionFeature(headers[matchingKey]);
  } else {
    headers["x-codex-beta-features"] = addRemoteCompactionFeature(undefined);
  }
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

function updateInput(payload: JsonRecord, input: readonly ResponsesItem[]): JsonRecord {
  const result: JsonRecord = {
    ...payload,
    input: input.map((item) => structuredClone(item)),
  };
  delete result.messages;
  delete result.previous_response_id;
  return result;
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function registerRemoteCompaction(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver = resolveFileConfig,
): void {
  const requestTemplates = new Map<string, RequestTemplate>();

  async function performCompaction(options: {
    ctx: ExtensionContext;
    runtime: CodexRuntime;
    history: ResponsesItem[];
    instructions: string;
    template?: JsonRecord | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
    const authentication = await options.ctx.modelRegistry.getApiKeyAndHeaders(
      options.runtime.model,
    );
    if (!authentication.ok) throw new Error(authentication.error);
    if (!authentication.apiKey) throw new Error("OpenAI Codex authentication is unavailable.");

    const sessionId = options.ctx.sessionManager.getSessionId();
    const tools = activeResponsesTools(pi.getAllTools(), pi.getActiveTools());
    const payload = remoteCompactionPayload({
      template: options.template,
      modelId: options.runtime.model.id,
      history: options.history,
      instructions: options.instructions,
      sessionId,
      fallbackTools: tools,
      priority: options.runtime.priority,
    });

    if (options.ctx.hasUI) options.ctx.ui.setStatus(STATUS_ID, "Codex compacting…");
    try {
      const response = await requestRemoteCompaction({
        endpoint: responsesEndpoint(options.runtime.model.baseUrl),
        headers: remoteCompactionHeaders({
          token: authentication.apiKey,
          providerHeaders: authentication.headers,
          sessionId,
        }),
        payload,
        accountingModel: options.runtime.model,
        priority: options.runtime.priority,
        signal: options.signal,
      });
      return {
        checkpoint: checkpointData(options.runtime.model.id, options.history, response.item),
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } finally {
      if (options.ctx.hasUI) options.ctx.ui.setStatus(STATUS_ID, undefined);
    }
  }

  function allTools(): ToolInfo[] {
    return pi.getAllTools();
  }

  pi.on("session_start", () => requestTemplates.clear());
  pi.on("session_shutdown", () => requestTemplates.clear());
  pi.on("model_select", (_event, ctx) => {
    requestTemplates.delete(ctx.sessionManager.getSessionId());
  });

  // Native v2 produces no plaintext summary. Pi still requires a summary field,
  // so suppress our local checkpoint marker whenever it would enter LLM context.
  pi.on("context", (event, ctx) => {
    const checkpoint = searchCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
    if (checkpoint.kind === "absent") return undefined;
    return {
      messages: event.messages.filter((message) => message.role !== "compactionSummary"),
    };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!selectedCodexModel(ctx.model)) return;
    appendFeatureHeader(event.headers);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    let runtime: CodexRuntime | undefined;
    try {
      runtime = resolveRuntime(ctx, resolveConfig);
    } catch (error) {
      ctx.abort();
      if (ctx.hasUI) ctx.ui.notify(`OpenAI Codex request blocked: ${explain(error)}`, "error");
      return isObject(event.payload) ? updateInput(event.payload, []) : undefined;
    }
    if (!runtime || !isObject(event.payload)) return undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    const template = withoutConversationInput(event.payload);
    requestTemplates.set(sessionId, { modelId: runtime.model.id, payload: template });

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const checkpoint = searchCheckpoint(branch);

    try {
      const history =
        checkpoint.kind === "absent" && Array.isArray(event.payload.input)
          ? event.payload.input.map((item) => {
              if (!isResponsesItem(item)) {
                throw new Error("The Codex provider payload contains an unsupported history item.");
              }
              return structuredClone(item);
            })
          : providerHistory({ branch, wireModel: runtime.model, allTools: allTools() });

      const configuredThreshold = resolveConfig(ctx).autoCompactAtPercent;
      const currentPercent = ctx.getContextUsage()?.percent;
      const checkpointHasNewAssistant =
        checkpoint.kind !== "found" ||
        branch
          .slice(checkpoint.entryIndex + 1)
          .some((entry) => entry.type === "message" && entry.message.role === "assistant");
      const thresholdReached =
        configuredThreshold !== undefined &&
        currentPercent !== null &&
        currentPercent !== undefined &&
        currentPercent >= configuredThreshold &&
        checkpointHasNewAssistant;

      if (thresholdReached) {
        const compacted = await performCompaction({
          ctx,
          runtime,
          history,
          instructions: ctx.getSystemPrompt(),
          template,
          signal: ctx.signal,
        });
        pi.appendEntry(CHECKPOINT_ENTRY_TYPE, compacted.checkpoint);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `OpenAI Codex context compacted at ${currentPercent.toFixed(1)}% and will continue.`,
            "info",
          );
        }
        return updateInput(event.payload, compacted.checkpoint.history);
      }

      if (checkpoint.kind === "absent") return undefined;
      return updateInput(event.payload, history);
    } catch (error) {
      ctx.abort();
      if (ctx.hasUI) ctx.ui.notify(`OpenAI Codex request blocked: ${explain(error)}`, "error");
      return updateInput(event.payload, []);
    }
  });

  // Manual /compact, Pi threshold compaction, and overflow recovery all enter
  // through this event. Tree summarization intentionally has no handler.
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    let runtime: CodexRuntime | undefined;
    try {
      runtime = resolveRuntime(ctx, resolveConfig);
    } catch (error) {
      if (ctx.hasUI)
        ctx.ui.notify(`OpenAI Codex native compaction failed: ${explain(error)}`, "error");
      return { cancel: true };
    }
    if (!runtime) return undefined;
    if (event.signal.aborted) return { cancel: true };

    try {
      const history = providerHistory({
        branch: event.branchEntries as SessionEntry[],
        wireModel: runtime.model,
        allTools: allTools(),
        dropLatestFailedAssistant: event.reason === "overflow" && event.willRetry,
      });
      const cached = requestTemplates.get(ctx.sessionManager.getSessionId());
      const compacted = await performCompaction({
        ctx,
        runtime,
        history,
        instructions: instructionsForCompaction(ctx.getSystemPrompt(), event.customInstructions),
        template: cached?.modelId === runtime.model.id ? cached.payload : undefined,
        signal: event.signal,
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
