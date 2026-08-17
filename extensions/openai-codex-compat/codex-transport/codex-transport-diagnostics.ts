import { CODEX_INSTALLATION_ID_METADATA_KEY, CODEX_WINDOW_ID_HEADER } from "../codex-metadata.ts";
import { isObject, type JsonRecord } from "../codex-protocol.ts";
import type {
  CacheIdentitySnapshot,
  CodexCacheUsageDiagnostic,
  CodexContinuationBypassReason,
  CodexContinuationHistoryMismatch,
  CodexTransportFailureDiagnostic,
  CodexTransportOptions,
  CodexTransportRecoveryAttempt,
  CodexTransportRecoveryDiagnostic,
  CodexTransportRequestDiagnostic,
  CodexWebSocketAttempt,
} from "./codex-transport-contracts.ts";
import { thrownMessage } from "./codex-transport-errors.ts";
import { isTerminalEvent } from "./codex-transport-events.ts";
import {
  cacheAffinityEnabled,
  codexRoutingHint,
  promptKeyAndHeaderAligned,
  sameCacheIdentity,
} from "./codex-transport-request-headers.ts";
import { requestInputLength } from "./codex-transport-websocket-continuation.ts";

export function diagnosticError(error: unknown): CodexTransportFailureDiagnostic["error"] {
  if (!(error instanceof Error)) {
    return { name: "ThrownValue", message: thrownMessage(error) };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    ...(error.name ? { name: error.name } : {}),
    message: error.message || error.name,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

export function transportDiagnostic(
  error: unknown,
  transport: string,
  emitted: boolean,
  requestBytes: number,
  fallbackSelected = !emitted,
): CodexTransportFailureDiagnostic {
  return {
    type: "provider_transport_failure",
    timestamp: Date.now(),
    error: diagnosticError(error),
    details: {
      configuredTransport: transport,
      ...(fallbackSelected ? { fallbackTransport: "sse" as const } : {}),
      eventsEmitted: emitted,
      phase: emitted ? "after_message_stream_start" : "before_message_stream_start",
      requestBytes,
    },
  };
}

export function webSocketRecoveryAttempt(
  attempt: CodexWebSocketAttempt,
  outcome: CodexTransportRecoveryAttempt["outcome"],
): CodexTransportRecoveryAttempt {
  return {
    transport: "websocket",
    connection: attempt.connection,
    contextMode: attempt.contextMode,
    inputItems: attempt.inputItems,
    fullInputItems: attempt.fullInputItems,
    fullRequestBytes: attempt.fullRequestBytes,
    wireRequestBytes: attempt.wireRequestBytes,
    outcome,
    ...(attempt.turnStateReplayed === undefined
      ? {}
      : { turnStateReplayed: attempt.turnStateReplayed }),
    ...(attempt.turnStateReplayedValue
      ? { turnStateReplayedValue: attempt.turnStateReplayedValue }
      : {}),
  };
}

export function sseRecoveryAttempt(
  body: JsonRecord,
  requestBytes: number,
  turnStateReplayedValue: string | undefined,
): CodexTransportRecoveryAttempt {
  const inputItems = requestInputLength(body);
  return {
    transport: "sse",
    contextMode: "full",
    inputItems,
    fullInputItems: inputItems,
    fullRequestBytes: requestBytes,
    wireRequestBytes: requestBytes,
    outcome: "selected",
    turnStateReplayed: turnStateReplayedValue !== undefined,
    ...(turnStateReplayedValue ? { turnStateReplayedValue } : {}),
  };
}

export function transportRecoveryDiagnostic(options: {
  trigger: CodexTransportRecoveryDiagnostic["details"]["trigger"];
  configuredTransport: string;
  attempts: CodexTransportRecoveryAttempt[];
  cacheIdentity: CacheIdentitySnapshot;
  previousResponseId?: string;
  continuationBypassReason?: CodexContinuationBypassReason;
  historyMismatch?: CodexContinuationHistoryMismatch;
  error?: unknown;
  previousCacheIdentity?: CacheIdentitySnapshot;
  cacheIdentityPreserved?: boolean;
  accountIdentityPreserved?: boolean;
  retryNumber?: number;
  maxRetries?: number;
}): CodexTransportRecoveryDiagnostic {
  return {
    type: "codex_transport_recovery",
    timestamp: Date.now(),
    details: {
      trigger: options.trigger,
      configuredTransport: options.configuredTransport,
      ...(options.previousResponseId ? { previousResponseId: options.previousResponseId } : {}),
      ...(options.continuationBypassReason
        ? { continuationBypassReason: options.continuationBypassReason }
        : {}),
      ...(options.historyMismatch ? { historyMismatch: options.historyMismatch } : {}),
      ...(options.error === undefined ? {} : { error: diagnosticError(options.error) }),
      attempts: options.attempts,
      cacheIdentity: options.cacheIdentity,
      ...(options.previousCacheIdentity
        ? { previousCacheIdentity: options.previousCacheIdentity }
        : {}),
      cacheAffinityEnabled: cacheAffinityEnabled(options.cacheIdentity),
      ...(options.cacheIdentityPreserved !== undefined
        ? { cacheIdentityPreserved: options.cacheIdentityPreserved }
        : options.previousCacheIdentity
          ? {
              cacheIdentityPreserved: sameCacheIdentity(
                options.previousCacheIdentity,
                options.cacheIdentity,
              ),
            }
          : {}),
      ...(options.accountIdentityPreserved !== undefined
        ? { accountIdentityPreserved: options.accountIdentityPreserved }
        : options.previousCacheIdentity
          ? {
              accountIdentityPreserved:
                options.previousCacheIdentity.accountId === options.cacheIdentity.accountId,
            }
          : {}),
      promptKeyAndHeaderAligned: promptKeyAndHeaderAligned(options.cacheIdentity),
      ...(options.retryNumber === undefined ? {} : { retryNumber: options.retryNumber }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    },
  };
}

export function cacheUsageDiagnostic(event: JsonRecord): CodexCacheUsageDiagnostic | undefined {
  if (!isTerminalEvent(event) || !isObject(event.response) || !isObject(event.response.usage)) {
    return undefined;
  }
  const usage = event.response.usage;
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    cachedTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : 0,
    cacheWriteTokens:
      typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0,
  };
}

export function transportRequestDiagnostic(options: {
  requestOptions: CodexTransportOptions;
  body: JsonRecord;
  configuredTransport: string;
  selectedTransport: "websocket" | "sse";
  attempt:
    | CodexWebSocketAttempt
    | {
        contextMode: "full";
        inputItems: number;
        fullInputItems: number;
        fullRequestBytes: number;
        wireRequestBytes: number;
        turnStateReplayed: boolean;
        turnStateReplayedValue?: string;
      };
  cacheIdentity: CacheIdentitySnapshot;
  turnStateAvailableAtStart: boolean;
  turnStateRevisionAtStart: number;
  turnStateValueAtStart?: string;
  responseId?: string;
  usage?: CodexCacheUsageDiagnostic;
}): CodexTransportRequestDiagnostic {
  const metadata = isObject(options.body.client_metadata)
    ? options.body.client_metadata
    : undefined;
  const turnStateReceived =
    (options.requestOptions.turnState?.revision ?? options.turnStateRevisionAtStart) >
    options.turnStateRevisionAtStart;
  const currentTurnStateValue = options.requestOptions.turnState?.replayValue();
  const routingHint = codexRoutingHint(options.body);
  return {
    type: "codex_transport_request",
    timestamp: Date.now(),
    details: {
      requestKind: options.requestOptions.requestKind ?? "turn",
      configuredTransport: options.configuredTransport,
      selectedTransport: options.selectedTransport,
      ...("connection" in options.attempt ? { connection: options.attempt.connection } : {}),
      contextMode: options.attempt.contextMode,
      inputItems: options.attempt.inputItems,
      fullInputItems: options.attempt.fullInputItems,
      fullRequestBytes: options.attempt.fullRequestBytes,
      wireRequestBytes: options.attempt.wireRequestBytes,
      cacheAffinityEnabled: cacheAffinityEnabled(options.cacheIdentity),
      promptKeyAndHeaderAligned: promptKeyAndHeaderAligned(options.cacheIdentity),
      cacheIdentity: options.cacheIdentity,
      ...(options.requestOptions.sessionId ? { sessionId: options.requestOptions.sessionId } : {}),
      ...(typeof options.body.prompt_cache_key === "string"
        ? { promptCacheKey: options.body.prompt_cache_key }
        : {}),
      accountId: options.cacheIdentity.accountId,
      ...(typeof metadata?.["session_id"] === "string"
        ? { clientSessionId: metadata["session_id"] }
        : {}),
      ...(typeof metadata?.["thread_id"] === "string" ? { threadId: metadata["thread_id"] } : {}),
      ...(typeof metadata?.["turn_id"] === "string" ? { turnId: metadata["turn_id"] } : {}),
      ...(typeof metadata?.[CODEX_INSTALLATION_ID_METADATA_KEY] === "string"
        ? { installationId: metadata[CODEX_INSTALLATION_ID_METADATA_KEY] }
        : {}),
      ...(typeof metadata?.[CODEX_WINDOW_ID_HEADER] === "string"
        ? { windowId: metadata[CODEX_WINDOW_ID_HEADER] }
        : {}),
      ...(routingHint ? { routingHint } : {}),
      ...(typeof metadata?.["x-codex-turn-metadata"] === "string"
        ? { turnMetadata: metadata["x-codex-turn-metadata"] }
        : {}),
      ...(options.responseId ? { responseId: options.responseId } : {}),
      ...("previousResponseId" in options.attempt && options.attempt.previousResponseId
        ? { previousResponseId: options.attempt.previousResponseId }
        : {}),
      turnStateAvailableAtStart: options.turnStateAvailableAtStart,
      turnStateReplayed: options.attempt.turnStateReplayed ?? false,
      turnStateReceived,
      ...(options.turnStateValueAtStart ? { turnStateAtStart: options.turnStateValueAtStart } : {}),
      ...(options.attempt.turnStateReplayedValue
        ? { turnStateReplayedValue: options.attempt.turnStateReplayedValue }
        : {}),
      ...(turnStateReceived && currentTurnStateValue
        ? { turnStateReceivedValue: currentTurnStateValue }
        : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.requestOptions.cacheDiagnostics
        ? { cache: options.requestOptions.cacheDiagnostics }
        : {}),
    },
  };
}

export function shouldReportRequestDiagnostic(options: CodexTransportOptions): boolean {
  return options.cacheDiagnostics !== undefined || options.turnState !== undefined;
}
