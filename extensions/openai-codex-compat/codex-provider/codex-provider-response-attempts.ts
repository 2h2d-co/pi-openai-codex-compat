import { isBoolean, isNumber, isString } from "../value-contracts.ts";
import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  Context,
  Model,
  OpenAICodexResponsesOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  isObject,
  isResponsesItem,
  type JsonRecord,
  type ResponsesItem,
} from "../codex-protocol.ts";
import type { CodexStreamAttemptState } from "../codex-stream.ts";
import type {
  CodexAttemptCapture,
  CodexPostToolDisposition,
  CodexResponseDecision,
  CodexTerminalState,
  CodexToolCallAssessment,
  RuntimeScope,
} from "./codex-provider-contracts.ts";

export function transportOptions(
  options: OpenAICodexResponsesOptions | undefined,
): OpenAICodexResponsesOptions {
  return options ?? {};
}

export function isToolCallItem(item: ResponsesItem): boolean {
  return item.type === "function_call" || item.type === "custom_tool_call";
}

export function eventOutputIndex(event: JsonRecord): number {
  return isNumber(event["output_index"]) ? event["output_index"] : 0;
}

export function assessAttemptToolCalls(
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

export interface OutputItemTypeCounts {
  [type: string]: number | undefined;
}

export function outputItemTypeCounts(items: readonly ResponsesItem[]): OutputItemTypeCounts {
  const counts: OutputItemTypeCounts = {};
  for (const item of items) {
    const type = item.type ?? "message";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

export function responseDecisionDiagnostic(options: {
  attempt: number;
  attemptItems: readonly ResponsesItem[];
  capture: CodexAttemptCapture;
  decision: CodexResponseDecision;
  failureReason?: string;
  incompleteReason?: string;
  postToolDisposition?: "continue" | "error" | "retry";
  terminalState: CodexTerminalState;
  toolCalls: CodexToolCallAssessment;
}): AssistantMessageDiagnostic | undefined {
  const endTurn = isBoolean(options.terminalState.response?.["end_turn"])
    ? options.terminalState.response["end_turn"]
    : undefined;
  const nontrivial =
    options.attempt > 1 ||
    options.terminalState.type !== "response.completed" ||
    options.failureReason !== undefined ||
    endTurn === false ||
    options.capture.streamedToolCallIndexes.size > 0;
  if (!nontrivial) return undefined;

  const details: JsonRecord = {
    attempt: options.attempt,
    terminalType: options.failureReason ?? options.terminalState.type ?? "missing",
    outputItemTypes: outputItemTypeCounts(options.attemptItems),
    streamedCallsStarted: options.capture.streamedToolCallIndexes.size,
    streamedCallsDone: options.capture.streamedCompletedToolCallIndexes.size,
    returnedCalls: options.toolCalls.completedCount,
    discardedPartialCalls: options.toolCalls.discardedPartialCount,
    decision: options.decision,
  };
  if (options.incompleteReason) details["incompleteReason"] = options.incompleteReason;
  if (endTurn !== undefined) details["endTurn"] = endTurn;
  if (options.postToolDisposition) {
    details["postToolDisposition"] = options.postToolDisposition;
  }
  return {
    type: "codex_response_decision",
    timestamp: Date.now(),
    details,
  };
}

export function captureRawEvents(
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

export function startOnFirstEvent(
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

export function clearStreamingScratchState(message: AssistantMessage): void {
  for (const block of message.content) {
    Reflect.deleteProperty(block, "partialJson");
    Reflect.deleteProperty(block, "customInput");
  }
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function discardIncompleteAttemptContent(
  message: AssistantMessage,
  attempt: CodexStreamAttemptState,
): void {
  const incomplete = [...attempt.startedContentIndexes]
    .filter((index) => !attempt.completedContentIndexes.has(index))
    .sort((left, right) => right - left);
  for (const index of incomplete) message.content.splice(index, 1);
}

export function accumulateUsage(previous: Usage, current: Usage): Usage {
  const previousReasoning = previous.reasoning;
  const currentReasoning = current.reasoning;
  const usage: Usage = {
    input: previous.input + current.input,
    output: previous.output + current.output,
    cacheRead: previous.cacheRead + current.cacheRead,
    cacheWrite: previous.cacheWrite + current.cacheWrite,
    totalTokens: previous.totalTokens + current.totalTokens,
    cost: {
      input: previous.cost.input + current.cost.input,
      output: previous.cost.output + current.cost.output,
      cacheRead: previous.cost.cacheRead + current.cost.cacheRead,
      cacheWrite: previous.cost.cacheWrite + current.cost.cacheWrite,
      total: previous.cost.total + current.cost.total,
    },
  };
  if (previousReasoning !== undefined || currentReasoning !== undefined) {
    usage.reasoning = (previousReasoning ?? 0) + (currentReasoning ?? 0);
  }
  return usage;
}

export function reachedProviderCompactionThreshold(
  scope: RuntimeScope | undefined,
  usage: Usage,
  model: Model<any>,
): boolean {
  const threshold = scope?.config.autoCompactAtPercent;
  if (threshold === undefined || model.contextWindow <= 0 || usage.output >= model.maxTokens) {
    return false;
  }
  const contextTokens =
    usage.totalTokens > 0
      ? usage.totalTokens
      : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return contextTokens > 0 && (contextTokens / model.contextWindow) * 100 >= threshold;
}

export function retryableResponseFailure(response: JsonRecord | undefined): boolean {
  const error = isObject(response?.["error"]) ? response["error"] : undefined;
  const code = isString(error?.["code"]) ? error["code"].toLowerCase() : "";
  return !(
    code === "context_length_exceeded" ||
    code === "insufficient_quota" ||
    code === "usage_not_included" ||
    code === "cyber_policy" ||
    code === "invalid_prompt" ||
    code === "bio_policy"
  );
}

export function terminalReason(terminalState: CodexTerminalState): string | undefined {
  if (terminalState.type === "response.failed") {
    const error = isObject(terminalState.response?.["error"])
      ? terminalState.response["error"]
      : undefined;
    return isString(error?.["code"]) ? error["code"] : undefined;
  }
  if (terminalState.type === "response.incomplete") {
    const details = isObject(terminalState.response?.["incomplete_details"])
      ? terminalState.response["incomplete_details"]
      : undefined;
    return isString(details?.["reason"]) ? details["reason"] : undefined;
  }
  return undefined;
}

export function terminalErrorMessage(disposition: CodexPostToolDisposition): string {
  if (disposition.terminalType === "websocket_connection_limit_reached") {
    return (
      disposition.errorMessage ??
      "Codex WebSocket reached its connection age limit before tool outputs were recorded"
    );
  }
  if (disposition.terminalType === "response.failed") {
    const error = isObject(disposition.response?.["error"])
      ? disposition.response["error"]
      : undefined;
    return isString(error?.["message"]) ? error["message"] : "Codex response failed";
  }
  const details = isObject(disposition.response?.["incomplete_details"])
    ? disposition.response["incomplete_details"]
    : undefined;
  const reason = isString(details?.["reason"]) ? details["reason"] : undefined;
  return reason
    ? `Response incomplete: ${reason}`
    : "Response incomplete without a provider reason";
}

export function completedAttemptToolCallIds(
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

export function assertLinkedToolOutputs(
  context: Context,
  disposition: CodexPostToolDisposition,
): void {
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

export function responseRetryDelayMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) return 0;
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.floor(exponential * (0.9 + Math.random() * 0.2));
}

export function waitForResponseRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

export function continueResponseBody(
  body: JsonRecord,
  responseItems: readonly ResponsesItem[],
): JsonRecord | undefined {
  if (!Array.isArray(body.input) || !body.input.every(isResponsesItem)) return undefined;
  return updateInput(body, [...body.input, ...responseItems]);
}

export function updateInput(payload: JsonRecord, input: readonly ResponsesItem[]): JsonRecord {
  const result: JsonRecord = {
    ...payload,
    input: input.map((item) => structuredClone(item)),
  };
  delete result.messages;
  delete result.previous_response_id;
  return result;
}

export function assertSuccessfulOutput(
  message: AssistantMessage,
): asserts message is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
  if (message.stopReason === "pending") {
    throw new Error("Codex stream ended without a stop reason");
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "An unknown error occurred");
  }
}

export function applyServiceTierPricing(
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
