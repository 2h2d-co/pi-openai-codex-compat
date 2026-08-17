import type { Model } from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { normalizeReplayItem } from "../responses-replay.ts";
import type {
  CachedRequestDecision,
  CodexTransportOptions,
  CodexWebSocketAttempt,
  WebSocketLike,
} from "./codex-transport-contracts.ts";
import { transportDiagnostic } from "./codex-transport-diagnostics.ts";
import {
  CodexProtocolError,
  extractWebSocketCloseError,
  extractWebSocketError,
  thrownMessage,
} from "./codex-transport-errors.ts";
import { decodeWebSocketData, isTerminalEvent, normalizeEvent } from "./codex-transport-events.ts";
import {
  CODEX_WS_REQUEST_START_METADATA_KEY,
  captureTurnStateEvent,
  resolveCodexWebSocketUrl,
  serializedBytes,
  withTurnStateMetadata,
} from "./codex-transport-request-headers.ts";
import {
  acquireWebSocket,
  closeSocket,
  getOrCreateWebSocketDebugStats,
  websocketSessions,
} from "./codex-transport-websocket-pool.ts";
import {
  cachedRequestBody,
  jsonWireRequestBody,
  requestInputLength,
} from "./codex-transport-websocket-continuation.ts";

export async function* parseWebSocket(
  socket: WebSocketLike,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AsyncGenerator<JsonRecord> {
  const queue: JsonRecord[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  let terminal = false;

  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const onMessage = (event: unknown) => {
    void (async () => {
      let text: string | undefined;
      try {
        if (!isObject(event)) return;
        text = await decodeWebSocketData(event["data"]);
        if (!text) return;
        const parsed = JSON.parse(text) as unknown;
        if (!isObject(parsed)) throw new Error("Invalid WebSocket event");
        const type = parsed.type;
        if (
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.incomplete" ||
          type === "response.failed"
        ) {
          terminal = true;
          done = true;
        }
        queue.push(parsed);
        notify();
      } catch (error) {
        failure = new CodexProtocolError(
          `Invalid Codex WebSocket JSON: ${thrownMessage(error)}`,
          text,
          error,
        );
        done = true;
        notify();
      }
    })();
  };
  const onError = (event: unknown) => {
    if (!failure) failure = extractWebSocketError(event);
    done = true;
    notify();
  };
  const onClose = (event: unknown) => {
    if (!terminal && !failure) failure = extractWebSocketCloseError(event);
    done = true;
    notify();
  };
  const onAbort = () => {
    failure = new Error("Request was aborted");
    done = true;
    notify();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          const timer = setTimeout(() => {
            const error = new Error(`WebSocket idle timeout after ${timeoutMs}ms`);
            failure = error;
            done = true;
            wake = undefined;
            closeSocket(socket, "idle_timeout");
            reject(error);
          }, timeoutMs);
          const priorWake = wake;
          wake = () => {
            clearTimeout(timer);
            priorWake();
          };
        }
      });
    }
    if (failure) throw failure;
    if (!terminal) throw new Error("WebSocket stream closed before response.completed");
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function* requestWebSocket(
  model: Model<any>,
  body: JsonRecord,
  options: CodexTransportOptions,
  headers: Headers,
  sessionId: string | undefined,
  accountId: string,
  timeoutMs: number | undefined,
  connectTimeoutMs: number,
  requestBytes: number,
  onAttempt: (attempt: CodexWebSocketAttempt) => void,
): AsyncGenerator<JsonRecord> {
  const acquired = await acquireWebSocket(
    resolveCodexWebSocketUrl(model.baseUrl),
    headers,
    sessionId,
    accountId,
    options.signal,
    connectTimeoutMs,
  );
  let keep = false;
  let responseHandleActive = true;
  const discard = (): boolean => {
    if (!responseHandleActive) return false;
    responseHandleActive = false;
    if (acquired.entry) delete acquired.entry.continuation;
    acquired.release(false);
    return true;
  };
  try {
    if (options.signal?.aborted) throw new Error("Request was aborted");
    const useContinuation =
      options.transport === "auto" || options.transport === "websocket-cached";
    const routed = withTurnStateMetadata(body, options.turnState);
    const fullBody =
      useContinuation && acquired.entry ? jsonWireRequestBody(routed.body) : routed.body;
    const decision =
      useContinuation && acquired.entry
        ? cachedRequestBody(acquired.entry, fullBody)
        : ({ body: fullBody, contextMode: "full" } satisfies CachedRequestDecision);
    const requestBody = decision.body;
    const warmup = options.warmup === true;
    const requestStartedAtUnixMs = String(Date.now());
    const withRequestStart = (candidate: JsonRecord): JsonRecord => ({
      ...candidate,
      client_metadata: {
        ...(isObject(candidate.client_metadata) ? candidate.client_metadata : {}),
        [CODEX_WS_REQUEST_START_METADATA_KEY]: requestStartedAtUnixMs,
      },
    });
    const fullRequestJson = JSON.stringify({
      type: "response.create",
      ...withRequestStart(fullBody),
      ...(warmup ? { generate: false } : {}),
    });
    const wireRequestJson = JSON.stringify({
      type: "response.create",
      ...withRequestStart(requestBody),
      ...(warmup ? { generate: false } : {}),
    });
    onAttempt({
      connection: acquired.reused ? "reused" : "new",
      contextMode: decision.contextMode,
      inputItems: requestInputLength(requestBody),
      fullInputItems: requestInputLength(fullBody),
      fullRequestBytes: serializedBytes(fullRequestJson),
      wireRequestBytes: serializedBytes(wireRequestJson),
      ...(decision.previousResponseId ? { previousResponseId: decision.previousResponseId } : {}),
      ...(decision.bypassReason ? { bypassReason: decision.bypassReason } : {}),
      ...(decision.historyMismatch ? { historyMismatch: decision.historyMismatch } : {}),
      ...(decision.cacheIdentityPreserved === undefined
        ? {}
        : { cacheIdentityPreserved: decision.cacheIdentityPreserved }),
      ...(options.turnState
        ? {
            turnStateReplayed: routed.replayedValue !== undefined,
            ...(routed.replayedValue ? { turnStateReplayedValue: routed.replayedValue } : {}),
          }
        : {}),
    });
    const stats = sessionId ? getOrCreateWebSocketDebugStats(sessionId) : undefined;
    if (stats) {
      stats.requests += 1;
      if (warmup) stats.prewarmRequests += 1;
      if (acquired.reused) stats.connectionsReused += 1;
      else stats.connectionsCreated += 1;
      if (useContinuation) stats.cachedContextRequests += 1;
      if (requestBody.store === true) stats.storeTrueRequests += 1;
      stats.lastInputItems = requestInputLength(requestBody);
      if (requestBody.previous_response_id) {
        stats.deltaRequests += 1;
        stats.lastDeltaInputItems = requestInputLength(requestBody);
        stats.lastPreviousResponseId = requestBody.previous_response_id as string;
      } else {
        stats.fullContextRequests += 1;
        delete stats.lastDeltaInputItems;
        delete stats.lastPreviousResponseId;
      }
    }
    options.onWebSocketResponseHandle?.({
      discard,
      failParsing(error) {
        if (!discard()) return false;
        options.onTransportDiagnostic?.(
          transportDiagnostic(error, options.transport ?? "auto", true, requestBytes),
        );
        return true;
      },
    });
    acquired.socket.send(wireRequestJson);
    const responseItems: JsonRecord[] = [];
    let responseId: string | undefined;
    let responseCompleted = false;
    for await (const event of parseWebSocket(acquired.socket, options.signal, timeoutMs)) {
      captureTurnStateEvent(event, options.turnState);
      if (event.type === "response.metadata") continue;
      if (
        event.type === "response.created" &&
        isObject(event.response) &&
        typeof event.response.id === "string"
      ) {
        responseId = event.response.id;
      }
      if (event.type === "response.output_item.done" && isObject(event.item)) {
        responseItems.push(structuredClone(event.item));
      }
      if (
        (event.type === "response.completed" ||
          event.type === "response.done" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed") &&
        isObject(event.response)
      ) {
        if (event.type === "response.completed" || event.type === "response.done") {
          responseCompleted = true;
        }
        if (typeof event.response.id === "string") responseId = event.response.id;
      }
      const normalized = normalizeEvent(event);
      if (!normalized) continue;
      yield normalized;
      if (isTerminalEvent(normalized)) break;
    }
    if (options.signal?.aborted) throw new Error("Request was aborted");
    if (useContinuation && acquired.entry && responseId && responseCompleted) {
      const entry = acquired.entry;
      const continuation = {
        lastRequestBody: fullBody,
        lastResponseId: responseId,
        lastResponseItems: responseItems.map(normalizeReplayItem),
      };
      entry.continuation = continuation;
      if (sessionId) {
        options.onContinuationReady?.({
          responseId,
          replaceResponseItems(items) {
            if (
              websocketSessions.get(sessionId)?.get(accountId) !== entry ||
              entry.continuation !== continuation ||
              continuation.lastResponseId !== responseId
            ) {
              return false;
            }
            continuation.lastResponseItems = items.map((item) => structuredClone(item));
            return true;
          },
        });
      }
    }
    keep = true;
  } catch (error) {
    responseHandleActive = false;
    throw error;
  } finally {
    if (!keep && acquired.entry) delete acquired.entry.continuation;
    acquired.release(keep);
  }
}
