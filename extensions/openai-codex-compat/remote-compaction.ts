import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type ToolInfo,
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
  encodeSessionEntries,
  providerHistory,
  searchCheckpoint,
  type CheckpointData,
  type GrammarToolInputProperties,
} from "./compaction-checkpoint.ts";
import { APPLY_PATCH_INPUT_PROPERTY, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";

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
  grammarToolInputProperties: GrammarToolInputProperties;
};

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

type UnsampledInputSplit =
  | { kind: "none"; history: ResponsesItem[]; tail: ResponsesItem[] }
  | { kind: "found"; history: ResponsesItem[]; tail: ResponsesItem[] }
  | { kind: "unsafe" };

function toolInputProperty(tool: ToolInfo | undefined): string | undefined {
  if (tool?.name === APPLY_PATCH_TOOL_NAME) return APPLY_PATCH_INPUT_PROPERTY;
  if (!tool || !isObject(tool.parameters)) return undefined;

  const required = Array.isArray(tool.parameters["required"])
    ? tool.parameters["required"].filter((name): name is string => typeof name === "string")
    : [];
  if (required.length !== 1 || !isObject(tool.parameters["properties"])) return undefined;
  const property = tool.parameters["properties"][required[0]!];
  return isObject(property) && property.type === "string" ? required[0] : undefined;
}

function requestGrammarToolInputProperties(
  payload: JsonRecord,
  tools: readonly ToolInfo[],
): GrammarToolInputProperties {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const properties = new Map<string, string>();
  if (!Array.isArray(payload.tools)) return properties;

  for (const declaration of payload.tools) {
    if (
      !isObject(declaration) ||
      declaration.type !== "custom" ||
      typeof declaration.name !== "string"
    ) {
      continue;
    }
    const property = toolInputProperty(byName.get(declaration.name));
    if (property) properties.set(declaration.name, property);
  }
  return properties;
}

function fallbackGrammarToolInputProperties(
  activeNames: readonly string[],
  model: Model<any>,
): GrammarToolInputProperties {
  return activeNames.includes(APPLY_PATCH_TOOL_NAME) &&
    isObject(model.compat) &&
    model.compat["supportsOpenAIGrammarTools"] === true
    ? new Map([[APPLY_PATCH_TOOL_NAME, APPLY_PATCH_INPUT_PROPERTY]])
    : new Map();
}

function splitUnsampledUserInput(options: {
  branch: readonly SessionEntry[];
  history: readonly ResponsesItem[];
  model: Model<any>;
  allTools: readonly ToolInfo[];
  grammarToolInputProperties: GrammarToolInputProperties;
}): UnsampledInputSplit {
  const lastSampledEntryIndex = options.branch.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "assistant" || entry.message.role === "toolResult"),
  );
  const unsampledEntries = options.branch.slice(lastSampledEntryIndex + 1);
  const hasUnsampledUser = unsampledEntries.some(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!hasUnsampledUser) {
    return {
      kind: "none",
      history: options.history.map((item) => structuredClone(item)),
      tail: [],
    };
  }

  const encoded = encodeSessionEntries(
    options.model,
    unsampledEntries,
    options.allTools,
    options.grammarToolInputProperties,
  );
  if (encoded.length === 0 || encoded.length > options.history.length) return { kind: "unsafe" };

  const splitIndex = options.history.length - encoded.length;
  const candidate = options.history.slice(splitIndex);
  if (JSON.stringify(candidate) !== JSON.stringify(encoded)) return { kind: "unsafe" };

  return {
    kind: "found",
    history: options.history.slice(0, splitIndex).map((item) => structuredClone(item)),
    tail: encoded.map((item) => structuredClone(item)),
  };
}

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
    postCompactionTail?: ResponsesItem[] | undefined;
    instructions: string;
    grammarToolInputProperties: GrammarToolInputProperties;
    template?: JsonRecord | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
    const authentication = await options.ctx.modelRegistry.getApiKeyAndHeaders(
      options.runtime.model,
    );
    if (!authentication.ok) throw new Error(authentication.error);
    if (!authentication.apiKey) throw new Error("OpenAI Codex authentication is unavailable.");

    const sessionId = options.ctx.sessionManager.getSessionId();
    const tools = activeResponsesTools(
      pi.getAllTools(),
      pi.getActiveTools(),
      options.grammarToolInputProperties,
    );
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
        checkpoint: checkpointData(
          options.runtime.model.id,
          options.history,
          response.item,
          options.postCompactionTail,
        ),
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
    const registeredTools = allTools();
    const grammarToolInputProperties = requestGrammarToolInputProperties(
      event.payload,
      registeredTools,
    );
    const template = withoutConversationInput(event.payload);
    requestTemplates.set(sessionId, {
      modelId: runtime.model.id,
      payload: template,
      grammarToolInputProperties,
    });

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
          : providerHistory({
              branch,
              wireModel: runtime.model,
              allTools: registeredTools,
              grammarToolInputProperties,
            });

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
        const split = splitUnsampledUserInput({
          branch,
          history,
          model: runtime.model,
          allTools: registeredTools,
          grammarToolInputProperties,
        });
        if (split.kind === "unsafe") {
          if (ctx.hasUI) {
            ctx.ui.notify(
              "OpenAI Codex percentage compaction was deferred because the current unsampled user input could not be isolated safely.",
              "warning",
            );
          }
          return checkpoint.kind === "absent" ? undefined : updateInput(event.payload, history);
        }

        const compacted = await performCompaction({
          ctx,
          runtime,
          history: split.history,
          postCompactionTail: split.tail,
          instructions: ctx.getSystemPrompt(),
          grammarToolInputProperties,
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
      const cached = requestTemplates.get(ctx.sessionManager.getSessionId());
      const matchingTemplate = cached?.modelId === runtime.model.id ? cached : undefined;
      const grammarToolInputProperties =
        matchingTemplate?.grammarToolInputProperties ??
        fallbackGrammarToolInputProperties(pi.getActiveTools(), runtime.model);
      const history = providerHistory({
        branch: event.branchEntries as SessionEntry[],
        wireModel: runtime.model,
        allTools: allTools(),
        grammarToolInputProperties,
        dropLatestFailedAssistant: event.reason === "overflow" && event.willRetry,
      });
      const compacted = await performCompaction({
        ctx,
        runtime,
        history,
        instructions: instructionsForCompaction(ctx.getSystemPrompt(), event.customInstructions),
        grammarToolInputProperties,
        template: matchingTemplate?.payload,
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
