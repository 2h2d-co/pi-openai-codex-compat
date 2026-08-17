import type {
  OpenAICodexResponsesOptions,
  ProviderEnv,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { CodexCacheDiagnosticContext } from "../codex-cache-diagnostics.ts";
import type { CodexRequestKind } from "../codex-metadata.ts";
import type { JsonRecord } from "../codex-protocol.ts";
import type { CodexTurnState } from "./codex-transport-turn-state.ts";

export type CodexJsonRequestOptions = {
  apiKey: string;
  headers?: ProviderHeaders;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};

export type CodexTransportFailureDiagnostic = {
  type: "provider_transport_failure";
  timestamp: number;
  error: {
    name?: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
  details: {
    configuredTransport: string;
    fallbackTransport?: "sse";
    eventsEmitted: boolean;
    phase: "before_message_stream_start" | "after_message_stream_start";
    requestBytes: number;
  };
};

export type CodexContinuationBypassReason =
  | "request_template_changed"
  | "non_array_input"
  | "history_prefix_changed";

export type CodexContinuationHistoryMismatch = {
  index: number;
  baselineInputItems: number;
  currentInputItems: number;
  baselineItem?: unknown;
  currentItem?: unknown;
};

export type CodexTransportRecoveryAttempt = {
  transport: "websocket" | "sse";
  connection?: "new" | "reused";
  contextMode: "full" | "delta";
  inputItems: number;
  fullInputItems: number;
  fullRequestBytes: number;
  wireRequestBytes: number;
  outcome: "selected" | "previous_response_not_found" | "retry_scheduled";
  turnStateReplayed?: boolean;
  turnStateReplayedValue?: string;
};

export type CodexTransportRecoveryDiagnostic = {
  type: "codex_transport_recovery";
  timestamp: number;
  details: {
    trigger:
      | "previous_response_not_found"
      | "local_continuation_bypass"
      | "websocket_retry"
      | "sse_stream_retry"
      | "sse_after_websocket_failure"
      | "sticky_sse_after_websocket_failure";
    configuredTransport: string;
    previousResponseId?: string;
    continuationBypassReason?: CodexContinuationBypassReason;
    historyMismatch?: CodexContinuationHistoryMismatch;
    error?: CodexTransportFailureDiagnostic["error"];
    attempts: CodexTransportRecoveryAttempt[];
    cacheIdentity: CacheIdentitySnapshot;
    previousCacheIdentity?: CacheIdentitySnapshot;
    cacheAffinityEnabled: boolean;
    cacheIdentityPreserved?: boolean;
    promptKeyAndHeaderAligned: boolean;
    accountIdentityPreserved?: boolean;
    retryNumber?: number;
    maxRetries?: number;
  };
};

export type CodexTransportPrewarmDiagnostic = {
  type: "codex_transport_prewarm";
  timestamp: number;
  details: {
    outcome: "completed" | "failed" | "skipped";
    continuationReady: boolean;
    reason?: "sse_configured" | "sticky_sse_fallback";
    cache?: CodexCacheDiagnosticContext;
    turnStateAvailableAtStart?: boolean;
    turnStateReceived?: boolean;
    turnStateAtStart?: string;
    turnStateReceivedValue?: string;
  };
};

export type CodexCacheUsageDiagnostic = {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
};

export type CodexTransportRequestDiagnostic = {
  type: "codex_transport_request";
  timestamp: number;
  details: {
    requestKind: CodexRequestKind;
    configuredTransport: string;
    selectedTransport: "websocket" | "sse";
    connection?: "new" | "reused";
    contextMode: "full" | "delta";
    inputItems: number;
    fullInputItems: number;
    fullRequestBytes: number;
    wireRequestBytes: number;
    cacheAffinityEnabled: boolean;
    promptKeyAndHeaderAligned: boolean;
    cacheIdentity: CacheIdentitySnapshot;
    sessionId?: string;
    promptCacheKey?: string;
    accountId: string;
    clientSessionId?: string;
    threadId?: string;
    turnId?: string;
    installationId?: string;
    windowId?: string;
    routingHint?: string;
    turnMetadata?: string;
    responseId?: string;
    previousResponseId?: string;
    turnStateAvailableAtStart: boolean;
    turnStateReplayed: boolean;
    turnStateReceived: boolean;
    turnStateAtStart?: string;
    turnStateReplayedValue?: string;
    turnStateReceivedValue?: string;
    usage?: CodexCacheUsageDiagnostic;
    cache?: CodexCacheDiagnosticContext;
  };
};

export type CodexTransportDiagnostic =
  | CodexTransportFailureDiagnostic
  | CodexTransportRecoveryDiagnostic
  | CodexTransportPrewarmDiagnostic
  | CodexTransportRequestDiagnostic;

export type CodexContinuationHandle = {
  readonly responseId: string;
  replaceResponseItems(items: readonly JsonRecord[]): boolean;
};

export type CodexWebSocketResponseHandle = {
  discard(): boolean;
  failParsing(error: unknown): boolean;
};

export interface OpenAICodexWebSocketDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  storeTrueRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
  lastPreviousResponseId?: string;
  websocketFailures: number;
  sseFallbacks: number;
  prewarmRequests: number;
  websocketFallbackActive?: boolean;
  lastWebSocketError?: string;
}

export type CodexTransportOptions = OpenAICodexResponsesOptions & {
  accountId?: string;
  env?: ProviderEnv;
  onContinuationReady?(handle: CodexContinuationHandle): void;
  onWebSocketResponseHandle?(handle: CodexWebSocketResponseHandle): void;
  onTransportStart?(): void;
  onTransportDiagnostic?(diagnostic: CodexTransportDiagnostic): void;
  warmup?: boolean;
  requestKind?: CodexRequestKind;
  turnState?: CodexTurnState;
  cacheDiagnostics?: CodexCacheDiagnosticContext;
  websocketMaxRetries?: number;
  websocketRetryBaseDelayMs?: number;
  sseStreamMaxRetries?: number;
  sseStreamRetryBaseDelayMs?: number;
};

export type WebSocketEventType = "open" | "message" | "error" | "close";

export type WebSocketListener = (event: unknown) => void;

export interface WebSocketLike {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

export type CachedWebSocket = {
  socket: WebSocketLike;
  busy: boolean;
  continuation?: {
    lastRequestBody: JsonRecord;
    lastResponseId: string;
    lastResponseItems: JsonRecord[];
  };
};

export type CacheIdentitySnapshot = {
  promptCacheKey: string | undefined;
  sessionHeader: string | null;
  threadHeader: string | null;
  clientRequestHeader: string | null;
  installationId?: string;
  windowId?: string;
  routingHint: string | null;
  accountId: string;
};

export type WebSocketFallbackSession = {
  cacheIdentity: CacheIdentitySnapshot;
};

export type CachedRequestDecision = {
  body: JsonRecord;
  contextMode: "full" | "delta";
  previousResponseId?: string;
  bypassReason?: CodexContinuationBypassReason;
  historyMismatch?: CodexContinuationHistoryMismatch;
  cacheIdentityPreserved?: boolean;
};

export type CodexWebSocketAttempt = {
  connection: "new" | "reused";
  contextMode: "full" | "delta";
  inputItems: number;
  fullInputItems: number;
  fullRequestBytes: number;
  wireRequestBytes: number;
  previousResponseId?: string;
  bypassReason?: CodexContinuationBypassReason;
  historyMismatch?: CodexContinuationHistoryMismatch;
  cacheIdentityPreserved?: boolean;
  turnStateReplayed?: boolean;
  turnStateReplayedValue?: string;
};
