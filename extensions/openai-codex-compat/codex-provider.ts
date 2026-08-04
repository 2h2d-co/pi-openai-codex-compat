import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  checkpointData,
  providerHistory,
  searchCheckpoint,
  type CheckpointData,
  type GrammarToolInputProperties,
} from "./compaction-checkpoint.ts";
import {
  collectRemoteCompaction,
  isObject,
  isResponsesItem,
  remoteCompactionPayload,
  withoutConversationInput,
  type JsonRecord,
  type ResponsesItem,
} from "./codex-protocol.ts";
import { codexCacheKey } from "./codex-cache-key.ts";
import { processCodexStream } from "./codex-stream.ts";
import {
  CodexTransport,
  validateCodexAuthentication,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
} from "./codex-transport.ts";
import type { CodexCompatConfig, ImageDetail } from "./config.ts";
import { nativeResponseData, NATIVE_RESPONSE_ENTRY_TYPE } from "./native-history.ts";
import {
  CODEX_NAMESPACED_TOOL_NAMES,
  CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
} from "./namespaced-tools.ts";
import { normalizeReplayItem, stableResponsesJson } from "./responses-replay.ts";
import {
  convertResponsesTools,
  convertResponsesMessages,
  createGrammarToolInputProperties,
  type ResponsesItem as SerializedResponsesItem,
} from "./vendor/pi-ai/openai-responses-serialization.ts";
import { formatProviderError } from "./provider-error.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

type MutableSessionManager = ExtensionContext["sessionManager"] & {
  appendCompaction?<T>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string;
};

type RuntimeScope = {
  sessionId: string;
  manager: MutableSessionManager;
  branch: SessionEntry[];
  leafId: string | null;
  contextTokens: number | null;
  contextPercent: number | null;
  config: CodexCompatConfig;
  hasUI: boolean;
  notify(message: string, level: "info" | "warning" | "error"): void;
};

type RequestTemplate = {
  modelId: string;
  payload: JsonRecord;
  grammarToolInputProperties: GrammarToolInputProperties;
  requestOptions: OpenAICodexResponsesOptions;
};

type CodexCompat = {
  supportsToolSearch?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
};

function markerSummary(): string {
  return `OpenAI Codex remote compaction checkpoint (${randomUUID()}).`;
}

function splitDeferredTools(
  context: Context,
  enabled: boolean,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
  const unique = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  if (!enabled) return { immediate: [...unique.values()], deferred: new Map() };

  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") usedNames.add(block.name);
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name);
      }
    }
  }

  const immediate: Tool[] = [];
  const deferred = new Map<string, Tool>();
  for (const [name, tool] of unique) {
    if (deferredNames.has(name)) deferred.set(name, tool);
    else immediate.push(tool);
  }
  return { immediate, deferred };
}

function transportOptions(
  options: OpenAICodexResponsesOptions | undefined,
): OpenAICodexResponsesOptions {
  return options ?? {};
}

function nativeOverrideRequired(
  rawItems: readonly ResponsesItem[],
  canonicalItems: readonly SerializedResponsesItem[],
): boolean {
  if (rawItems.length !== canonicalItems.length) return true;
  return rawItems.some(
    (item, index) =>
      stableResponsesJson(normalizeReplayItem(item)) !== stableResponsesJson(canonicalItems[index]),
  );
}

function captureRawEvents(
  events: AsyncIterable<JsonRecord>,
  items: ResponsesItem[],
): AsyncIterable<JsonRecord> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (event.type === "response.output_item.done" && isResponsesItem(event.item)) {
          items.push(structuredClone(event.item));
        }
        if (
          (event.type === "response.completed" || event.type === "response.incomplete") &&
          isObject(event.response) &&
          Array.isArray(event.response["output"])
        ) {
          const terminalItems = event.response["output"].filter(isResponsesItem);
          if (terminalItems.length > 0) {
            items.splice(0, items.length, ...terminalItems.map((item) => structuredClone(item)));
          }
        }
        yield event;
      }
    },
  };
}

function startOnFirstEvent(
  events: AsyncIterable<JsonRecord>,
  onStart: () => void,
): AsyncIterable<JsonRecord> {
  return {
    async *[Symbol.asyncIterator]() {
      let started = false;
      for await (const event of events) {
        if (!started) {
          started = true;
          onStart();
        }
        yield event;
      }
    },
  };
}

function clearStreamingScratchState(message: AssistantMessage): void {
  for (const block of message.content) {
    delete (block as { partialJson?: string }).partialJson;
    delete (block as { customInput?: unknown }).customInput;
  }
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

function successfulStopReason(
  message: AssistantMessage,
): message is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
  return (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse"
  );
}

function applyServiceTierPricing(
  usage: Usage,
  model: Model<any>,
  requestedTier: unknown,
  responseTier: string | undefined,
): void {
  const resolvedTier =
    responseTier === "default" && (requestedTier === "priority" || requestedTier === "flex")
      ? requestedTier
      : (responseTier ?? requestedTier);
  const multiplier =
    resolvedTier === "flex"
      ? 0.5
      : resolvedTier === "priority"
        ? model.id === "gpt-5.5"
          ? 2.5
          : 2
        : 1;
  if (multiplier === 1) return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function userEntryAfterLastSampled(branch: readonly SessionEntry[]): SessionEntry | undefined {
  const lastSampledIndex = branch.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "assistant" || entry.message.role === "toolResult"),
  );
  return branch
    .slice(lastSampledIndex + 1)
    .find((entry) => entry.type === "message" && entry.message.role === "user");
}

function splitUnsampledUserInput(options: {
  branch: readonly SessionEntry[];
  history: readonly ResponsesItem[];
  model: Model<any>;
  allTools: readonly ToolInfo[];
  grammarToolInputProperties: GrammarToolInputProperties;
  imageDetail: ImageDetail;
}):
  | { kind: "none" | "found"; history: ResponsesItem[]; tail: ResponsesItem[] }
  | { kind: "unsafe" } {
  const firstUnsampled = userEntryAfterLastSampled(options.branch);
  if (!firstUnsampled) {
    return {
      kind: "none",
      history: options.history.map((item) => structuredClone(item)),
      tail: [],
    };
  }

  const unsampledIndex = options.branch.findIndex((entry) => entry.id === firstUnsampled.id);
  const encoded = providerHistory({
    branch: options.branch.slice(unsampledIndex),
    wireModel: options.model,
    allTools: options.allTools,
    grammarToolInputProperties: options.grammarToolInputProperties,
    imageDetail: options.imageDetail,
  });
  if (encoded.length === 0 || encoded.length > options.history.length) return { kind: "unsafe" };

  const splitIndex = options.history.length - encoded.length;
  if (JSON.stringify(options.history.slice(splitIndex)) !== JSON.stringify(encoded)) {
    return { kind: "unsafe" };
  }
  return {
    kind: "found",
    history: options.history.slice(0, splitIndex).map((item) => structuredClone(item)),
    tail: encoded.map((item) => structuredClone(item)),
  };
}

export class CodexProviderRuntime {
  readonly transport = new CodexTransport();
  private readonly scopes = new Map<string, RuntimeScope>();
  private readonly templates = new Map<string, RequestTemplate>();
  private readonly requestTails = new Map<string, Promise<void>>();
  private readonly pi: ExtensionAPI;
  private readonly resolveConfig: ConfigResolver;

  constructor(pi: ExtensionAPI, resolveConfig: ConfigResolver) {
    this.pi = pi;
    this.resolveConfig = resolveConfig;
  }

  captureScope(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = ctx.getContextUsage();
    this.scopes.set(sessionId, {
      sessionId,
      manager: ctx.sessionManager as MutableSessionManager,
      branch: ctx.sessionManager.getBranch() as SessionEntry[],
      leafId: ctx.sessionManager.getLeafId(),
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      config: this.resolveConfig(ctx),
      hasUI: ctx.hasUI,
      notify: (message, level) => ctx.ui.notify(message, level),
    });
  }

  clearSession(sessionId: string): void {
    this.scopes.delete(sessionId);
    this.templates.delete(sessionId);
    this.requestTails.delete(sessionId);
    this.transport.close(sessionId);
  }

  private async acquireRequest(
    sessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (!sessionId) return () => {};
    const previous = this.requestTails.get(sessionId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.requestTails.set(sessionId, current);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.requestTails.get(sessionId) === current) this.requestTails.delete(sessionId);
    };

    if (signal?.aborted) {
      void previous.then(release);
      throw new Error("Request was aborted");
    }

    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        previous,
        ...(signal
          ? [
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error("Request was aborted"));
                signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]
          : []),
      ]);
    } catch (error) {
      void previous.then(release);
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) {
      release();
      throw new Error("Request was aborted");
    }
    return release;
  }

  createProvider(base: Provider): Provider {
    return {
      ...base,
      stream: (model, context, options) =>
        this.stream(model, context, options as OpenAICodexResponsesOptions | undefined),
      streamSimple: (model, context, options) => this.streamSimple(model, context, options),
    } as Provider;
  }

  private wireHistory(
    model: Model<any>,
    context: Context,
    grammarToolInputProperties: GrammarToolInputProperties,
  ): ResponsesItem[] {
    const sessionId = (context as Context & { sessionId?: string }).sessionId;
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    if (!scope) {
      const compat = model.compat as CodexCompat | undefined;
      const nativeItems = new Map<string, ResponsesItem[]>();
      return convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
        deferredTools: splitDeferredTools(context, Boolean(compat?.supportsToolSearch)).deferred,
        toolOptions: {
          strict: null,
          supportsStrictMode: compat?.supportsStrictMode ?? true,
          supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
        },
        namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
        textContentItemToolResultNames: CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
        toolResultImageDetail: "auto",
        nativeAssistantItems: nativeItems,
      }) as ResponsesItem[];
    }
    return providerHistory({
      branch: scope.manager.getBranch() as SessionEntry[],
      wireModel: model,
      allTools: this.pi.getAllTools(),
      grammarToolInputProperties,
      imageDetail: scope.config.imageDetail,
    });
  }

  private buildRequestBody(
    model: Model<any>,
    context: Context,
    options: OpenAICodexResponsesOptions,
    runtimeSessionId: string | undefined,
    cacheSessionId: string | undefined,
    grammarToolInputProperties: GrammarToolInputProperties,
  ): JsonRecord {
    const compat = model.compat as CodexCompat | undefined;
    const toolPlacement = splitDeferredTools(context, Boolean(compat?.supportsToolSearch));
    const body: JsonRecord = {
      model: model.id,
      store: false,
      stream: true,
      instructions: context.systemPrompt || "You are a helpful assistant.",
      input: this.wireHistory(
        model,
        Object.assign({}, context, { sessionId: runtimeSessionId }),
        grammarToolInputProperties,
      ),
      text: { verbosity: options.textVerbosity ?? "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: cacheSessionId,
      tool_choice: options.toolChoice ?? "auto",
      parallel_tool_calls: true,
    };
    if (options.temperature !== undefined) body["temperature"] = options.temperature;
    if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
    if (toolPlacement.immediate.length > 0) {
      body.tools = convertResponsesTools(toolPlacement.immediate, {
        strict: null,
        supportsStrictMode: compat?.supportsStrictMode ?? true,
        supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
        namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
      });
    }
    if (options.reasoningEffort !== undefined) {
      const mapped =
        options.reasoningEffort === "none"
          ? (model.thinkingLevelMap?.off ?? "none")
          : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
      if (mapped !== null) {
        body["reasoning"] = {
          effort: mapped,
          summary: options.reasoningSummary ?? "auto",
        };
      }
    }
    return body;
  }

  private async performCompaction(options: {
    model: Model<any>;
    requestOptions: OpenAICodexResponsesOptions;
    history: ResponsesItem[];
    postCompactionTail?: ResponsesItem[];
    template: JsonRecord;
    instructions: string;
    grammarToolInputProperties: GrammarToolInputProperties;
    priority: boolean;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
    const sessionId = options.requestOptions.sessionId;
    if (!sessionId) throw new Error("Codex compaction requires a Pi session id.");
    const accountId = validateCodexAuthentication(options.model, options.requestOptions.apiKey);
    const payload = remoteCompactionPayload({
      template: options.template,
      modelId: options.model.id,
      history: options.history,
      instructions: options.instructions,
      sessionId:
        options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
      priority: options.priority,
    });
    const transformed = await options.requestOptions.onPayload?.(payload, options.model);
    const request = transformed === undefined ? payload : (transformed as JsonRecord);
    const compacted = await collectRemoteCompaction(
      this.transport.request(options.model, request, {
        ...options.requestOptions,
        accountId,
      }),
      options.model,
      options.priority,
    );
    return {
      checkpoint: checkpointData(
        options.model.id,
        options.history,
        compacted.item,
        options.postCompactionTail,
      ),
      ...(compacted.usage ? { usage: compacted.usage } : {}),
    };
  }

  private async maybeCompactPercentage(
    model: Model<any>,
    context: Context,
    options: OpenAICodexResponsesOptions,
    body: JsonRecord,
    grammarToolInputProperties: GrammarToolInputProperties,
  ): Promise<JsonRecord> {
    const sessionId = options.sessionId;
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    const threshold = scope?.config.autoCompactAtPercent;
    if (
      !scope ||
      threshold === undefined ||
      scope.contextPercent === null ||
      scope.contextPercent < threshold ||
      !Array.isArray(body.input)
    ) {
      return body;
    }

    const branch = scope.manager.getBranch() as SessionEntry[];
    const checkpoint = searchCheckpoint(branch);
    const hasNewAssistant =
      checkpoint.kind !== "found" ||
      branch
        .slice(checkpoint.entryIndex + 1)
        .some((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!hasNewAssistant) return body;

    const history = body.input.map((item) => {
      if (!isResponsesItem(item))
        throw new Error("Codex request history contains an invalid item.");
      return structuredClone(item);
    });
    const split = splitUnsampledUserInput({
      branch,
      history,
      model,
      allTools: this.pi.getAllTools(),
      grammarToolInputProperties,
      imageDetail: scope.config.imageDetail,
    });
    if (split.kind === "unsafe") {
      scope.notify(
        "OpenAI Codex percentage compaction was deferred because unsampled input could not be isolated safely.",
        "warning",
      );
      return body;
    }

    const compacted = await this.performCompaction({
      model,
      requestOptions: options,
      history: split.history,
      postCompactionTail: split.tail,
      template: withoutConversationInput(body),
      instructions:
        typeof body.instructions === "string"
          ? body.instructions
          : context.systemPrompt || "You are a helpful assistant.",
      grammarToolInputProperties,
      priority: scope.config.fastMode,
    });
    const firstKeptEntryId = userEntryAfterLastSampled(branch)?.id ?? scope.manager.getLeafId();
    if (!firstKeptEntryId || typeof scope.manager.appendCompaction !== "function") {
      throw new Error("Pi's mutable SessionManager is unavailable for percentage compaction.");
    }
    if (scope.manager.getLeafId() !== scope.leafId) {
      throw new Error("Pi's active session branch changed while Codex was compacting.");
    }
    scope.manager.appendCompaction(
      markerSummary(),
      firstKeptEntryId,
      scope.contextTokens ?? 0,
      compacted.checkpoint,
      true,
      compacted.usage,
    );
    scope.notify(
      `OpenAI Codex context compacted at ${scope.contextPercent.toFixed(1)}% and will continue.`,
      "info",
    );
    return updateInput(body, compacted.checkpoint.history);
  }

  stream(
    model: Model<any>,
    context: Context,
    options?: OpenAICodexResponsesOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const requestOptions = transportOptions(options);
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: CODEX_API,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      const runtimeSessionId = requestOptions.sessionId;
      let releaseRequest = () => {};
      try {
        const accountId = validateCodexAuthentication(model, requestOptions.apiKey);
        releaseRequest = await this.acquireRequest(runtimeSessionId, requestOptions.signal);
        const cacheSessionId =
          requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(runtimeSessionId);
        const grammarToolInputProperties = createGrammarToolInputProperties(
          context.tools,
          (model.compat as CodexCompat | undefined)?.supportsOpenAIGrammarTools ?? false,
        );
        let body = this.buildRequestBody(
          model,
          context,
          requestOptions,
          runtimeSessionId,
          cacheSessionId,
          grammarToolInputProperties,
        );
        const transformed = await requestOptions.onPayload?.(body, model);
        if (transformed !== undefined) body = transformed as JsonRecord;
        if (runtimeSessionId) {
          this.templates.set(runtimeSessionId, {
            modelId: model.id,
            payload: withoutConversationInput(body),
            grammarToolInputProperties,
            requestOptions: { ...requestOptions },
          });
        }
        body = await this.maybeCompactPercentage(
          model,
          context,
          requestOptions,
          body,
          grammarToolInputProperties,
        );

        const rawItems: ResponsesItem[] = [];
        let continuationHandle: CodexContinuationHandle | undefined;
        let startEmitted = false;
        const emitStart = () => {
          if (startEmitted) return;
          startEmitted = true;
          stream.push({ type: "start", partial: output });
        };
        const transportRequestOptions = {
          ...requestOptions,
          accountId,
          onContinuationReady(handle: CodexContinuationHandle) {
            continuationHandle = handle;
          },
          onTransportStart: emitStart,
          onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
            output.diagnostics = [...(output.diagnostics ?? []), diagnostic];
          },
        };
        await processCodexStream(
          startOnFirstEvent(
            captureRawEvents(
              this.transport.request(model, body, transportRequestOptions),
              rawItems,
            ),
            emitStart,
          ),
          output,
          stream,
          model,
          grammarToolInputProperties,
          {
            applyServiceTierPricing(usage, responseServiceTier) {
              applyServiceTierPricing(usage, model, body.service_tier, responseServiceTier);
            },
          },
        );
        if (requestOptions.signal?.aborted) throw new Error("Request was aborted");
        if (!successfulStopReason(output)) {
          throw new Error(output.errorMessage || "Codex stream ended without a successful stop.");
        }

        const compat = model.compat as CodexCompat | undefined;
        const canonicalContext: Context = {
          messages: [output],
          ...(context.tools ? { tools: context.tools } : {}),
        };
        const canonicalItems = convertResponsesMessages(
          model,
          canonicalContext,
          CODEX_TOOL_CALL_PROVIDERS,
          {
            includeSystemPrompt: false,
            grammarToolInputProperties,
            deferredTools: splitDeferredTools(context, Boolean(compat?.supportsToolSearch))
              .deferred,
            toolOptions: {
              strict: null,
              supportsStrictMode: compat?.supportsStrictMode ?? true,
              supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
            },
            namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
            textContentItemToolResultNames: CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
            toolResultImageDetail:
              (runtimeSessionId
                ? this.scopes.get(runtimeSessionId)?.config.imageDetail
                : undefined) ?? "auto",
          },
        ).filter(
          (item) =>
            item["type"] !== "function_call_output" && item["type"] !== "custom_tool_call_output",
        );
        const persistNativeItems =
          rawItems.length > 0 && nativeOverrideRequired(rawItems, canonicalItems);
        if (persistNativeItems) {
          if (!output.responseId) throw new Error("Codex response is missing a response id.");
          this.pi.appendEntry(
            NATIVE_RESPONSE_ENTRY_TYPE,
            nativeResponseData(model.id, output.responseId, rawItems),
          );
        }
        const readyContinuation = continuationHandle;
        if (readyContinuation && readyContinuation.responseId === output.responseId) {
          readyContinuation.replaceResponseItems(persistNativeItems ? rawItems : canonicalItems);
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        clearStreamingScratchState(output);
        output.stopReason = requestOptions.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatProviderError(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      } finally {
        releaseRequest();
      }
    })();
    return stream;
  }

  streamSimple(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const effort = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    return this.stream(model, context, {
      ...options,
      ...(effort && effort !== "off" ? { reasoningEffort: effort } : {}),
    });
  }

  latestTemplate(sessionId: string): RequestTemplate | undefined {
    return this.templates.get(sessionId);
  }

  async compact(options: {
    model: Model<any>;
    requestOptions: OpenAICodexResponsesOptions;
    history: ResponsesItem[];
    instructions: string;
    grammarToolInputProperties: GrammarToolInputProperties;
    template: JsonRecord;
    priority: boolean;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
    validateCodexAuthentication(options.model, options.requestOptions.apiKey);
    const release = await this.acquireRequest(
      options.requestOptions.sessionId,
      options.requestOptions.signal,
    );
    try {
      return await this.performCompaction(options);
    } finally {
      release();
    }
  }
}

export function registerCodexProvider(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver,
): CodexProviderRuntime {
  const runtime = new CodexProviderRuntime(pi, resolveConfig);
  pi.on("session_start", (_event, ctx) => {
    const base =
      ctx.modelRegistry.getRegisteredNativeProvider(CODEX_PROVIDER) ??
      ctx.modelRegistry.getProvider(CODEX_PROVIDER);
    if (!base) throw new Error("Pi's built-in OpenAI Codex provider is unavailable.");
    pi.registerProvider(runtime.createProvider(base));
  });
  return runtime;
}
