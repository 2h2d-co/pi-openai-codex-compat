import { requireJsonRecord, requireJsonValues } from "../codex-protocol.ts";
import { isFunction, isNonNullObject, isString } from "../value-contracts.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  type SimpleStreamOptions,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
  codexCacheDiagnosticContext,
  type CodexCacheDiagnosticContext,
} from "../codex-cache-diagnostics.ts";
import {
  checkpointData,
  providerHistory,
  remoteCompactionMarkerSummary,
  responsesCompatibility,
  searchCheckpoint,
  type CheckpointData,
  type CompactionDecision,
  type GrammarToolInputProperties,
} from "../compaction-checkpoint.ts";
import { CODEX_API, CODEX_TOOL_CALL_PROVIDERS } from "../codex-identifiers.ts";
import {
  collectRemoteCompaction,
  isObject,
  remoteCompactionPayload,
  requireResponsesInputItems,
  withoutConversationInput,
  type JsonRecord,
  type JsonValue,
} from "../codex-protocol.ts";
import { codexCacheKey } from "../codex-cache-key.ts";
import {
  type CodexCompactionMetadata,
  type CodexMetadataIdentity,
  responsesCompactionV2Metadata,
  withCodexRequestMetadata,
} from "../codex-metadata.ts";
import { resolveCodexThreadIdentity, type CodexThreadIdentity } from "../codex-thread-lineage.ts";
import { applyResponsesLite } from "../responses-lite.ts";
import { requiredValue } from "../required-value.ts";
import { processCodexStream, type CodexStreamAttemptState } from "../codex-stream.ts";
import {
  CodexTransport,
  CodexTurnState,
  WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
  isWebSocketConnectionLimitReachedError,
  validateCodexAuthentication,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
  type CodexWebSocketResponseHandle,
} from "../codex-transport.ts";
import { DEFAULT_CONFIG, type CodexCompatConfig } from "../config.ts";
import {
  nativeResponseData,
  NATIVE_RESPONSE_ENTRY_TYPE,
  type NativeResponseAttempt,
} from "../native-history.ts";
import {
  CODEX_NAMESPACED_TOOL_NAMES,
  CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
} from "../namespaced-tools.ts";
import {
  RESPONSES_INPUT_ITEM_SCHEMA,
  type ResponsesInputItem,
  type ResponsesOutputItem,
} from "../responses-item-schema.ts";
import {
  convertResponsesTools,
  convertResponsesMessages,
  createGrammarToolInputProperties,
} from "../vendor/pi-ai/openai-responses-serialization.ts";
import { errorFromThrown } from "../error-from-thrown.ts";
import type {
  ActiveAgentTurn,
  CodexAttemptCapture,
  CodexPostToolDisposition,
  CodexResponseDecision,
  CodexResponseRetryPolicy,
  CodexTerminalCapture,
  CodexTerminalState,
  CompactionSessionManager,
  ConfigResolver,
  RequestTemplate,
  RuntimeScopeContext,
  RuntimeScope,
  SessionContext,
} from "./codex-provider-contracts.ts";

function hasAppendCompaction(
  value: RuntimeScopeContext["sessionManager"],
): value is CompactionSessionManager {
  return "appendCompaction" in value && isFunction(value.appendCompaction);
}

function codexStreamOptions(value: unknown): OpenAICodexResponsesOptions | undefined {
  if (value === undefined) return undefined;
  if (!isNonNullObject(value)) {
    throw new Error("OpenAI Codex stream options must be an object.");
  }
  return { ...value };
}
import {
  nativeOverrideRequired,
  splitDeferredTools,
  splitUnsampledUserInput,
  userEntryAfterLastSampled,
} from "./codex-provider-history.ts";
import {
  accumulateUsage,
  applyServiceTierPricing,
  assertLinkedToolOutputs,
  assertSuccessfulOutput,
  assessAttemptToolCalls,
  captureRawEvents,
  clearStreamingScratchState,
  completedAttemptToolCallIds,
  continueResponseBody,
  discardIncompleteAttemptContent,
  emptyUsage,
  reachedProviderCompactionThreshold,
  responseDecisionDiagnostic,
  responseRetryDelayMs,
  retryableResponseFailure,
  startOnFirstEvent,
  terminalErrorMessage,
  terminalReason,
  transportOptions,
  updateInput,
  waitForResponseRetry,
} from "./codex-provider-response-attempts.ts";

export const PROVIDER_COMPACTION_BOUNDARY_STOP_REASON = "completed.end_turn_false.context_limit";

export const DEFAULT_RESPONSE_RETRY_POLICY: CodexResponseRetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 200,
};

export type CodexProviderRuntimeApi = Pick<ExtensionAPI, "appendEntry" | "getAllTools">;

type CodexCompactionResult = { checkpoint: CheckpointData; usage?: Usage };

type BuildRequestBodyOptions = {
  model: Model<Api>;
  context: Context;
  requestOptions: OpenAICodexResponsesOptions;
  runtimeSessionId: string | undefined;
  cacheSessionId: string | undefined;
  grammarToolInputProperties: GrammarToolInputProperties;
  turnId: string;
};

export class CodexProviderRuntime {
  readonly transport = new CodexTransport();
  private readonly scopes = new Map<string, RuntimeScope>();
  private readonly templates = new Map<string, RequestTemplate>();
  private readonly prewarmedTemplates = new Set<string>();
  private readonly requestTails = new Map<string, Promise<void>>();
  private readonly activeAgentTurns = new Map<string, ActiveAgentTurn>();
  private readonly postToolDispositions = new Map<string, CodexPostToolDisposition>();
  private readonly windowNumbers = new Map<string, number>();
  private readonly activeThreadIds = new Map<string, string>();
  private readonly pi: CodexProviderRuntimeApi;
  private readonly resolveConfig: ConfigResolver;
  private readonly installationId: string;
  private readonly responseRetryPolicy: CodexResponseRetryPolicy;

  constructor(
    pi: CodexProviderRuntimeApi,
    resolveConfig: ConfigResolver,
    installationId: string = randomUUID(),
    responseRetryPolicy: Partial<CodexResponseRetryPolicy> = {},
  ) {
    this.pi = pi;
    this.resolveConfig = resolveConfig;
    this.installationId = installationId;
    const maxRetries = responseRetryPolicy.maxRetries ?? DEFAULT_RESPONSE_RETRY_POLICY.maxRetries;
    const baseDelayMs =
      responseRetryPolicy.baseDelayMs ?? DEFAULT_RESPONSE_RETRY_POLICY.baseDelayMs;
    if (!Number.isFinite(maxRetries) || maxRetries < 0) {
      throw new Error(`Invalid Codex response maxRetries: ${String(maxRetries)}`);
    }
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new Error(`Invalid Codex response baseDelayMs: ${String(baseDelayMs)}`);
    }
    this.responseRetryPolicy = {
      maxRetries: Math.floor(maxRetries),
      baseDelayMs: Math.floor(baseDelayMs),
    };
  }

  captureScope(ctx: RuntimeScopeContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const usage = ctx.getContextUsage();
    if (!hasAppendCompaction(ctx.sessionManager)) {
      throw new Error("OpenAI Codex requires Pi's compaction-capable session manager.");
    }
    this.scopes.set(sessionId, {
      sessionId,
      manager: ctx.sessionManager,
      branch: ctx.sessionManager.getBranch(),
      leafId: ctx.sessionManager.getLeafId(),
      contextTokens: usage?.tokens ?? null,
      contextPercent: usage?.percent ?? null,
      config: this.resolveConfig(ctx),
      hasUI: ctx.hasUI,
      notify: (message, level) => ctx.ui.notify(message, level),
    });
  }

  beginAgentTurn(ctx: SessionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    this.clearPostToolDispositions((disposition) => disposition.sessionId === sessionId);
    this.activeAgentTurns.set(sessionId, {
      turnId: uuidv7(),
      startedAtUnixMs: Date.now(),
      turnState: new CodexTurnState(),
    });
  }

  endAgentTurn(ctx: SessionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const agentTurn = this.activeAgentTurns.get(sessionId);
    if (agentTurn) {
      this.clearPostToolDispositions((disposition) => disposition.turnId === agentTurn.turnId);
    }
    this.activeAgentTurns.delete(sessionId);
  }

  updateSessionConfig(sessionId: string, config: CodexCompatConfig): void {
    const scope = this.scopes.get(sessionId);
    if (scope) scope.config = config;
  }

  private responsesLiteEnabled(sessionId: string | undefined): boolean {
    return (
      (sessionId ? this.scopes.get(sessionId)?.config.responsesLite : undefined) ??
      DEFAULT_CONFIG.responsesLite
    );
  }

  private agentTurn(sessionId: string | undefined): ActiveAgentTurn {
    return (
      (sessionId ? this.activeAgentTurns.get(sessionId) : undefined) ?? {
        turnId: uuidv7(),
        startedAtUnixMs: Date.now(),
        turnState: new CodexTurnState(),
      }
    );
  }

  private rememberPostToolDisposition(disposition: CodexPostToolDisposition): void {
    const callIds = new Set(disposition.callIds);
    if ([...callIds].some((callId) => this.postToolDispositions.has(callId))) {
      throw new Error("Codex returned a tool call that already has a pending disposition.");
    }
    for (const callId of callIds) this.postToolDispositions.set(callId, disposition);
  }

  private findPostToolDisposition(context: Context): CodexPostToolDisposition | undefined {
    const matches = new Set<CodexPostToolDisposition>();
    for (const message of context.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const disposition = this.postToolDispositions.get(block.id);
        if (disposition) matches.add(disposition);
      }
    }
    if (matches.size > 1) {
      throw new Error("Codex context contains multiple pending post-tool dispositions.");
    }
    return matches.values().next().value;
  }

  private forgetPostToolDisposition(disposition: CodexPostToolDisposition): void {
    for (const callId of disposition.callIds) {
      if (this.postToolDispositions.get(callId) === disposition) {
        this.postToolDispositions.delete(callId);
      }
    }
  }

  private clearPostToolDispositions(
    shouldClear: (disposition: CodexPostToolDisposition) => boolean,
  ): void {
    for (const [callId, disposition] of this.postToolDispositions) {
      if (shouldClear(disposition)) this.postToolDispositions.delete(callId);
    }
  }

  private metadataIdentity(
    metadataSessionId: string | undefined,
    turn?: ActiveAgentTurn,
    runtimeSessionId = metadataSessionId,
  ): CodexMetadataIdentity {
    const thread: Partial<CodexThreadIdentity> = runtimeSessionId
      ? this.threadIdentity(runtimeSessionId)
      : metadataSessionId
        ? { threadId: metadataSessionId }
        : {};
    const windowKey =
      runtimeSessionId && thread.threadId ? `${runtimeSessionId}\0${thread.threadId}` : undefined;
    const identity: CodexMetadataIdentity = {
      installationId: this.installationId,
      windowNumber: windowKey ? (this.windowNumbers.get(windowKey) ?? 0) : 0,
      threadSource: "user",
      // Pi extensions execute without Codex's platform sandbox.
      sandbox: "none",
    };
    if (thread.threadId) identity.threadId = thread.threadId;
    if (thread.forkedFromThreadId) {
      identity.forkedFromThreadId = thread.forkedFromThreadId;
    }
    if (turn) identity.turnStartedAtUnixMs = turn.startedAtUnixMs;
    return identity;
  }

  private threadIdentity(sessionId: string): CodexThreadIdentity {
    const branch = this.scopes.get(sessionId)?.manager.getBranch();
    return resolveCodexThreadIdentity(sessionId, branch ?? []);
  }

  private clearPrewarmState(sessionId: string): void {
    for (const key of this.prewarmedTemplates) {
      if (key.startsWith(`${sessionId}\0`)) this.prewarmedTemplates.delete(key);
    }
  }

  private activateThread(sessionId: string | undefined): void {
    if (!sessionId) return;
    const threadId = this.threadIdentity(sessionId).threadId;
    const previous = this.activeThreadIds.get(sessionId);
    if (previous && previous !== threadId) {
      this.transport.close(sessionId);
      this.clearPrewarmState(sessionId);
    }
    this.activeThreadIds.set(sessionId, threadId);
  }

  private advanceWindow(sessionId: string): void {
    const threadId = this.threadIdentity(sessionId).threadId;
    const key = `${sessionId}\0${threadId}`;
    this.windowNumbers.set(key, (this.windowNumbers.get(key) ?? 0) + 1);
  }

  clearSession(sessionId: string): void {
    this.scopes.delete(sessionId);
    this.templates.delete(sessionId);
    this.clearPrewarmState(sessionId);
    this.requestTails.delete(sessionId);
    this.activeAgentTurns.delete(sessionId);
    this.clearPostToolDispositions((disposition) => disposition.sessionId === sessionId);
    for (const key of this.windowNumbers.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.windowNumbers.delete(key);
    }
    this.activeThreadIds.delete(sessionId);
    this.transport.close(sessionId);
  }

  private async maybePrewarm(options: {
    model: Model<Api>;
    body: JsonRecord;
    fullBody: JsonRecord;
    requestOptions: OpenAICodexResponsesOptions;
    accountId: string;
    diagnostics: CodexTransportDiagnostic[];
    turnState: CodexTurnState;
    cacheDiagnostics: CodexCacheDiagnosticContext;
  }): Promise<void> {
    const sessionId = options.requestOptions.sessionId;
    if (
      !sessionId ||
      options.requestOptions.cacheRetention === "none" ||
      options.requestOptions.transport === "sse" ||
      !Array.isArray(options.body.input) ||
      !Array.isArray(options.fullBody.input)
    ) {
      return;
    }
    const key = `${sessionId}\0${options.model.id}\0${options.cacheDiagnostics.envelope}`;
    if (this.prewarmedTemplates.has(key)) return;
    this.prewarmedTemplates.add(key);

    const cacheSessionId = codexCacheKey(sessionId);
    const prewarmBody = withCodexRequestMetadata(options.body, {
      sessionId: cacheSessionId,
      request: { kind: "prewarm" },
      turnId: "",
      identity: this.metadataIdentity(cacheSessionId, undefined, sessionId),
    });
    try {
      await this.transport.prewarm(options.model, prewarmBody, {
        ...options.requestOptions,
        accountId: options.accountId,
        turnState: options.turnState,
        cacheDiagnostics: options.cacheDiagnostics,
        requestKind: "prewarm",
        onTransportDiagnostic(diagnostic) {
          options.diagnostics.push(diagnostic);
        },
      });
      // oxlint-disable-next-line preserve-caught-error -- CodexTransport.prewarm emits a structured failure diagnostic, including the caught error, before this best-effort boundary.
    } catch {
      // Warmup is best-effort. The transport has already activated sticky SSE
      // after exhausting its WebSocket retry budget.
    }
  }

  private async acquireRequest(
    sessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (!sessionId) return () => {};
    const previous = this.requestTails.get(sessionId) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const releaseRequest = requiredValue(
      releaseCurrent,
      "Codex request serialization gate did not initialize.",
    );
    this.requestTails.set(sessionId, current);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseRequest();
      if (this.requestTails.get(sessionId) === current) this.requestTails.delete(sessionId);
    };

    if (signal?.aborted) {
      previous.then(release, release);
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
      previous.then(release, release);
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
      stream: (model, context, options) => this.stream(model, context, codexStreamOptions(options)),
      streamSimple: (model, context, options) => this.streamSimple(model, context, options),
    };
  }

  private wireHistory(
    model: Model<Api>,
    context: Context,
    grammarToolInputProperties: GrammarToolInputProperties,
    sessionId: string | undefined,
  ): ResponsesInputItem[] {
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    if (!scope) {
      const compat = responsesCompatibility(model.compat);
      const nativeItems = new Map<string, ResponsesOutputItem[]>();
      return requireResponsesInputItems(
        convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
          includeSystemPrompt: false,
          grammarToolInputProperties,
          deferredTools: splitDeferredTools(context, Boolean(compat?.supportsToolSearch)).deferred,
          toolOptions: {
            strict: false,
            supportsStrictMode: compat?.supportsStrictMode ?? true,
            supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
          },
          namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
          textContentItemToolResultNames: CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
          toolResultImageDetail: "auto",
          nativeAssistantItems: nativeItems,
        }),
      );
    }
    return providerHistory({
      branch: scope.manager.getBranch(),
      wireModel: model,
      allTools: this.pi.getAllTools(),
      grammarToolInputProperties,
      imageDetail: scope.config.imageDetail,
    });
  }

  private buildRequestBody(options: BuildRequestBodyOptions): JsonRecord {
    const {
      model,
      context,
      requestOptions,
      runtimeSessionId,
      cacheSessionId,
      grammarToolInputProperties,
      turnId,
    } = options;
    const compat = responsesCompatibility(model.compat);
    const toolPlacement = splitDeferredTools(context, Boolean(compat?.supportsToolSearch));
    let body: JsonRecord = {
      model: model.id,
      store: false,
      stream: true,
      instructions: context.systemPrompt || "You are a helpful assistant.",
      input: this.wireHistory(model, context, grammarToolInputProperties, runtimeSessionId),
      text: { verbosity: requestOptions.textVerbosity ?? "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: requestOptions.toolChoice ?? "auto",
      parallel_tool_calls: true,
      tools: [],
    };
    if (cacheSessionId !== undefined) body.prompt_cache_key = cacheSessionId;
    body = withCodexRequestMetadata(body, {
      sessionId: cacheSessionId,
      request: { kind: "turn" },
      turnId,
      identity: this.metadataIdentity(
        cacheSessionId,
        this.activeAgentTurns.get(runtimeSessionId ?? ""),
        runtimeSessionId,
      ),
    });
    if (requestOptions.serviceTier !== undefined) body.service_tier = requestOptions.serviceTier;
    if (toolPlacement.immediate.length > 0) {
      body.tools = convertResponsesTools(toolPlacement.immediate, {
        strict: false,
        supportsStrictMode: compat?.supportsStrictMode ?? true,
        supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
        namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
      });
    }
    if (requestOptions.reasoningEffort !== undefined) {
      const mapped =
        requestOptions.reasoningEffort === "none"
          ? (model.thinkingLevelMap?.off ?? "none")
          : (model.thinkingLevelMap?.[requestOptions.reasoningEffort] ??
            requestOptions.reasoningEffort);
      if (mapped !== null) {
        body["reasoning"] = {
          effort: mapped,
          summary: requestOptions.reasoningSummary ?? "auto",
        };
      }
    }
    return body;
  }

  private async performCompaction(options: {
    model: Model<Api>;
    requestOptions: OpenAICodexResponsesOptions;
    history: ResponsesInputItem[];
    postCompactionTail?: ResponsesInputItem[];
    template: JsonRecord;
    instructions: string;
    grammarToolInputProperties: GrammarToolInputProperties;
    priority: boolean;
    compactionMetadata: CodexCompactionMetadata;
    compactionDecision: CompactionDecision;
    agentTurn?: ActiveAgentTurn;
    responsesLiteEnabled?: boolean;
  }): Promise<CodexCompactionResult> {
    const sessionId = options.requestOptions.sessionId;
    if (!sessionId) throw new Error("Codex compaction requires a Pi session id.");
    this.activateThread(sessionId);
    const agentTurn = options.agentTurn ?? this.agentTurn(sessionId);
    const responsesLiteEnabled =
      options.responsesLiteEnabled ?? this.responsesLiteEnabled(sessionId);
    const accountId = validateCodexAuthentication(options.model, options.requestOptions.apiKey);
    const payload = withCodexRequestMetadata(
      remoteCompactionPayload({
        template: options.template,
        modelId: options.model.id,
        history: options.history,
        instructions: options.instructions,
        sessionId:
          options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
        priority: options.priority,
      }),
      {
        sessionId:
          options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
        request: { kind: "compaction", compaction: options.compactionMetadata },
        turnId: agentTurn.turnId,
        identity: this.metadataIdentity(
          options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
          agentTurn,
          sessionId,
        ),
      },
    );
    const transformed = await options.requestOptions.onPayload?.(payload, options.model);
    const ordinaryRequest = transformed === undefined ? payload : requireJsonRecord(transformed);
    const request = applyResponsesLite(ordinaryRequest, options.model.id, responsesLiteEnabled);
    const staticRequest = applyResponsesLite(
      updateInput(ordinaryRequest, []),
      options.model.id,
      responsesLiteEnabled,
    );
    const cacheDiagnostics = codexCacheDiagnosticContext(
      ordinaryRequest,
      request,
      staticRequest,
      options.model.id,
      responsesLiteEnabled,
    );
    let webSocketResponseHandle: CodexWebSocketResponseHandle | undefined;
    let compacted: Awaited<ReturnType<typeof collectRemoteCompaction>>;
    try {
      compacted = await collectRemoteCompaction(
        this.transport.request(options.model, request, {
          ...options.requestOptions,
          accountId,
          requestKind: "compaction",
          turnState: agentTurn.turnState,
          cacheDiagnostics,
          onWebSocketResponseHandle(handle) {
            webSocketResponseHandle = handle;
          },
        }),
        options.model,
        options.priority,
      );
    } catch (error) {
      if (!options.requestOptions.signal?.aborted) {
        webSocketResponseHandle?.failParsing(error);
      }
      throw error;
    }
    const result: CodexCompactionResult = {
      checkpoint: checkpointData(
        options.model.id,
        options.history,
        compacted.item,
        options.postCompactionTail,
        options.compactionDecision,
      ),
    };
    if (compacted.usage) result.usage = compacted.usage;
    return result;
  }

  private async maybeCompactPercentage(
    model: Model<Api>,
    context: Context,
    options: OpenAICodexResponsesOptions,
    body: JsonRecord,
    grammarToolInputProperties: GrammarToolInputProperties,
    agentTurn: ActiveAgentTurn,
    responsesLiteEnabled: boolean,
  ): Promise<JsonRecord> {
    const sessionId = options.sessionId;
    const scope = sessionId ? this.scopes.get(sessionId) : undefined;
    const threshold = scope?.config.autoCompactAtPercent;
    if (!sessionId || !scope) {
      return body;
    }
    if (
      threshold === undefined ||
      scope.contextPercent === null ||
      scope.contextPercent < threshold ||
      !Array.isArray(body.input)
    ) {
      return body;
    }

    const branch = scope.manager.getBranch();
    const checkpoint = searchCheckpoint(branch);
    const hasNewAssistant =
      checkpoint.kind !== "found" ||
      branch
        .slice(checkpoint.entryIndex + 1)
        .some((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!hasNewAssistant) return body;

    const history = body.input.map((item) => {
      if (!isObject(item) || !Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, item))
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
      instructions: isString(body.instructions)
        ? body.instructions
        : context.systemPrompt || "You are a helpful assistant.",
      grammarToolInputProperties,
      priority: scope.config.fastMode,
      compactionMetadata: responsesCompactionV2Metadata("auto", "context_limit", "pre_turn"),
      compactionDecision: { reason: "provider-boundary", willRetry: true },
      agentTurn,
      responsesLiteEnabled,
    });
    const firstKeptEntryId = userEntryAfterLastSampled(branch)?.id ?? scope.manager.getLeafId();
    if (!firstKeptEntryId) {
      throw new Error("Pi's active session branch has no entry to retain after compaction.");
    }
    if (scope.manager.getLeafId() !== scope.leafId) {
      throw new Error("Pi's active session branch changed while Codex was compacting.");
    }
    scope.manager.appendCompaction(
      remoteCompactionMarkerSummary(),
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
    this.advanceWindow(sessionId);
    const cacheSessionId = options.cacheRetention === "none" ? undefined : codexCacheKey(sessionId);
    return withCodexRequestMetadata(updateInput(body, compacted.checkpoint.history), {
      sessionId: cacheSessionId,
      request: { kind: "turn" },
      turnId: agentTurn.turnId,
      identity: this.metadataIdentity(cacheSessionId, agentTurn, sessionId),
    });
  }

  stream(
    model: Model<Api>,
    context: Context,
    options?: OpenAICodexResponsesOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const requestOptions = transportOptions(options);
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: CODEX_API,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    const runtimeSessionId = requestOptions.sessionId;
    let releaseRequest = () => {};
    let registeredPostToolDisposition: CodexPostToolDisposition | undefined;
    const streamingTask = (async () => {
      const accountId = validateCodexAuthentication(model, requestOptions.apiKey);
      releaseRequest = await this.acquireRequest(runtimeSessionId, requestOptions.signal);
      this.activateThread(runtimeSessionId);
      const cacheSessionId =
        requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(runtimeSessionId);
      const agentTurn = this.agentTurn(runtimeSessionId);
      const responsesLiteEnabled = this.responsesLiteEnabled(runtimeSessionId);
      let carriedResponseRetries = 0;
      const pendingPostToolDisposition = this.findPostToolDisposition(context);
      if (pendingPostToolDisposition) {
        assertLinkedToolOutputs(context, pendingPostToolDisposition);
        this.forgetPostToolDisposition(pendingPostToolDisposition);
        if (
          pendingPostToolDisposition.type === "error" ||
          pendingPostToolDisposition.retryAttempt > this.responseRetryPolicy.maxRetries
        ) {
          throw new Error(terminalErrorMessage(pendingPostToolDisposition));
        }
        carriedResponseRetries = pendingPostToolDisposition.retryAttempt;
        await waitForResponseRetry(
          responseRetryDelayMs(
            this.responseRetryPolicy.baseDelayMs,
            pendingPostToolDisposition.retryAttempt,
          ),
          requestOptions.signal,
        );
      }
      const grammarToolInputProperties = createGrammarToolInputProperties(
        context.tools,
        responsesCompatibility(model.compat).supportsOpenAIGrammarTools ?? false,
      );
      let body = this.buildRequestBody({
        model,
        context,
        requestOptions,
        runtimeSessionId,
        cacheSessionId,
        grammarToolInputProperties,
        turnId: agentTurn.turnId,
      });
      const transformed = await requestOptions.onPayload?.(body, model);
      let replacementValues: JsonValue[] | undefined;
      if (transformed !== undefined) {
        if (Array.isArray(transformed)) {
          replacementValues = requireJsonValues(transformed, "Codex payload replacement");
        } else {
          body = requireJsonRecord(transformed, "Codex payload replacement");
        }
      }
      if (runtimeSessionId) {
        this.templates.set(runtimeSessionId, {
          modelId: model.id,
          payload: replacementValues ? {} : withoutConversationInput(body),
          grammarToolInputProperties,
          requestOptions: { ...requestOptions },
        });
      }
      if (!replacementValues) {
        body = await this.maybeCompactPercentage(
          model,
          context,
          requestOptions,
          body,
          grammarToolInputProperties,
          agentTurn,
          responsesLiteEnabled,
        );
      }
      const ordinaryBody = body;
      const staticBody = applyResponsesLite(
        updateInput(ordinaryBody, []),
        model.id,
        responsesLiteEnabled,
      );
      let requestBody: JsonRecord | JsonValue[];
      if (replacementValues) {
        applyResponsesLite({}, model.id, responsesLiteEnabled);
        requestBody = replacementValues;
      } else {
        body = applyResponsesLite(ordinaryBody, model.id, responsesLiteEnabled);
        requestBody = body;
      }
      const cacheDiagnostics = codexCacheDiagnosticContext(
        ordinaryBody,
        Array.isArray(requestBody) ? {} : requestBody,
        staticBody,
        model.id,
        responsesLiteEnabled,
      );

      const rawItems: ResponsesOutputItem[] = [];
      const nativeAttempts: NativeResponseAttempt[] = [];
      const prewarmDiagnostics: CodexTransportDiagnostic[] = [];
      await this.maybePrewarm({
        model,
        body: staticBody,
        fullBody: Array.isArray(requestBody) ? {} : requestBody,
        requestOptions,
        accountId,
        diagnostics: prewarmDiagnostics,
        turnState: agentTurn.turnState,
        cacheDiagnostics,
      });
      if (prewarmDiagnostics.length > 0) output.diagnostics = prewarmDiagnostics;
      let continuationHandle: CodexContinuationHandle | undefined;
      let webSocketResponseHandle: CodexWebSocketResponseHandle | undefined;
      let startEmitted = false;
      const emitStart = () => {
        if (startEmitted) return;
        startEmitted = true;
        stream.push({ type: "start", partial: output });
      };
      const transportRequestOptions = {
        ...requestOptions,
        accountId,
        requestKind: "turn" as const,
        turnState: agentTurn.turnState,
        cacheDiagnostics,
        onContinuationReady(handle: CodexContinuationHandle) {
          continuationHandle = handle;
        },
        onWebSocketResponseHandle(handle: CodexWebSocketResponseHandle) {
          webSocketResponseHandle = handle;
        },
        onTransportStart: emitStart,
        onTransportDiagnostic(diagnostic: CodexTransportDiagnostic) {
          output.diagnostics = [...(output.diagnostics ?? []), diagnostic];
        },
      };
      let responseRequests = 0;
      let responseRetries = carriedResponseRetries;
      while (true) {
        responseRequests += 1;
        const attemptCapture: CodexAttemptCapture = {
          streamedItems: [],
          streamedToolCallIndexes: new Set(),
          streamedCompletedToolCallIndexes: new Set(),
        };
        const terminalCapture: CodexTerminalCapture = {};
        const attemptState: CodexStreamAttemptState = {
          startedContentIndexes: new Set(),
          completedContentIndexes: new Set(),
        };
        const usageBeforeAttempt = structuredClone(output.usage);
        output.usage = emptyUsage();
        let connectionLimitError: Error | undefined;
        try {
          await processCodexStream(
            startOnFirstEvent(
              captureRawEvents(
                this.transport.request(model, requestBody, transportRequestOptions),
                attemptCapture,
                terminalCapture,
              ),
              emitStart,
            ),
            output,
            stream,
            model,
            grammarToolInputProperties,
            {
              attemptState,
              applyServiceTierPricing(usage, responseServiceTier) {
                applyServiceTierPricing(
                  usage,
                  model,
                  Array.isArray(requestBody) ? undefined : requestBody.service_tier,
                  responseServiceTier,
                );
              },
            },
          );
        } catch (error) {
          output.usage = usageBeforeAttempt;
          if (isWebSocketConnectionLimitReachedError(error)) {
            connectionLimitError = error;
          } else {
            if (!requestOptions.signal?.aborted) {
              webSocketResponseHandle?.failParsing(error);
            }
            throw error;
          }
        }
        if (!connectionLimitError) {
          output.usage = accumulateUsage(usageBeforeAttempt, output.usage);
        }
        // `response.output_item.done` is Codex's item-level commit point. Terminal
        // response.output snapshots are deliberately ignored.
        const attemptItems = attemptCapture.streamedItems;
        const terminalState: CodexTerminalState | undefined = terminalCapture.current;
        if (terminalState) {
          const reason = terminalReason(terminalState);
          const nativeAttempt: NativeResponseAttempt = {
            itemCount: attemptItems.length,
            terminalType: terminalState.type,
          };
          if (reason) nativeAttempt.terminalReason = reason;
          nativeAttempts.push(nativeAttempt);
        }
        const toolCalls = assessAttemptToolCalls(attemptItems, attemptCapture);
        const incompleteDetails = isObject(terminalState?.response?.["incomplete_details"])
          ? terminalState.response["incomplete_details"]
          : undefined;
        const incompleteReason = isString(incompleteDetails?.["reason"])
          ? incompleteDetails["reason"]
          : undefined;
        const recordDecision = (
          decision: CodexResponseDecision,
          postToolDisposition?: "continue" | "error" | "retry",
        ): void => {
          const diagnosticOptions: Parameters<typeof responseDecisionDiagnostic>[0] = {
            attempt: responseRequests,
            attemptItems,
            capture: attemptCapture,
            decision,
            terminalState,
            toolCalls,
          };
          if (connectionLimitError) {
            diagnosticOptions.failureReason = WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
          }
          if (incompleteReason) diagnosticOptions.incompleteReason = incompleteReason;
          if (postToolDisposition) {
            diagnosticOptions.postToolDisposition = postToolDisposition;
          }
          const diagnostic = responseDecisionDiagnostic(diagnosticOptions);
          if (diagnostic) output.diagnostics = [...(output.diagnostics ?? []), diagnostic];
        };

        // Return each done tool call before processing an unsuccessful response
        // terminal. Pi will execute the completed subset; started-only siblings
        // are discarded and never enter provider history.
        if (toolCalls.completedCount > 0) {
          const callIds = completedAttemptToolCallIds(output, attemptState);
          if (callIds.length !== toolCalls.completedCount) {
            throw new Error("Codex completed tool-call items could not be mapped to Pi calls.");
          }
          let postToolDisposition: "continue" | "error" | "retry" = "continue";
          if (connectionLimitError) {
            postToolDisposition = "retry";
            registeredPostToolDisposition = {
              callIds,
              errorMessage: connectionLimitError.message,
              retryAttempt: responseRetries + 1,
              terminalType: WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
              turnId: agentTurn.turnId,
              type: "retry",
            };
          } else if (
            terminalState?.type === "response.incomplete" ||
            terminalState?.type === "response.failed"
          ) {
            const retryable =
              terminalState.type === "response.incomplete" ||
              retryableResponseFailure(terminalState.response);
            postToolDisposition = retryable ? "retry" : "error";
            registeredPostToolDisposition = {
              callIds,
              retryAttempt: retryable ? responseRetries + 1 : responseRetries,
              terminalType: terminalState.type,
              turnId: agentTurn.turnId,
              type: postToolDisposition,
            };
            if (terminalState.response) {
              registeredPostToolDisposition.response = structuredClone(terminalState.response);
            }
          }
          if (registeredPostToolDisposition) {
            if (runtimeSessionId) {
              registeredPostToolDisposition.sessionId = runtimeSessionId;
            }
            this.rememberPostToolDisposition(registeredPostToolDisposition);
          }
          discardIncompleteAttemptContent(output, attemptState);
          rawItems.push(...attemptItems.map((item) => structuredClone(item)));
          output.stopReason = "toolUse";
          delete output.errorMessage;
          recordDecision("return_tool_use", postToolDisposition);
          break;
        }

        const nextBody = Array.isArray(requestBody)
          ? undefined
          : continueResponseBody(requestBody, attemptItems);
        rawItems.push(...attemptItems.map((item) => structuredClone(item)));
        discardIncompleteAttemptContent(output, attemptState);
        const retryableTerminal =
          terminalState?.type === "response.incomplete" ||
          (terminalState?.type === "response.failed" &&
            retryableResponseFailure(terminalState.response));
        if (
          (connectionLimitError || retryableTerminal) &&
          nextBody &&
          responseRetries < this.responseRetryPolicy.maxRetries
        ) {
          responseRetries += 1;
          body = nextBody;
          requestBody = nextBody;
          output.stopReason = "pending";
          delete output.errorMessage;
          delete output.rawStopReason;
          delete output.responseId;
          recordDecision(attemptItems.length === 0 ? "retry_original_input" : "continue_no_tools");
          await waitForResponseRetry(
            responseRetryDelayMs(this.responseRetryPolicy.baseDelayMs, responseRetries),
            requestOptions.signal,
          );
          continue;
        }
        if (connectionLimitError) {
          recordDecision("return_terminal");
          throw connectionLimitError;
        }

        if (
          terminalState?.type === "response.completed" &&
          terminalState.response["end_turn"] === false
        ) {
          const scope = runtimeSessionId ? this.scopes.get(runtimeSessionId) : undefined;
          if (reachedProviderCompactionThreshold(scope, output.usage, model)) {
            // Pi 0.84 has no provider event that can split one stream into two
            // assistant messages. Return the committed prefix as a recoverable
            // length boundary so Pi persists B1, runs native overflow compaction,
            // and continues from K without adding model-visible input.
            output.stopReason = "length";
            output.rawStopReason = PROVIDER_COMPACTION_BOUNDARY_STOP_REASON;
            delete output.errorMessage;
            recordDecision("return_compaction_boundary");
            break;
          }
          if (!nextBody) {
            throw new Error(
              "Codex requested a follow-up response, but its completed output could not be appended to request history.",
            );
          }
          responseRetries = 0;
          body = nextBody;
          requestBody = nextBody;
          output.stopReason = "pending";
          delete output.errorMessage;
          delete output.rawStopReason;
          recordDecision("continue_no_tools");
          continue;
        }
        recordDecision("return_terminal");
        break;
      }
      if (requestOptions.signal?.aborted) throw new Error("Request was aborted");

      const compat = responsesCompatibility(model.compat);
      const canonicalContext: Context = {
        messages: [output],
      };
      if (context.tools) canonicalContext.tools = context.tools;
      const canonicalItems = convertResponsesMessages(
        model,
        canonicalContext,
        CODEX_TOOL_CALL_PROVIDERS,
        {
          includeSystemPrompt: false,
          grammarToolInputProperties,
          deferredTools: splitDeferredTools(context, Boolean(compat?.supportsToolSearch)).deferred,
          toolOptions: {
            strict: false,
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
        rawItems.length > 0 &&
        (responseRequests > 1 || nativeOverrideRequired(rawItems, canonicalItems));
      if (persistNativeItems) {
        if (!output.responseId) throw new Error("Codex response is missing a response id.");
        this.pi.appendEntry(
          NATIVE_RESPONSE_ENTRY_TYPE,
          nativeResponseData(model.id, output.responseId, rawItems, nativeAttempts),
        );
      }
      try {
        assertSuccessfulOutput(output);
      } catch (error) {
        webSocketResponseHandle?.discard();
        throw error;
      }
      const readyContinuation = continuationHandle;
      if (
        responseRequests === 1 &&
        readyContinuation &&
        readyContinuation.responseId === output.responseId
      ) {
        readyContinuation.replaceResponseItems(persistNativeItems ? rawItems : canonicalItems);
      }
      return output.stopReason;
    })();
    streamingTask.then(
      (stopReason) => {
        try {
          stream.push({ type: "done", reason: stopReason, message: output });
          stream.end();
        } finally {
          releaseRequest();
        }
      },
      (error: unknown) => {
        try {
          if (registeredPostToolDisposition) {
            this.forgetPostToolDisposition(registeredPostToolDisposition);
          }
          const providerError = errorFromThrown(
            error,
            "The Codex provider failed with a non-Error value.",
          );
          clearStreamingScratchState(output);
          output.stopReason = requestOptions.signal?.aborted ? "aborted" : "error";
          output.errorMessage = providerError.message;
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        } finally {
          releaseRequest();
        }
      },
    );
    return stream;
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const effort = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const streamOptions: OpenAICodexResponsesOptions = { ...options };
    if (effort && effort !== "off") streamOptions.reasoningEffort = effort;
    return this.stream(model, context, streamOptions);
  }

  latestTemplate(sessionId: string): RequestTemplate | undefined {
    return this.templates.get(sessionId);
  }

  async compact(options: {
    model: Model<Api>;
    requestOptions: OpenAICodexResponsesOptions;
    history: ResponsesInputItem[];
    instructions: string;
    grammarToolInputProperties: GrammarToolInputProperties;
    template: JsonRecord;
    priority: boolean;
    compactionMetadata: CodexCompactionMetadata;
    compactionDecision: CompactionDecision;
  }): Promise<CodexCompactionResult> {
    validateCodexAuthentication(options.model, options.requestOptions.apiKey);
    const release = await this.acquireRequest(
      options.requestOptions.sessionId,
      options.requestOptions.signal,
    );
    try {
      const compacted = await this.performCompaction(options);
      const sessionId = options.requestOptions.sessionId;
      if (sessionId) this.advanceWindow(sessionId);
      return compacted;
    } finally {
      release();
    }
  }
}
