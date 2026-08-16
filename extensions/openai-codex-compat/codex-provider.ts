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
  type AssistantMessageDiagnostic,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import {
  codexCacheDiagnosticContext,
  type CodexCacheDiagnosticContext,
} from "./codex-cache-diagnostics.ts";
import {
  checkpointData,
  providerHistory,
  searchCheckpoint,
  type CheckpointData,
  type CompactionDecision,
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
import { resolveCodexInstallationId } from "./codex-installation.ts";
import {
  type CodexCompactionMetadata,
  type CodexMetadataIdentity,
  responsesCompactionV2Metadata,
  withCodexRequestMetadata,
} from "./codex-metadata.ts";
import { resolveCodexThreadIdentity, type CodexThreadIdentity } from "./codex-thread-lineage.ts";
import { applyResponsesLite } from "./responses-lite.ts";
import { processCodexStream, type CodexStreamAttemptState } from "./codex-stream.ts";
import {
  CodexTransport,
  CodexTurnState,
  validateCodexAuthentication,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
  type CodexWebSocketResponseHandle,
} from "./codex-transport.ts";
import { DEFAULT_CONFIG, type CodexCompatConfig, type ImageDetail } from "./config.ts";
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

type ActiveAgentTurn = {
  turnId: string;
  startedAtUnixMs: number;
  turnState: CodexTurnState;
};

type CodexCompat = {
  supportsToolSearch?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
};

type CodexTerminalState = {
  type?: "response.completed" | "response.incomplete" | "response.failed";
  response?: JsonRecord;
};

type CodexAttemptCapture = {
  streamedItems: ResponsesItem[];
  streamedToolCallKeys: Set<string>;
  streamedCompletedToolCallKeys: Set<string>;
  terminalItems?: ResponsesItem[];
};

type CodexToolCallAssessment = {
  allComplete: boolean;
  authoritativeCount: number;
  hasToolCalls: boolean;
  omittedStreamedCount: number;
  terminalCount: number;
};

type CodexResponseDecision =
  | "continue_no_tools"
  | "preserve_terminal_error"
  | "reject_terminal_stream_mismatch"
  | "retry_original_input"
  | "return_length_incomplete_call"
  | "return_terminal"
  | "return_tool_use";

export type CodexResponseRetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
};

const DEFAULT_RESPONSE_RETRY_POLICY: CodexResponseRetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 200,
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

function isToolCallItem(item: ResponsesItem): boolean {
  return item.type === "function_call" || item.type === "custom_tool_call";
}

function toolCallKey(item: ResponsesItem): string {
  const callId = typeof item["call_id"] === "string" ? item["call_id"] : undefined;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  return `${String(item.type)}:${itemId ? `item:${itemId}` : `call:${callId ?? "missing"}`}`;
}

function hasValidToolCallPayload(item: ResponsesItem): boolean {
  if (
    typeof item.id !== "string" ||
    typeof item["call_id"] !== "string" ||
    typeof item.name !== "string"
  ) {
    return false;
  }
  if (item.type === "custom_tool_call") return typeof item.input === "string";
  if (item.type !== "function_call" || typeof item.arguments !== "string") return false;
  try {
    return isObject(JSON.parse(item.arguments));
  } catch {
    return false;
  }
}

function toolCallIsComplete(
  item: ResponsesItem,
  capture: CodexAttemptCapture,
  terminalType: CodexTerminalState["type"],
): boolean {
  if (!hasValidToolCallPayload(item)) return false;
  const status = typeof item["status"] === "string" ? item["status"] : undefined;
  if (status !== undefined) return status === "completed";
  if (capture.streamedCompletedToolCallKeys.has(toolCallKey(item))) return true;
  return terminalType === "response.completed";
}

function assessAttemptToolCalls(
  items: readonly ResponsesItem[],
  capture: CodexAttemptCapture,
  terminalType: CodexTerminalState["type"],
): CodexToolCallAssessment {
  const calls = items.filter(isToolCallItem);
  const authoritativeKeys = new Set(calls.map(toolCallKey));
  const omittedStreamedCount = [...capture.streamedToolCallKeys].filter(
    (key) => !authoritativeKeys.has(key),
  ).length;
  const hasToolCalls = calls.length > 0 || capture.streamedToolCallKeys.size > 0;
  return {
    hasToolCalls,
    allComplete:
      hasToolCalls &&
      omittedStreamedCount === 0 &&
      calls.length > 0 &&
      calls.every((item) => toolCallIsComplete(item, capture, terminalType)),
    authoritativeCount: calls.length,
    omittedStreamedCount,
    terminalCount: capture.terminalItems?.filter(isToolCallItem).length ?? 0,
  };
}

function outputItemTypeCounts(items: readonly ResponsesItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const type = item.type ?? "message";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function responseDecisionDiagnostic(options: {
  attempt: number;
  attemptItems: readonly ResponsesItem[];
  capture: CodexAttemptCapture;
  decision: CodexResponseDecision;
  incompleteReason?: string;
  terminalState: CodexTerminalState;
  toolCalls: CodexToolCallAssessment;
}): AssistantMessageDiagnostic | undefined {
  const endTurn =
    typeof options.terminalState.response?.["end_turn"] === "boolean"
      ? options.terminalState.response["end_turn"]
      : undefined;
  const nontrivial =
    options.attempt > 1 ||
    options.terminalState.type !== "response.completed" ||
    endTurn === false ||
    options.toolCalls.hasToolCalls ||
    options.toolCalls.omittedStreamedCount > 0;
  if (!nontrivial) return undefined;

  return {
    type: "codex_response_decision",
    timestamp: Date.now(),
    details: {
      attempt: options.attempt,
      terminalType: options.terminalState.type ?? "missing",
      ...(options.incompleteReason ? { incompleteReason: options.incompleteReason } : {}),
      ...(endTurn === undefined ? {} : { endTurn }),
      itemSource: options.capture.terminalItems ? "terminal" : "stream-fallback",
      outputItemTypes: outputItemTypeCounts(options.attemptItems),
      streamedCallsStarted: options.capture.streamedToolCallKeys.size,
      streamedCallsCompleted: options.capture.streamedCompletedToolCallKeys.size,
      terminalCalls: options.toolCalls.terminalCount,
      authoritativeCalls: options.toolCalls.authoritativeCount,
      terminalOmittedStreamedCalls: options.toolCalls.omittedStreamedCount,
      allCallsComplete: options.toolCalls.allComplete,
      decision: options.decision,
    },
  };
}

function captureRawEvents(
  events: AsyncIterable<JsonRecord>,
  capture: CodexAttemptCapture,
  terminalState?: CodexTerminalState,
): AsyncIterable<JsonRecord> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (
          event.type === "response.output_item.added" &&
          isResponsesItem(event.item) &&
          isToolCallItem(event.item)
        ) {
          capture.streamedToolCallKeys.add(toolCallKey(event.item));
        }
        if (event.type === "response.output_item.done" && isResponsesItem(event.item)) {
          const item = structuredClone(event.item);
          capture.streamedItems.push(item);
          if (isToolCallItem(item)) {
            const key = toolCallKey(item);
            capture.streamedToolCallKeys.add(key);
            capture.streamedCompletedToolCallKeys.add(key);
          }
        }
        if (
          (event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed") &&
          isObject(event.response) &&
          Array.isArray(event.response["output"])
        ) {
          const terminalItems = event.response["output"]
            .filter(isResponsesItem)
            .map((item) => structuredClone(item));
          // Codex completed terminals can carry `output: []` after emitting the
          // complete items through `response.output_item.done`. Treat that as an
          // omitted snapshot, but keep empty failed/incomplete output authoritative
          // so streamed calls from unsuccessful responses still fail closed.
          if (terminalItems.length > 0 || event.type !== "response.completed") {
            capture.terminalItems = terminalItems;
          }
        }
        if (
          terminalState &&
          (event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed")
        ) {
          terminalState.type = event.type;
          if (isObject(event.response)) {
            terminalState.response = structuredClone(event.response);
          } else {
            delete terminalState.response;
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

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function discardIncompleteAttemptContent(
  message: AssistantMessage,
  attempt: CodexStreamAttemptState,
): void {
  const incomplete = [...attempt.startedContentIndexes]
    .filter((index) => !attempt.completedContentIndexes.has(index))
    .sort((left, right) => right - left);
  for (const index of incomplete) message.content.splice(index, 1);
}

function accumulateUsage(previous: Usage, current: Usage): Usage {
  const previousReasoning = previous.reasoning;
  const currentReasoning = current.reasoning;
  return {
    input: previous.input + current.input,
    output: previous.output + current.output,
    cacheRead: previous.cacheRead + current.cacheRead,
    cacheWrite: previous.cacheWrite + current.cacheWrite,
    ...(previousReasoning === undefined && currentReasoning === undefined
      ? {}
      : { reasoning: (previousReasoning ?? 0) + (currentReasoning ?? 0) }),
    totalTokens: previous.totalTokens + current.totalTokens,
    cost: {
      input: previous.cost.input + current.cost.input,
      output: previous.cost.output + current.cost.output,
      cacheRead: previous.cost.cacheRead + current.cost.cacheRead,
      cacheWrite: previous.cost.cacheWrite + current.cost.cacheWrite,
      total: previous.cost.total + current.cost.total,
    },
  };
}

function retryableResponseFailure(response: JsonRecord | undefined): boolean {
  const error = isObject(response?.["error"]) ? response["error"] : undefined;
  const code = typeof error?.["code"] === "string" ? error["code"].toLowerCase() : "";
  return !(
    code === "context_length_exceeded" ||
    code === "insufficient_quota" ||
    code === "usage_not_included" ||
    code === "cyber_policy" ||
    code === "invalid_prompt" ||
    code === "bio_policy"
  );
}

function responseRetryDelayMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) return 0;
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.floor(exponential * (0.9 + Math.random() * 0.2));
}

function waitForResponseRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Request was aborted"));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function continueResponseBody(
  body: JsonRecord,
  responseItems: readonly ResponsesItem[],
): JsonRecord | undefined {
  if (!Array.isArray(body.input) || !body.input.every(isResponsesItem)) return undefined;
  return updateInput(body, [...body.input, ...responseItems]);
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

function assertSuccessfulOutput(
  message: AssistantMessage,
): asserts message is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
  if (message.stopReason === "pending") {
    throw new Error("Codex stream ended without a stop reason");
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "An unknown error occurred");
  }
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
  private readonly prewarmedTemplates = new Set<string>();
  private readonly requestTails = new Map<string, Promise<void>>();
  private readonly activeAgentTurns = new Map<string, ActiveAgentTurn>();
  private readonly windowNumbers = new Map<string, number>();
  private readonly activeThreadIds = new Map<string, string>();
  private readonly pi: ExtensionAPI;
  private readonly resolveConfig: ConfigResolver;
  private readonly installationId: string;
  private readonly responseRetryPolicy: CodexResponseRetryPolicy;

  constructor(
    pi: ExtensionAPI,
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

  beginAgentTurn(ctx: ExtensionContext): void {
    this.activeAgentTurns.set(ctx.sessionManager.getSessionId(), {
      turnId: uuidv7(),
      startedAtUnixMs: Date.now(),
      turnState: new CodexTurnState(),
    });
  }

  endAgentTurn(ctx: ExtensionContext): void {
    this.activeAgentTurns.delete(ctx.sessionManager.getSessionId());
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
    return {
      installationId: this.installationId,
      ...(thread.threadId ? { threadId: thread.threadId } : {}),
      ...(thread.forkedFromThreadId ? { forkedFromThreadId: thread.forkedFromThreadId } : {}),
      windowNumber: windowKey ? (this.windowNumbers.get(windowKey) ?? 0) : 0,
      ...(turn ? { turnStartedAtUnixMs: turn.startedAtUnixMs } : {}),
      threadSource: "user",
      // Pi extensions execute without Codex's platform sandbox.
      sandbox: "none",
    };
  }

  private threadIdentity(sessionId: string): CodexThreadIdentity {
    const branch = this.scopes.get(sessionId)?.manager.getBranch() as SessionEntry[] | undefined;
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
    for (const key of this.windowNumbers.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.windowNumbers.delete(key);
    }
    this.activeThreadIds.delete(sessionId);
    this.transport.close(sessionId);
  }

  private async maybePrewarm(options: {
    model: Model<any>;
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
    const prewarmBody = withCodexRequestMetadata(
      options.body,
      cacheSessionId,
      { kind: "prewarm" },
      "",
      this.metadataIdentity(cacheSessionId, undefined, sessionId),
    );
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
          strict: false,
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
    turnId: string,
  ): JsonRecord {
    const compat = model.compat as CodexCompat | undefined;
    const toolPlacement = splitDeferredTools(context, Boolean(compat?.supportsToolSearch));
    let body: JsonRecord = {
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
      tools: [],
    };
    body = withCodexRequestMetadata(
      body,
      cacheSessionId,
      { kind: "turn" },
      turnId,
      this.metadataIdentity(
        cacheSessionId,
        this.activeAgentTurns.get(runtimeSessionId ?? ""),
        runtimeSessionId,
      ),
    );
    if (options.serviceTier !== undefined) body.service_tier = options.serviceTier;
    if (toolPlacement.immediate.length > 0) {
      body.tools = convertResponsesTools(toolPlacement.immediate, {
        strict: false,
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
    compactionMetadata: CodexCompactionMetadata;
    compactionDecision: CompactionDecision;
    agentTurn?: ActiveAgentTurn;
    responsesLiteEnabled?: boolean;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
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
      options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
      { kind: "compaction", compaction: options.compactionMetadata },
      agentTurn.turnId,
      this.metadataIdentity(
        options.requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(sessionId),
        agentTurn,
        sessionId,
      ),
    );
    const transformed = await options.requestOptions.onPayload?.(payload, options.model);
    const ordinaryRequest = transformed === undefined ? payload : (transformed as JsonRecord);
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
    return {
      checkpoint: checkpointData(
        options.model.id,
        options.history,
        compacted.item,
        options.postCompactionTail,
        options.compactionDecision,
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
      compactionMetadata: responsesCompactionV2Metadata("auto", "context_limit", "pre_turn"),
      compactionDecision: { reason: "provider-boundary", willRetry: true },
      agentTurn,
      responsesLiteEnabled,
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
    this.advanceWindow(sessionId);
    const cacheSessionId = options.cacheRetention === "none" ? undefined : codexCacheKey(sessionId);
    return withCodexRequestMetadata(
      updateInput(body, compacted.checkpoint.history),
      cacheSessionId,
      { kind: "turn" },
      agentTurn.turnId,
      this.metadataIdentity(cacheSessionId, agentTurn, sessionId),
    );
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
        usage: emptyUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
      const runtimeSessionId = requestOptions.sessionId;
      let releaseRequest = () => {};
      try {
        const accountId = validateCodexAuthentication(model, requestOptions.apiKey);
        releaseRequest = await this.acquireRequest(runtimeSessionId, requestOptions.signal);
        this.activateThread(runtimeSessionId);
        const cacheSessionId =
          requestOptions.cacheRetention === "none" ? undefined : codexCacheKey(runtimeSessionId);
        const agentTurn = this.agentTurn(runtimeSessionId);
        const responsesLiteEnabled = this.responsesLiteEnabled(runtimeSessionId);
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
          agentTurn.turnId,
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
          agentTurn,
          responsesLiteEnabled,
        );
        const ordinaryBody = body;
        const staticBody = applyResponsesLite(
          updateInput(ordinaryBody, []),
          model.id,
          responsesLiteEnabled,
        );
        body = applyResponsesLite(ordinaryBody, model.id, responsesLiteEnabled);
        const cacheDiagnostics = codexCacheDiagnosticContext(
          ordinaryBody,
          body,
          staticBody,
          model.id,
          responsesLiteEnabled,
        );

        const rawItems: ResponsesItem[] = [];
        const prewarmDiagnostics: CodexTransportDiagnostic[] = [];
        await this.maybePrewarm({
          model,
          body: staticBody,
          fullBody: body,
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
        let responseRetries = 0;
        while (true) {
          responseRequests += 1;
          const attemptCapture: CodexAttemptCapture = {
            streamedItems: [],
            streamedToolCallKeys: new Set(),
            streamedCompletedToolCallKeys: new Set(),
          };
          const terminalState: CodexTerminalState = {};
          const attemptState: CodexStreamAttemptState = {
            startedContentIndexes: new Set(),
            completedContentIndexes: new Set(),
          };
          const contentLengthBeforeAttempt = output.content.length;
          const usageBeforeAttempt = structuredClone(output.usage);
          output.usage = emptyUsage();
          try {
            await processCodexStream(
              startOnFirstEvent(
                captureRawEvents(
                  this.transport.request(model, body, transportRequestOptions),
                  attemptCapture,
                  terminalState,
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
                  applyServiceTierPricing(usage, model, body.service_tier, responseServiceTier);
                },
              },
            );
          } catch (error) {
            output.usage = usageBeforeAttempt;
            if (!requestOptions.signal?.aborted) {
              webSocketResponseHandle?.failParsing(error);
            }
            throw error;
          }
          output.usage = accumulateUsage(usageBeforeAttempt, output.usage);
          // A terminal response.output is the complete provider snapshot when present.
          // Stream-completed items are the fallback for transports that omit that field.
          const attemptItems = attemptCapture.terminalItems ?? attemptCapture.streamedItems;
          const toolCalls = assessAttemptToolCalls(
            attemptItems,
            attemptCapture,
            terminalState.type,
          );
          const incompleteDetails = isObject(terminalState.response?.["incomplete_details"])
            ? terminalState.response["incomplete_details"]
            : undefined;
          const incompleteReason =
            typeof incompleteDetails?.["reason"] === "string"
              ? incompleteDetails["reason"]
              : undefined;
          const maxOutputIncomplete =
            terminalState.type === "response.incomplete" &&
            incompleteReason === "max_output_tokens";
          const recordDecision = (decision: CodexResponseDecision): void => {
            const diagnostic = responseDecisionDiagnostic({
              attempt: responseRequests,
              attemptItems,
              capture: attemptCapture,
              decision,
              ...(incompleteReason ? { incompleteReason } : {}),
              terminalState,
              toolCalls,
            });
            if (diagnostic) output.diagnostics = [...(output.diagnostics ?? []), diagnostic];
          };

          // Tool calls create a client-execution boundary. Never append them to an
          // internal provider continuation before Pi can return the linked outputs.
          if (toolCalls.hasToolCalls) {
            if (
              toolCalls.allComplete &&
              ((terminalState.type === "response.completed" && output.stopReason === "toolUse") ||
                maxOutputIncomplete)
            ) {
              discardIncompleteAttemptContent(output, attemptState);
              rawItems.push(...attemptItems.map((item) => structuredClone(item)));
              output.stopReason = "toolUse";
              delete output.errorMessage;
              recordDecision("return_tool_use");
              break;
            }

            output.content.splice(contentLengthBeforeAttempt);
            if (
              terminalState.type === "response.failed" &&
              retryableResponseFailure(terminalState.response) &&
              responseRetries < this.responseRetryPolicy.maxRetries
            ) {
              responseRetries += 1;
              output.stopReason = "pending";
              delete output.errorMessage;
              delete output.rawStopReason;
              recordDecision("retry_original_input");
              await waitForResponseRetry(
                responseRetryDelayMs(this.responseRetryPolicy.baseDelayMs, responseRetries),
                requestOptions.signal,
              );
              continue;
            }
            if (terminalState.type === "response.completed" && output.stopReason !== "error") {
              output.stopReason = "length";
              output.rawStopReason = "incomplete.tool_call";
              delete output.errorMessage;
            }
            recordDecision(
              toolCalls.omittedStreamedCount > 0
                ? "reject_terminal_stream_mismatch"
                : output.stopReason === "length"
                  ? "return_length_incomplete_call"
                  : "preserve_terminal_error",
            );
            break;
          }

          const nextBody = continueResponseBody(body, attemptItems);
          rawItems.push(...attemptItems.map((item) => structuredClone(item)));
          discardIncompleteAttemptContent(output, attemptState);
          const retryableTerminal =
            terminalState.type === "response.incomplete" ||
            (terminalState.type === "response.failed" &&
              retryableResponseFailure(terminalState.response));
          if (
            retryableTerminal &&
            nextBody &&
            responseRetries < this.responseRetryPolicy.maxRetries
          ) {
            responseRetries += 1;
            body = nextBody;
            output.stopReason = "pending";
            delete output.errorMessage;
            delete output.rawStopReason;
            recordDecision("continue_no_tools");
            await waitForResponseRetry(
              responseRetryDelayMs(this.responseRetryPolicy.baseDelayMs, responseRetries),
              requestOptions.signal,
            );
            continue;
          }

          if (
            terminalState.type === "response.completed" &&
            terminalState.response?.["end_turn"] === false
          ) {
            if (!nextBody) {
              throw new Error(
                "Codex requested a follow-up response, but its completed output could not be appended to request history.",
              );
            }
            responseRetries = 0;
            body = nextBody;
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
            nativeResponseData(model.id, output.responseId, rawItems),
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
    compactionMetadata: CodexCompactionMetadata;
    compactionDecision: CompactionDecision;
  }): Promise<{ checkpoint: CheckpointData; usage?: Usage }> {
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
