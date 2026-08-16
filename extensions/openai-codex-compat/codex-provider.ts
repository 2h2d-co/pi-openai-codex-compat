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
  streamedToolCallIndexes: Set<number>;
  streamedCompletedToolCallIndexes: Set<number>;
};

type CodexToolCallAssessment = {
  completedCount: number;
  discardedPartialCount: number;
  hasCompletedCalls: boolean;
};

type CodexPostToolDisposition = {
  callIds: string[];
  response?: JsonRecord;
  retryAttempt: number;
  sessionId?: string;
  terminalType: "response.incomplete" | "response.failed";
  turnId: string;
  type: "error" | "retry";
};

type CodexResponseDecision =
  | "continue_no_tools"
  | "retry_original_input"
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

function eventOutputIndex(event: JsonRecord): number {
  return typeof event["output_index"] === "number" ? event["output_index"] : 0;
}

function assessAttemptToolCalls(
  items: readonly ResponsesItem[],
  capture: CodexAttemptCapture,
): CodexToolCallAssessment {
  const completedCount = items.filter(isToolCallItem).length;
  const discardedPartialCount = [...capture.streamedToolCallIndexes].filter(
    (index) => !capture.streamedCompletedToolCallIndexes.has(index),
  ).length;
  return {
    completedCount,
    discardedPartialCount,
    hasCompletedCalls: completedCount > 0,
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
  postToolDisposition?: "continue" | "error" | "retry";
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
    options.capture.streamedToolCallIndexes.size > 0;
  if (!nontrivial) return undefined;

  return {
    type: "codex_response_decision",
    timestamp: Date.now(),
    details: {
      attempt: options.attempt,
      terminalType: options.terminalState.type ?? "missing",
      ...(options.incompleteReason ? { incompleteReason: options.incompleteReason } : {}),
      ...(endTurn === undefined ? {} : { endTurn }),
      outputItemTypes: outputItemTypeCounts(options.attemptItems),
      streamedCallsStarted: options.capture.streamedToolCallIndexes.size,
      streamedCallsDone: options.capture.streamedCompletedToolCallIndexes.size,
      returnedCalls: options.toolCalls.completedCount,
      discardedPartialCalls: options.toolCalls.discardedPartialCount,
      ...(options.postToolDisposition ? { postToolDisposition: options.postToolDisposition } : {}),
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
          capture.streamedToolCallIndexes.add(eventOutputIndex(event));
        }
        if (event.type === "response.output_item.done" && isResponsesItem(event.item)) {
          const item = structuredClone(event.item);
          capture.streamedItems.push(item);
          if (isToolCallItem(item)) {
            const index = eventOutputIndex(event);
            capture.streamedToolCallIndexes.add(index);
            capture.streamedCompletedToolCallIndexes.add(index);
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

function terminalErrorMessage(disposition: CodexPostToolDisposition): string {
  if (disposition.terminalType === "response.failed") {
    const error = isObject(disposition.response?.["error"])
      ? disposition.response["error"]
      : undefined;
    return typeof error?.["message"] === "string" ? error["message"] : "Codex response failed";
  }
  const details = isObject(disposition.response?.["incomplete_details"])
    ? disposition.response["incomplete_details"]
    : undefined;
  const reason = typeof details?.["reason"] === "string" ? details["reason"] : undefined;
  return reason
    ? `Response incomplete: ${reason}`
    : "Response incomplete without a provider reason";
}

function completedAttemptToolCallIds(
  message: AssistantMessage,
  attempt: CodexStreamAttemptState,
): string[] {
  return [...attempt.completedContentIndexes]
    .sort((left, right) => left - right)
    .flatMap((index) => {
      const block = message.content[index];
      return block?.type === "toolCall" ? [block.id] : [];
    });
}

function assertLinkedToolOutputs(context: Context, disposition: CodexPostToolDisposition): void {
  const outputIds = new Set(
    context.messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    ),
  );
  const missing = disposition.callIds.filter((callId) => !outputIds.has(callId));
  if (missing.length > 0) {
    throw new Error(
      `Codex cannot process the ${disposition.terminalType} response until Pi records tool output for: ${missing.join(", ")}`,
    );
  }
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
  private readonly postToolDispositions = new Map<string, CodexPostToolDisposition>();
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
    const sessionId = ctx.sessionManager.getSessionId();
    this.clearPostToolDispositions((disposition) => disposition.sessionId === sessionId);
    this.activeAgentTurns.set(sessionId, {
      turnId: uuidv7(),
      startedAtUnixMs: Date.now(),
      turnState: new CodexTurnState(),
    });
  }

  endAgentTurn(ctx: ExtensionContext): void {
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
    this.clearPostToolDispositions((disposition) => disposition.sessionId === sessionId);
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
      let registeredPostToolDisposition: CodexPostToolDisposition | undefined;
      try {
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
        let responseRetries = carriedResponseRetries;
        while (true) {
          responseRequests += 1;
          const attemptCapture: CodexAttemptCapture = {
            streamedItems: [],
            streamedToolCallIndexes: new Set(),
            streamedCompletedToolCallIndexes: new Set(),
          };
          const terminalState: CodexTerminalState = {};
          const attemptState: CodexStreamAttemptState = {
            startedContentIndexes: new Set(),
            completedContentIndexes: new Set(),
          };
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
          // `response.output_item.done` is Codex's item-level commit point. Terminal
          // response.output snapshots are deliberately ignored.
          const attemptItems = attemptCapture.streamedItems;
          const toolCalls = assessAttemptToolCalls(attemptItems, attemptCapture);
          const incompleteDetails = isObject(terminalState.response?.["incomplete_details"])
            ? terminalState.response["incomplete_details"]
            : undefined;
          const incompleteReason =
            typeof incompleteDetails?.["reason"] === "string"
              ? incompleteDetails["reason"]
              : undefined;
          const recordDecision = (
            decision: CodexResponseDecision,
            postToolDisposition?: "continue" | "error" | "retry",
          ): void => {
            const diagnostic = responseDecisionDiagnostic({
              attempt: responseRequests,
              attemptItems,
              capture: attemptCapture,
              decision,
              ...(incompleteReason ? { incompleteReason } : {}),
              ...(postToolDisposition ? { postToolDisposition } : {}),
              terminalState,
              toolCalls,
            });
            if (diagnostic) output.diagnostics = [...(output.diagnostics ?? []), diagnostic];
          };

          // Return each done tool call before processing an unsuccessful response
          // terminal. Pi will execute the completed subset; started-only siblings
          // are discarded and never enter provider history.
          if (toolCalls.hasCompletedCalls) {
            const callIds = completedAttemptToolCallIds(output, attemptState);
            if (callIds.length !== toolCalls.completedCount) {
              throw new Error("Codex completed tool-call items could not be mapped to Pi calls.");
            }
            let postToolDisposition: "continue" | "error" | "retry" = "continue";
            if (
              terminalState.type === "response.incomplete" ||
              terminalState.type === "response.failed"
            ) {
              const retryable =
                terminalState.type === "response.incomplete" ||
                retryableResponseFailure(terminalState.response);
              postToolDisposition = retryable ? "retry" : "error";
              registeredPostToolDisposition = {
                callIds,
                ...(terminalState.response
                  ? { response: structuredClone(terminalState.response) }
                  : {}),
                retryAttempt: retryable ? responseRetries + 1 : responseRetries,
                ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
                terminalType: terminalState.type,
                turnId: agentTurn.turnId,
                type: postToolDisposition,
              };
              this.rememberPostToolDisposition(registeredPostToolDisposition);
            }
            discardIncompleteAttemptContent(output, attemptState);
            rawItems.push(...attemptItems.map((item) => structuredClone(item)));
            output.stopReason = "toolUse";
            delete output.errorMessage;
            recordDecision("return_tool_use", postToolDisposition);
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
            recordDecision(
              attemptItems.length === 0 ? "retry_original_input" : "continue_no_tools",
            );
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
        if (registeredPostToolDisposition) {
          this.forgetPostToolDisposition(registeredPostToolDisposition);
        }
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
