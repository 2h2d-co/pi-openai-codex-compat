import { isString } from "./value-contracts.ts";
import {
  registerSessionResourceCleanup,
  type Api,
  type Model,
  uuidv7,
} from "@earendil-works/pi-ai";
import { codexCacheKey } from "./codex-cache-key.ts";
import { isJsonValue, isObject, type JsonRecord, type JsonValue } from "./codex-protocol.ts";
import { responsesLiteSsePayload } from "./responses-lite.ts";
import type {
  CacheIdentitySnapshot,
  CodexCacheUsageDiagnostic,
  CodexContinuationHandle,
  CodexJsonRequestOptions,
  CodexTransportPrewarmDiagnostic,
  CodexTransportRecoveryAttempt,
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
  CodexCacheUsageDiagnostic,
  CodexContinuationBypassReason,
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
export {
  WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
  isWebSocketConnectionLimitReachedError,
} from "./codex-transport/codex-transport-errors.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.84.1
 * src/api/openai-codex-responses.ts transport behavior.
 */

export async function requestCodexJson(
  model: Model<Api>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
): Promise<JsonValue> {
  const headers = jsonHeaders(
    model.headers,
    options.headers,
    options.extraHeaders,
    validateCodexAuthentication(model, options.apiKey),
    options.apiKey,
  );
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (options.signal) init.signal = options.signal;
  const response = await (options.fetch ?? globalThis.fetch)(
    resolveCodexApiUrl(model.baseUrl, path),
    init,
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw codexHttpError(response.status, response.statusText, responseText);
  }
  try {
    const value: unknown = JSON.parse(responseText);
    if (!isJsonValue(value)) {
      throw new Error(`Codex returned a non-JSON value from ${path}.`);
    }
    return value;
  } catch (error) {
    throw new Error(
      `Codex returned invalid JSON from ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export class CodexTransport {
  async prewarm(
    model: Model<Api>,
    body: JsonRecord,
    options: CodexTransportOptions,
  ): Promise<boolean> {
    const transport = options.transport ?? "auto";
    const turnStateAvailableAtStart = options.turnState?.available ?? false;
    const turnStateRevisionAtStart = options.turnState?.revision ?? 0;
    const turnStateValueAtStart = options.turnState?.replayValue();
    type PrewarmDiagnosticContext = Pick<
      CodexTransportPrewarmDiagnostic["details"],
      | "cache"
      | "turnStateAvailableAtStart"
      | "turnStateReceived"
      | "turnStateAtStart"
      | "turnStateReceivedValue"
    >;
    const diagnosticDetails = (): PrewarmDiagnosticContext => {
      const turnStateReceived =
        (options.turnState?.revision ?? turnStateRevisionAtStart) > turnStateRevisionAtStart;
      const turnStateReceivedValue = options.turnState?.replayValue();
      const details: PrewarmDiagnosticContext = {};
      if (options.cacheDiagnostics) details.cache = options.cacheDiagnostics;
      if (options.turnState) {
        details.turnStateAvailableAtStart = turnStateAvailableAtStart;
        details.turnStateReceived = turnStateReceived;
        if (turnStateValueAtStart) details.turnStateAtStart = turnStateValueAtStart;
        if (turnStateReceived && turnStateReceivedValue) {
          details.turnStateReceivedValue = turnStateReceivedValue;
        }
      }
      return details;
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
    model: Model<Api>,
    body: JsonRecord | JsonValue[],
    options: CodexTransportOptions,
  ): AsyncGenerator<JsonRecord> {
    if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const connectTimeoutMs =
      normalizeTimeoutMs(options.websocketConnectTimeoutMs) ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
    const objectBody: JsonRecord = Array.isArray(body) ? {} : body;
    const sseBody = Array.isArray(body) ? body : responsesLiteSsePayload(body);
    const objectSseBody: JsonRecord = Array.isArray(sseBody) ? {} : sseBody;
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
    if (transport !== "sse" && !websocketDisabled && !Array.isArray(body)) {
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
              const recoveryOptions: Parameters<typeof transportRecoveryDiagnostic>[0] = {
                trigger: "local_continuation_bypass",
                configuredTransport: transport,
                attempts: [webSocketRecoveryAttempt(currentAttempt, "selected")],
                cacheIdentity: webSocketCacheIdentity,
                continuationBypassReason: currentAttempt.bypassReason,
                accountIdentityPreserved: true,
              };
              if (currentAttempt.previousResponseId) {
                recoveryOptions.previousResponseId = currentAttempt.previousResponseId;
              }
              if (currentAttempt.historyMismatch) {
                recoveryOptions.historyMismatch = currentAttempt.historyMismatch;
              }
              if (currentAttempt.cacheIdentityPreserved !== undefined) {
                recoveryOptions.cacheIdentityPreserved = currentAttempt.cacheIdentityPreserved;
              }
              options.onTransportDiagnostic?.(transportRecoveryDiagnostic(recoveryOptions));
            },
          )) {
            if (!emitted) options.onTransportStart?.();
            emitted = true;
            anyEventEmitted = true;
            if (webSocketEventStartsVisibleOutput(event)) visibleOutputEmitted = true;
            usage = cacheUsageDiagnostic(event) ?? usage;
            if (isObject(event.response) && isString(event.response.id)) {
              responseId = event.response.id;
            }
            yield event;
          }
          if (attempt && shouldReportRequestDiagnostic(options)) {
            const requestDiagnosticOptions: Parameters<typeof transportRequestDiagnostic>[0] = {
              requestOptions: options,
              body,
              configuredTransport: transport,
              selectedTransport: "websocket",
              attempt,
              cacheIdentity: webSocketCacheIdentity,
              turnStateAvailableAtStart,
              turnStateRevisionAtStart,
            };
            if (turnStateValueAtStart) {
              requestDiagnosticOptions.turnStateValueAtStart = turnStateValueAtStart;
            }
            if (responseId) requestDiagnosticOptions.responseId = responseId;
            if (usage) requestDiagnosticOptions.usage = usage;
            options.onTransportDiagnostic?.(transportRequestDiagnostic(requestDiagnosticOptions));
          }
          return;
        } catch (error) {
          const aborted = options.signal?.aborted;
          const connectionLimitReached = isWebSocketConnectionLimitReachedError(error);
          if (!aborted && options.requestKind === "turn" && connectionLimitReached) {
            // A turn may already have committed output items. Its provider-owned
            // response loop must decide what to carry forward before resampling.
            throw error;
          }
          const connectionLimitBeforeVisibleOutput =
            !visibleOutputEmitted && connectionLimitReached;
          if (!aborted && isPreviousResponseNotFoundError(error) && !retriedMissingContinuation) {
            retriedMissingContinuation = true;
            if (attempt) {
              const retryTurnStateValue = options.turnState?.replayValue();
              const retryAttempt: CodexTransportRecoveryAttempt = {
                transport: "websocket",
                connection: "new",
                contextMode: "full",
                inputItems: attempt.fullInputItems,
                fullInputItems: attempt.fullInputItems,
                fullRequestBytes: attempt.fullRequestBytes,
                wireRequestBytes: attempt.fullRequestBytes,
                outcome: "retry_scheduled",
              };
              if (options.turnState) {
                retryAttempt.turnStateReplayed = options.turnState.available;
                if (retryTurnStateValue) {
                  retryAttempt.turnStateReplayedValue = retryTurnStateValue;
                }
              }
              const recoveryOptions: Parameters<typeof transportRecoveryDiagnostic>[0] = {
                trigger: "previous_response_not_found",
                configuredTransport: transport,
                attempts: [
                  webSocketRecoveryAttempt(attempt, "previous_response_not_found"),
                  retryAttempt,
                ],
                cacheIdentity: webSocketCacheIdentity,
                error,
                cacheIdentityPreserved: true,
                accountIdentityPreserved: true,
              };
              if (attempt.previousResponseId) {
                recoveryOptions.previousResponseId = attempt.previousResponseId;
              }
              options.onTransportDiagnostic?.(transportRecoveryDiagnostic(recoveryOptions));
            }
            continue;
          }
          if (!aborted && connectionLimitBeforeVisibleOutput && !retriedConnectionLimit) {
            retriedConnectionLimit = true;
            continue;
          }
          const retryableTransportError =
            !aborted &&
            !visibleOutputEmitted &&
            (!isCodexNonTransportError(error) || connectionLimitBeforeVisibleOutput);
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
          if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeVisibleOutput)) {
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
      objectBody,
    );
    if (sseRecovery) {
      const sseCacheIdentity = cacheIdentitySnapshot(objectSseBody, headers, accountId);
      options.onTransportDiagnostic?.(
        transportRecoveryDiagnostic({
          trigger: sseRecovery.trigger,
          configuredTransport: transport,
          attempts: [
            sseRecoveryAttempt(objectSseBody, sseRequestBytes, options.turnState?.replayValue()),
          ],
          cacheIdentity: sseCacheIdentity,
          previousCacheIdentity: sseRecovery.previousCacheIdentity,
        }),
      );
    }
    const sseCacheIdentity = cacheIdentitySnapshot(objectSseBody, headers, accountId);
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
          if (isObject(event.response) && isString(event.response.id)) {
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
                ...sseRecoveryAttempt(objectSseBody, sseRequestBytes, sseTurnStateReplayedValue),
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
      const inputItems = requestInputLength(objectSseBody);
      const sseAttempt: Exclude<
        Parameters<typeof transportRequestDiagnostic>[0]["attempt"],
        CodexWebSocketAttempt
      > = {
        contextMode: "full",
        inputItems,
        fullInputItems: inputItems,
        fullRequestBytes: sseRequestBytes,
        wireRequestBytes: sseRequestBytes,
        turnStateReplayed: sseTurnStateReplayedValue !== undefined,
      };
      if (sseTurnStateReplayedValue) {
        sseAttempt.turnStateReplayedValue = sseTurnStateReplayedValue;
      }
      const requestDiagnosticOptions: Parameters<typeof transportRequestDiagnostic>[0] = {
        requestOptions: options,
        body: objectSseBody,
        configuredTransport: transport,
        selectedTransport: "sse",
        attempt: sseAttempt,
        cacheIdentity: sseCacheIdentity,
        turnStateAvailableAtStart,
        turnStateRevisionAtStart,
      };
      if (turnStateValueAtStart) {
        requestDiagnosticOptions.turnStateValueAtStart = turnStateValueAtStart;
      }
      if (responseId) requestDiagnosticOptions.responseId = responseId;
      if (usage) requestDiagnosticOptions.usage = usage;
      options.onTransportDiagnostic?.(transportRequestDiagnostic(requestDiagnosticOptions));
    }
  }

  close(sessionId?: string): void {
    closeOpenAICodexWebSocketSessions(sessionId);
  }
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
