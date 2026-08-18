import { isNumber, isString } from "../value-contracts.ts";
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
  const code = "code" in error ? error.code : undefined;
  const diagnostic: CodexTransportFailureDiagnostic["error"] = {
    message: error.message || error.name,
  };
  if (error.name) diagnostic.name = error.name;
  if (error.stack) diagnostic.stack = error.stack;
  if (isString(code) || isNumber(code)) diagnostic.code = code;
  return diagnostic;
}

export function transportDiagnostic(
  error: unknown,
  transport: string,
  emitted: boolean,
  requestBytes: number,
  fallbackSelected = !emitted,
): CodexTransportFailureDiagnostic {
  const details: CodexTransportFailureDiagnostic["details"] = {
    configuredTransport: transport,
    eventsEmitted: emitted,
    phase: emitted ? "after_message_stream_start" : "before_message_stream_start",
    requestBytes,
  };
  if (fallbackSelected) details.fallbackTransport = "sse";
  return {
    type: "provider_transport_failure",
    timestamp: Date.now(),
    error: diagnosticError(error),
    details,
  };
}

export function webSocketRecoveryAttempt(
  attempt: CodexWebSocketAttempt,
  outcome: CodexTransportRecoveryAttempt["outcome"],
): CodexTransportRecoveryAttempt {
  const recoveryAttempt: CodexTransportRecoveryAttempt = {
    transport: "websocket",
    connection: attempt.connection,
    contextMode: attempt.contextMode,
    inputItems: attempt.inputItems,
    fullInputItems: attempt.fullInputItems,
    fullRequestBytes: attempt.fullRequestBytes,
    wireRequestBytes: attempt.wireRequestBytes,
    outcome,
  };
  if (attempt.turnStateReplayed !== undefined) {
    recoveryAttempt.turnStateReplayed = attempt.turnStateReplayed;
  }
  if (attempt.turnStateReplayedValue) {
    recoveryAttempt.turnStateReplayedValue = attempt.turnStateReplayedValue;
  }
  return recoveryAttempt;
}

export function sseRecoveryAttempt(
  body: JsonRecord,
  requestBytes: number,
  turnStateReplayedValue: string | undefined,
): CodexTransportRecoveryAttempt {
  const inputItems = requestInputLength(body);
  const attempt: CodexTransportRecoveryAttempt = {
    transport: "sse",
    contextMode: "full",
    inputItems,
    fullInputItems: inputItems,
    fullRequestBytes: requestBytes,
    wireRequestBytes: requestBytes,
    outcome: "selected",
    turnStateReplayed: turnStateReplayedValue !== undefined,
  };
  if (turnStateReplayedValue) attempt.turnStateReplayedValue = turnStateReplayedValue;
  return attempt;
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
  const details: CodexTransportRecoveryDiagnostic["details"] = {
    trigger: options.trigger,
    configuredTransport: options.configuredTransport,
    attempts: options.attempts,
    cacheIdentity: options.cacheIdentity,
    cacheAffinityEnabled: cacheAffinityEnabled(options.cacheIdentity),
    promptKeyAndHeaderAligned: promptKeyAndHeaderAligned(options.cacheIdentity),
  };
  if (options.previousResponseId) details.previousResponseId = options.previousResponseId;
  if (options.continuationBypassReason) {
    details.continuationBypassReason = options.continuationBypassReason;
  }
  if (options.historyMismatch) details.historyMismatch = options.historyMismatch;
  if (options.error !== undefined) details.error = diagnosticError(options.error);
  if (options.previousCacheIdentity) {
    details.previousCacheIdentity = options.previousCacheIdentity;
  }
  if (options.cacheIdentityPreserved !== undefined) {
    details.cacheIdentityPreserved = options.cacheIdentityPreserved;
  } else if (options.previousCacheIdentity) {
    details.cacheIdentityPreserved = sameCacheIdentity(
      options.previousCacheIdentity,
      options.cacheIdentity,
    );
  }
  if (options.accountIdentityPreserved !== undefined) {
    details.accountIdentityPreserved = options.accountIdentityPreserved;
  } else if (options.previousCacheIdentity) {
    details.accountIdentityPreserved =
      options.previousCacheIdentity.accountId === options.cacheIdentity.accountId;
  }
  if (options.retryNumber !== undefined) details.retryNumber = options.retryNumber;
  if (options.maxRetries !== undefined) details.maxRetries = options.maxRetries;
  return {
    type: "codex_transport_recovery",
    timestamp: Date.now(),
    details,
  };
}

export function cacheUsageDiagnostic(event: JsonRecord): CodexCacheUsageDiagnostic | undefined {
  if (!isTerminalEvent(event) || !isObject(event.response) || !isObject(event.response.usage)) {
    return undefined;
  }
  const usage = event.response.usage;
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  return {
    inputTokens: isNumber(usage.input_tokens) ? usage.input_tokens : 0,
    cachedTokens: isNumber(details?.cached_tokens) ? details.cached_tokens : 0,
    cacheWriteTokens: isNumber(details?.cache_write_tokens) ? details.cache_write_tokens : 0,
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
  const details: CodexTransportRequestDiagnostic["details"] = {
    requestKind: options.requestOptions.requestKind ?? "turn",
    configuredTransport: options.configuredTransport,
    selectedTransport: options.selectedTransport,
    contextMode: options.attempt.contextMode,
    inputItems: options.attempt.inputItems,
    fullInputItems: options.attempt.fullInputItems,
    fullRequestBytes: options.attempt.fullRequestBytes,
    wireRequestBytes: options.attempt.wireRequestBytes,
    cacheAffinityEnabled: cacheAffinityEnabled(options.cacheIdentity),
    promptKeyAndHeaderAligned: promptKeyAndHeaderAligned(options.cacheIdentity),
    cacheIdentity: options.cacheIdentity,
    accountId: options.cacheIdentity.accountId,
    turnStateAvailableAtStart: options.turnStateAvailableAtStart,
    turnStateReplayed: options.attempt.turnStateReplayed ?? false,
    turnStateReceived,
  };
  if ("connection" in options.attempt) details.connection = options.attempt.connection;
  if (options.requestOptions.sessionId) details.sessionId = options.requestOptions.sessionId;
  if (isString(options.body.prompt_cache_key)) {
    details.promptCacheKey = options.body.prompt_cache_key;
  }
  if (isString(metadata?.["session_id"])) details.clientSessionId = metadata["session_id"];
  if (isString(metadata?.["thread_id"])) details.threadId = metadata["thread_id"];
  if (isString(metadata?.["turn_id"])) details.turnId = metadata["turn_id"];
  if (isString(metadata?.[CODEX_INSTALLATION_ID_METADATA_KEY])) {
    details.installationId = metadata[CODEX_INSTALLATION_ID_METADATA_KEY];
  }
  if (isString(metadata?.[CODEX_WINDOW_ID_HEADER])) {
    details.windowId = metadata[CODEX_WINDOW_ID_HEADER];
  }
  if (routingHint) details.routingHint = routingHint;
  if (isString(metadata?.["x-codex-turn-metadata"])) {
    details.turnMetadata = metadata["x-codex-turn-metadata"];
  }
  if (options.responseId) details.responseId = options.responseId;
  if ("previousResponseId" in options.attempt && options.attempt.previousResponseId) {
    details.previousResponseId = options.attempt.previousResponseId;
  }
  if (options.turnStateValueAtStart) details.turnStateAtStart = options.turnStateValueAtStart;
  if (options.attempt.turnStateReplayedValue) {
    details.turnStateReplayedValue = options.attempt.turnStateReplayedValue;
  }
  if (turnStateReceived && currentTurnStateValue) {
    details.turnStateReceivedValue = currentTurnStateValue;
  }
  if (options.usage) details.usage = options.usage;
  if (options.requestOptions.cacheDiagnostics) {
    details.cache = options.requestOptions.cacheDiagnostics;
  }
  return {
    type: "codex_transport_request",
    timestamp: Date.now(),
    details,
  };
}

export function shouldReportRequestDiagnostic(options: CodexTransportOptions): boolean {
  return options.cacheDiagnostics !== undefined || options.turnState !== undefined;
}
