import { registerSessionResourceCleanup, type Model, uuidv7 } from "@earendil-works/pi-ai";
import { codexCacheKey } from "./codex-cache-key.ts";
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { responsesLiteSsePayload } from "./responses-lite.ts";
import type {
  CacheIdentitySnapshot,
  CodexCacheUsageDiagnostic,
  CodexContinuationHandle,
  CodexJsonRequestOptions,
  CodexTransportOptions,
  CodexWebSocketAttempt,
} from "./codex-transport/codex-transport-contracts.ts";
import {
  cacheUsageDiagnostic,
  shouldReportRequestDiagnostic,
  sseRecoveryAttempt,
  transportDiagnostic,
  transportRecoveryDiagnostic,
  transportRequestDiagnostic,
  webSocketRecoveryAttempt,
} from "./codex-transport/codex-transport-diagnostics.ts";
import {
  CodexHttpError,
  RetryDelayExceededError,
  isCodexNonTransportError,
  isPreviousResponseNotFoundError,
  isWebSocketConnectionLimitReachedError,
  thrownMessage,
  codexHttpError,
} from "./codex-transport/codex-transport-errors.ts";
import { webSocketEventStartsVisibleOutput } from "./codex-transport/codex-transport-events.ts";
import {
  cacheIdentitySnapshot,
  jsonHeaders,
  resolveCodexApiUrl,
  serializedBytes,
  sseHeaders,
  validateCodexAuthentication,
  websocketHeaders,
} from "./codex-transport/codex-transport-request-headers.ts";
import {
  DEFAULT_SSE_STREAM_MAX_RETRIES,
  DEFAULT_SSE_STREAM_RETRY_BASE_DELAY_MS,
  DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  DEFAULT_WEBSOCKET_MAX_RETRIES,
  DEFAULT_WEBSOCKET_RETRY_BASE_DELAY_MS,
  normalizeRetryCount,
  normalizeTimeoutMs,
  retryBackoffMs,
  sleep,
} from "./codex-transport/codex-transport-retry.ts";
import { requestSse } from "./codex-transport/codex-transport-sse-stream.ts";
import {
  closeOpenAICodexWebSocketSessions,
  isWebSocketSseFallbackActive,
  recordWebSocketFailure,
  recordWebSocketSseFallback,
  webSocketFallbackSession,
} from "./codex-transport/codex-transport-websocket-pool.ts";
import { requestInputLength } from "./codex-transport/codex-transport-websocket-continuation.ts";
import { requestWebSocket } from "./codex-transport/codex-transport-websocket-stream.ts";

export type {
  CodexContinuationHandle,
  CodexJsonRequestOptions,
  CodexTransportDiagnostic,
  CodexTransportFailureDiagnostic,
  CodexTransportPrewarmDiagnostic,
  CodexTransportRecoveryDiagnostic,
  CodexTransportRequestDiagnostic,
  CodexWebSocketResponseHandle,
  OpenAICodexWebSocketDebugStats,
  CacheIdentitySnapshot,
} from "./codex-transport/codex-transport-contracts.ts";
export { CodexTurnState } from "./codex-transport/codex-transport-turn-state.ts";
export {
  CODEX_WS_REQUEST_START_METADATA_KEY,
  resolveCodexApiUrl,
  validateCodexAuthentication,
} from "./codex-transport/codex-transport-request-headers.ts";
export {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
} from "./codex-transport/codex-transport-websocket-pool.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.84.1
 * src/api/openai-codex-responses.ts transport behavior.
 */

export async function requestCodexJson(
  model: Model<any>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
): Promise<unknown> {
  const headers = jsonHeaders(
    model.headers,
    options.headers,
    options.extraHeaders,
    validateCodexAuthentication(model, options.apiKey),
    options.apiKey,
  );
  const response = await (options.fetch ?? globalThis.fetch)(
    resolveCodexApiUrl(model.baseUrl, path),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw codexHttpError(response.status, response.statusText, responseText);
  }
  try {
    return JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new Error(
      `Codex returned invalid JSON from ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class CodexTransport {
  async prewarm(
    model: Model<any>,
    body: JsonRecord,
    options: CodexTransportOptions,
  ): Promise<boolean> {
    const transport = options.transport ?? "auto";
    const turnStateAvailableAtStart = options.turnState?.available ?? false;
    const turnStateRevisionAtStart = options.turnState?.revision ?? 0;
    const turnStateValueAtStart = options.turnState?.replayValue();
    const diagnosticDetails = () => {
      const turnStateReceived =
        (options.turnState?.revision ?? turnStateRevisionAtStart) > turnStateRevisionAtStart;
      const turnStateReceivedValue = options.turnState?.replayValue();
      return {
        ...(options.cacheDiagnostics ? { cache: options.cacheDiagnostics } : {}),
        ...(options.turnState
          ? {
              turnStateAvailableAtStart,
              turnStateReceived,
              ...(turnStateValueAtStart ? { turnStateAtStart: turnStateValueAtStart } : {}),
              ...(turnStateReceived && turnStateReceivedValue ? { turnStateReceivedValue } : {}),
            }
          : {}),
      };
    };
    if (transport === "sse") {
      options.onTransportDiagnostic?.({
        type: "codex_transport_prewarm",
        timestamp: Date.now(),
        details: {
          outcome: "skipped",
          continuationReady: false,
          reason: "sse_configured",
          ...diagnosticDetails(),
        },
      });
      return false;
    }
    const cacheSessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
    if (isWebSocketSseFallbackActive(cacheSessionId)) {
      options.onTransportDiagnostic?.({
        type: "codex_transport_prewarm",
        timestamp: Date.now(),
        details: {
          outcome: "skipped",
          continuationReady: false,
          reason: "sticky_sse_fallback",
          ...diagnosticDetails(),
        },
      });
      return false;
    }

    let continuationReady = false;
    const notifyContinuationReady = (handle: CodexContinuationHandle): void => {
      options.onContinuationReady?.(handle);
    };
    try {
      for await (const _event of this.request(model, body, {
        ...options,
        warmup: true,
        requestKind: "prewarm",
        onContinuationReady(handle) {
          continuationReady = true;
          notifyContinuationReady(handle);
        },
      })) {
        // A v2 warmup completes without model output.
      }
    } catch (error) {
      options.onTransportDiagnostic?.({
        type: "codex_transport_prewarm",
        timestamp: Date.now(),
        details: {
          outcome: "failed",
          continuationReady: false,
          ...diagnosticDetails(),
        },
      });
      throw error;
    }
    options.onTransportDiagnostic?.({
      type: "codex_transport_prewarm",
      timestamp: Date.now(),
      details: {
        outcome: "completed",
        continuationReady,
        ...diagnosticDetails(),
      },
    });
    return continuationReady;
  }

  async *request(
    model: Model<any>,
    body: JsonRecord,
    options: CodexTransportOptions,
  ): AsyncGenerator<JsonRecord> {
    if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const connectTimeoutMs =
      normalizeTimeoutMs(options.websocketConnectTimeoutMs) ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
    const sseBody = responsesLiteSsePayload(body);
    const accountId = options.accountId ?? validateCodexAuthentication(model, options.apiKey);
    const cacheSessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
    const requestId = codexCacheKey(cacheSessionId);
    const transport = options.transport ?? "auto";
    const turnStateAvailableAtStart = options.turnState?.available ?? false;
    const turnStateRevisionAtStart = options.turnState?.revision ?? 0;
    const turnStateValueAtStart = options.turnState?.replayValue();
    const websocketMaxRetries = normalizeRetryCount(
      options.websocketMaxRetries,
      DEFAULT_WEBSOCKET_MAX_RETRIES,
      "websocketMaxRetries",
    );
    const websocketRetryBaseDelayMs = normalizeRetryCount(
      options.websocketRetryBaseDelayMs,
      DEFAULT_WEBSOCKET_RETRY_BASE_DELAY_MS,
      "websocketRetryBaseDelayMs",
    );
    const sseStreamMaxRetries = normalizeRetryCount(
      options.sseStreamMaxRetries,
      DEFAULT_SSE_STREAM_MAX_RETRIES,
      "sseStreamMaxRetries",
    );
    const sseStreamRetryBaseDelayMs = normalizeRetryCount(
      options.sseStreamRetryBaseDelayMs,
      DEFAULT_SSE_STREAM_RETRY_BASE_DELAY_MS,
      "sseStreamRetryBaseDelayMs",
    );

    const websocketDisabled = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
    let sseRecovery:
      | {
          trigger: "sse_after_websocket_failure" | "sticky_sse_after_websocket_failure";
          previousCacheIdentity: CacheIdentitySnapshot;
        }
      | undefined;
    const existingFallback = webSocketFallbackSession(cacheSessionId);
    if (websocketDisabled && existingFallback) {
      sseRecovery = {
        trigger: "sticky_sse_after_websocket_failure",
        previousCacheIdentity: existingFallback.cacheIdentity,
      };
    }
    if (websocketDisabled) recordWebSocketSseFallback(cacheSessionId);
    if (transport !== "sse" && !websocketDisabled) {
      const websocketRequestBytes = serializedBytes(JSON.stringify(body));
      const headers = websocketHeaders(
        model.headers,
        options.headers,
        accountId,
        options.apiKey,
        requestId || uuidv7(),
        body,
      );
      const webSocketCacheIdentity = cacheIdentitySnapshot(body, headers, accountId);
      let retriedConnectionLimit = false;
      let retriedMissingContinuation = false;
      let websocketRetries = 0;
      let visibleOutputEmitted = false;
      let anyEventEmitted = false;
      while (true) {
        let emitted = false;
        let attempt: CodexWebSocketAttempt | undefined;
        let usage: CodexCacheUsageDiagnostic | undefined;
        let responseId: string | undefined;
        try {
          for await (const event of requestWebSocket(
            model,
            body,
            options,
            headers,
            cacheSessionId,
            accountId,
            timeoutMs,
            connectTimeoutMs,
            websocketRequestBytes,
            (currentAttempt) => {
              attempt = currentAttempt;
              if (!currentAttempt.bypassReason) return;
              options.onTransportDiagnostic?.(
                transportRecoveryDiagnostic({
                  trigger: "local_continuation_bypass",
                  configuredTransport: transport,
                  attempts: [webSocketRecoveryAttempt(currentAttempt, "selected")],
                  cacheIdentity: webSocketCacheIdentity,
                  ...(currentAttempt.previousResponseId
                    ? { previousResponseId: currentAttempt.previousResponseId }
                    : {}),
                  continuationBypassReason: currentAttempt.bypassReason,
                  ...(currentAttempt.historyMismatch
                    ? { historyMismatch: currentAttempt.historyMismatch }
                    : {}),
                  ...(currentAttempt.cacheIdentityPreserved === undefined
                    ? {}
                    : { cacheIdentityPreserved: currentAttempt.cacheIdentityPreserved }),
                  accountIdentityPreserved: true,
                }),
              );
            },
          )) {
            if (!emitted) options.onTransportStart?.();
            emitted = true;
            anyEventEmitted = true;
            if (webSocketEventStartsVisibleOutput(event)) visibleOutputEmitted = true;
            usage = cacheUsageDiagnostic(event) ?? usage;
            if (isObject(event.response) && typeof event.response.id === "string") {
              responseId = event.response.id;
            }
            yield event;
          }
          if (attempt && shouldReportRequestDiagnostic(options)) {
            options.onTransportDiagnostic?.(
              transportRequestDiagnostic({
                requestOptions: options,
                body,
                configuredTransport: transport,
                selectedTransport: "websocket",
                attempt,
                cacheIdentity: webSocketCacheIdentity,
                turnStateAvailableAtStart,
                turnStateRevisionAtStart,
                ...(turnStateValueAtStart ? { turnStateValueAtStart } : {}),
                ...(responseId ? { responseId } : {}),
                ...(usage ? { usage } : {}),
              }),
            );
          }
          return;
        } catch (error) {
          const aborted = options.signal?.aborted;
          const connectionLimitBeforeStart =
            !emitted && isWebSocketConnectionLimitReachedError(error);
          if (!aborted && isPreviousResponseNotFoundError(error) && !retriedMissingContinuation) {
            retriedMissingContinuation = true;
            if (attempt) {
              const retryTurnStateValue = options.turnState?.replayValue();
              options.onTransportDiagnostic?.(
                transportRecoveryDiagnostic({
                  trigger: "previous_response_not_found",
                  configuredTransport: transport,
                  attempts: [
                    webSocketRecoveryAttempt(attempt, "previous_response_not_found"),
                    {
                      transport: "websocket",
                      connection: "new",
                      contextMode: "full",
                      inputItems: attempt.fullInputItems,
                      fullInputItems: attempt.fullInputItems,
                      fullRequestBytes: attempt.fullRequestBytes,
                      wireRequestBytes: attempt.fullRequestBytes,
                      outcome: "retry_scheduled",
                      ...(options.turnState
                        ? {
                            turnStateReplayed: options.turnState.available,
                            ...(retryTurnStateValue
                              ? { turnStateReplayedValue: retryTurnStateValue }
                              : {}),
                          }
                        : {}),
                    },
                  ],
                  cacheIdentity: webSocketCacheIdentity,
                  error,
                  ...(attempt.previousResponseId
                    ? { previousResponseId: attempt.previousResponseId }
                    : {}),
                  cacheIdentityPreserved: true,
                  accountIdentityPreserved: true,
                }),
              );
            }
            continue;
          }
          if (!aborted && connectionLimitBeforeStart && !retriedConnectionLimit) {
            retriedConnectionLimit = true;
            continue;
          }
          const retryableTransportError =
            !aborted &&
            !visibleOutputEmitted &&
            (!isCodexNonTransportError(error) || connectionLimitBeforeStart);
          if (retryableTransportError && websocketRetries < websocketMaxRetries) {
            websocketRetries += 1;
            if (attempt) {
              options.onTransportDiagnostic?.(
                transportRecoveryDiagnostic({
                  trigger: "websocket_retry",
                  configuredTransport: transport,
                  attempts: [webSocketRecoveryAttempt(attempt, "retry_scheduled")],
                  cacheIdentity: webSocketCacheIdentity,
                  error,
                  cacheIdentityPreserved: true,
                  accountIdentityPreserved: true,
                  retryNumber: websocketRetries,
                  maxRetries: websocketMaxRetries,
                }),
              );
            }
            await sleep(
              retryBackoffMs(websocketRetryBaseDelayMs, websocketRetries),
              options.signal,
            );
            continue;
          }
          if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
            throw error;
          }
          options.onTransportDiagnostic?.(
            transportDiagnostic(
              error,
              transport,
              anyEventEmitted,
              websocketRequestBytes,
              !visibleOutputEmitted,
            ),
          );
          recordWebSocketFailure(cacheSessionId, error, webSocketCacheIdentity);
          if (visibleOutputEmitted) throw error;
          recordWebSocketSseFallback(cacheSessionId);
          if (options.warmup) throw error;
          sseRecovery = {
            trigger: "sse_after_websocket_failure",
            previousCacheIdentity: webSocketCacheIdentity,
          };
          break;
        }
      }
    }

    const bodyJson = JSON.stringify(sseBody);
    const sseRequestBytes = serializedBytes(bodyJson);
    const headers = sseHeaders(
      model.headers,
      options.headers,
      accountId,
      options.apiKey,
      requestId,
      body,
    );
    if (sseRecovery) {
      const sseCacheIdentity = cacheIdentitySnapshot(sseBody, headers, accountId);
      options.onTransportDiagnostic?.(
        transportRecoveryDiagnostic({
          trigger: sseRecovery.trigger,
          configuredTransport: transport,
          attempts: [
            sseRecoveryAttempt(sseBody, sseRequestBytes, options.turnState?.replayValue()),
          ],
          cacheIdentity: sseCacheIdentity,
          previousCacheIdentity: sseRecovery.previousCacheIdentity,
        }),
      );
    }
    const sseCacheIdentity = cacheIdentitySnapshot(sseBody, headers, accountId);
    let sseTurnStateReplayedValue: string | undefined;
    let usage: CodexCacheUsageDiagnostic | undefined;
    let responseId: string | undefined;
    let sseStreamRetries = 0;
    while (true) {
      let visibleOutputEmitted = false;
      try {
        for await (const event of requestSse(
          model,
          bodyJson,
          options,
          headers,
          timeoutMs,
          (replayedValue) => {
            sseTurnStateReplayedValue = replayedValue;
          },
        )) {
          if (webSocketEventStartsVisibleOutput(event)) visibleOutputEmitted = true;
          usage = cacheUsageDiagnostic(event) ?? usage;
          if (isObject(event.response) && typeof event.response.id === "string") {
            responseId = event.response.id;
          }
          yield event;
        }
        break;
      } catch (error) {
        const retryableError =
          error instanceof CodexHttpError ? error.retryable : !isCodexNonTransportError(error);
        const retryable =
          !options.signal?.aborted &&
          !visibleOutputEmitted &&
          retryableError &&
          thrownMessage(error) !== "Request was aborted" &&
          !(error instanceof RetryDelayExceededError);
        if (!retryable || sseStreamRetries >= sseStreamMaxRetries) throw error;
        sseStreamRetries += 1;
        options.onTransportDiagnostic?.(
          transportRecoveryDiagnostic({
            trigger: "sse_stream_retry",
            configuredTransport: transport,
            attempts: [
              {
                ...sseRecoveryAttempt(sseBody, sseRequestBytes, sseTurnStateReplayedValue),
                outcome: "retry_scheduled",
              },
            ],
            cacheIdentity: sseCacheIdentity,
            error,
            cacheIdentityPreserved: true,
            accountIdentityPreserved: true,
            retryNumber: sseStreamRetries,
            maxRetries: sseStreamMaxRetries,
          }),
        );
        await sleep(retryBackoffMs(sseStreamRetryBaseDelayMs, sseStreamRetries), options.signal);
      }
    }
    if (shouldReportRequestDiagnostic(options)) {
      const inputItems = requestInputLength(sseBody);
      options.onTransportDiagnostic?.(
        transportRequestDiagnostic({
          requestOptions: options,
          body: sseBody,
          configuredTransport: transport,
          selectedTransport: "sse",
          attempt: {
            contextMode: "full",
            inputItems,
            fullInputItems: inputItems,
            fullRequestBytes: sseRequestBytes,
            wireRequestBytes: sseRequestBytes,
            turnStateReplayed: sseTurnStateReplayedValue !== undefined,
            ...(sseTurnStateReplayedValue
              ? { turnStateReplayedValue: sseTurnStateReplayedValue }
              : {}),
          },
          cacheIdentity: sseCacheIdentity,
          turnStateAvailableAtStart,
          turnStateRevisionAtStart,
          ...(turnStateValueAtStart ? { turnStateValueAtStart } : {}),
          ...(responseId ? { responseId } : {}),
          ...(usage ? { usage } : {}),
        }),
      );
    }
  }

  close(sessionId?: string): void {
    closeOpenAICodexWebSocketSessions(sessionId);
  }
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
