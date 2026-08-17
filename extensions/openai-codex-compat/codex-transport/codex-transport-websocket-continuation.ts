import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { stableResponsesJson } from "../responses-replay.ts";
import type { CachedRequestDecision, CachedWebSocket } from "./codex-transport-contracts.ts";

export function requestWithoutHistory(body: JsonRecord): JsonRecord {
  const result = { ...body };
  delete result.input;
  delete result.previous_response_id;
  delete result.client_metadata;
  // This controls response delivery only, not the model context retained by
  // previous_response_id.
  delete result["stream_options"];
  return result;
}

export function responseItemsMatch(previous: unknown, current: unknown): boolean {
  if (!isObject(previous) || !isObject(current)) {
    return stableResponsesJson(previous) === stableResponsesJson(current);
  }
  const previousComparable = structuredClone(previous);
  const currentComparable = structuredClone(current);
  delete previousComparable["internal_chat_message_metadata_passthrough"];
  delete currentComparable["internal_chat_message_metadata_passthrough"];
  return stableResponsesJson(previousComparable) === stableResponsesJson(currentComparable);
}

export function jsonWireRequestBody(body: JsonRecord): JsonRecord {
  const snapshot = JSON.parse(JSON.stringify(body)) as unknown;
  if (!isObject(snapshot)) {
    throw new Error("Codex request body must serialize to a JSON object");
  }
  return snapshot;
}

export function cachedRequestBody(entry: CachedWebSocket, body: JsonRecord): CachedRequestDecision {
  const continuation = entry.continuation;
  if (!continuation) return { body, contextMode: "full" };
  const previousResponseId = continuation.lastResponseId;
  const cacheIdentityPreserved =
    continuation.lastRequestBody.prompt_cache_key === body.prompt_cache_key;
  if (
    stableResponsesJson(requestWithoutHistory(body)) !==
    stableResponsesJson(requestWithoutHistory(continuation.lastRequestBody))
  ) {
    delete entry.continuation;
    return {
      body,
      contextMode: "full",
      previousResponseId,
      bypassReason: "request_template_changed",
      cacheIdentityPreserved,
    };
  }

  const currentInput = body.input ?? [];
  const previousInput = continuation.lastRequestBody.input ?? [];
  if (!Array.isArray(currentInput) || !Array.isArray(previousInput)) {
    delete entry.continuation;
    return {
      body,
      contextMode: "full",
      previousResponseId,
      bypassReason: "non_array_input",
      cacheIdentityPreserved,
    };
  }
  const baseline = [...previousInput, ...continuation.lastResponseItems];
  const mismatchIndex = baseline.findIndex(
    (item, index) => index >= currentInput.length || !responseItemsMatch(item, currentInput[index]),
  );
  if (mismatchIndex >= 0) {
    delete entry.continuation;
    return {
      body,
      contextMode: "full",
      previousResponseId,
      bypassReason: "history_prefix_changed",
      historyMismatch: {
        index: mismatchIndex,
        baselineInputItems: baseline.length,
        currentInputItems: currentInput.length,
        baselineItem: structuredClone(baseline[mismatchIndex]),
        ...(mismatchIndex < currentInput.length
          ? { currentItem: structuredClone(currentInput[mismatchIndex]) }
          : {}),
      },
      cacheIdentityPreserved,
    };
  }

  return {
    body: {
      ...body,
      previous_response_id: previousResponseId,
      input: currentInput.slice(baseline.length),
    },
    contextMode: "delta",
    previousResponseId,
    cacheIdentityPreserved,
  };
}

export function requestInputLength(body: JsonRecord): number {
  return typeof body.input === "string" || Array.isArray(body.input) ? body.input.length : 0;
}
