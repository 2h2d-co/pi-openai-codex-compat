import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import {
  registerSessionResourceCleanup,
  type Model,
  type OpenAICodexResponsesOptions,
  type ProviderEnv,
  type ProviderHeaders,
  uuidv7,
} from "@earendil-works/pi-ai";
import { codexCacheKey } from "./codex-cache-key.ts";
import type { CodexCacheDiagnosticContext } from "./codex-cache-diagnostics.ts";
import {
  applyCodexMetadataHeaders,
  CODEX_INSTALLATION_ID_METADATA_KEY,
  CODEX_WINDOW_ID_HEADER,
  type CodexRequestKind,
} from "./codex-metadata.ts";
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { normalizeReplayItem, stableResponsesJson } from "./responses-replay.ts";
import { applyResponsesLiteHeaders, responsesLiteSsePayload } from "./responses-lite.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.84.1
 * src/api/openai-codex-responses.ts transport behavior.
 */

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
export const CODEX_WS_REQUEST_START_METADATA_KEY = "x-codex-ws-stream-request-start-ms";
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 200;
const DEFAULT_WEBSOCKET_MAX_RETRIES = 5;
const DEFAULT_WEBSOCKET_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_SSE_STREAM_MAX_RETRIES = 5;
const DEFAULT_SSE_STREAM_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";

type ProcessWithBuiltinModules = typeof process & {
  getBuiltinModule?: {
    (id: "node:os"): typeof NodeOs;
    (id: "node:zlib"): typeof NodeZlib;
  };
};

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

type CodexContinuationHistoryMismatch = {
  index: number;
  baselineInputItems: number;
  currentInputItems: number;
  baselineItem?: unknown;
  currentItem?: unknown;
};

type CodexTransportRecoveryAttempt = {
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

/**
 * In-memory, turn-scoped server routing state. Diagnostics read the value
 * explicitly so it is visible only where the transport records it deliberately.
 */
export class CodexTurnState {
  #value: string | undefined;
  #revision = 0;

  get available(): boolean {
    return this.#value !== undefined;
  }

  get revision(): number {
    return this.#revision;
  }

  replayValue(): string | undefined {
    return this.#value;
  }

  capture(value: string | undefined): boolean {
    if (this.#value !== undefined || !value) return false;
    this.#value = value;
    this.#revision += 1;
    return true;
  }
}

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

type CodexTransportOptions = OpenAICodexResponsesOptions & {
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

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

type CachedWebSocket = {
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

type WebSocketFallbackSession = {
  cacheIdentity: CacheIdentitySnapshot;
};

const websocketSessions = new Map<string, Map<string, CachedWebSocket>>();
const websocketFallbackSessions = new Map<string, WebSocketFallbackSession>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
  let stats = websocketDebugStats.get(sessionId);
  if (!stats) {
    stats = {
      requests: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      cachedContextRequests: 0,
      storeTrueRequests: 0,
      fullContextRequests: 0,
      deltaRequests: 0,
      lastInputItems: 0,
      websocketFailures: 0,
      sseFallbacks: 0,
      prewarmRequests: 0,
    };
    websocketDebugStats.set(sessionId, stats);
  }
  return stats;
}

export function getOpenAICodexWebSocketDebugStats(
  sessionId: string,
): OpenAICodexWebSocketDebugStats | undefined {
  const stats = websocketDebugStats.get(sessionId);
  return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
  if (sessionId) {
    websocketDebugStats.delete(sessionId);
    websocketFallbackSessions.delete(sessionId);
    return;
  }
  websocketDebugStats.clear();
  websocketFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocket): void => {
    closeSocket(entry.socket, "debug_close");
  };
  if (sessionId) {
    for (const entry of websocketSessions.get(sessionId)?.values() ?? []) closeEntry(entry);
    websocketSessions.delete(sessionId);
    websocketFallbackSessions.delete(sessionId);
    const stats = websocketDebugStats.get(sessionId);
    if (stats?.websocketFallbackActive !== undefined) stats.websocketFallbackActive = false;
    return;
  }
  for (const accountEntries of websocketSessions.values()) {
    for (const entry of accountEntries.values()) closeEntry(entry);
  }
  websocketSessions.clear();
  websocketFallbackSessions.clear();
  for (const stats of websocketDebugStats.values()) {
    if (stats.websocketFallbackActive !== undefined) stats.websocketFallbackActive = false;
  }
}

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketFallbackSessions.has(sessionId) : false;
}

function webSocketFallbackSession(
  sessionId: string | undefined,
): WebSocketFallbackSession | undefined {
  return sessionId ? websocketFallbackSessions.get(sessionId) : undefined;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
  if (!sessionId) return;
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.sseFallbacks += 1;
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(
  sessionId: string | undefined,
  error: unknown,
  cacheIdentity: CacheIdentitySnapshot,
): void {
  if (!sessionId) return;
  websocketFallbackSessions.set(sessionId, { cacheIdentity });
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.websocketFailures += 1;
  stats.lastWebSocketError = thrownMessage(error);
  stats.websocketFallbackActive = true;
}

class CodexApiError extends Error {
  readonly code: string | undefined;
  readonly payload: JsonRecord;

  constructor(message: string, code: string | undefined, payload: JsonRecord) {
    super(message);
    this.name = "CodexApiError";
    this.code = code;
    this.payload = payload;
  }
}

class CodexProtocolError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown, cause: unknown) {
    super(message, { cause });
    this.name = "CodexProtocolError";
    this.payload = payload;
  }
}

class CodexHttpError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CodexHttpError";
    this.retryable = retryable;
  }
}

class WebSocketCloseError extends Error {
  readonly code: number | undefined;
  readonly reason: string | undefined;
  readonly wasClean: boolean | undefined;

  constructor(
    message: string,
    options: {
      code: number | undefined;
      reason: string | undefined;
      wasClean: boolean | undefined;
    },
  ) {
    super(message);
    this.name = "WebSocketCloseError";
    this.code = options.code;
    this.reason = options.reason;
    this.wasClean = options.wasClean;
  }
}

function nodeOs(): typeof NodeOs | undefined {
  const currentProcess = process as ProcessWithBuiltinModules;
  return currentProcess.getBuiltinModule?.("node:os");
}

function nodeZlib(): typeof NodeZlib | undefined {
  const currentProcess = process as ProcessWithBuiltinModules;
  return currentProcess.getBuiltinModule?.("node:zlib");
}

function extractWebSocketError(event: unknown): Error {
  if (isObject(event)) {
    if (typeof event["message"] === "string" && event["message"].length > 0) {
      return new Error(event["message"]);
    }
    const nestedError = event["error"];
    if (nestedError instanceof Error && nestedError.message.length > 0) return nestedError;
    if (
      isObject(nestedError) &&
      typeof nestedError["message"] === "string" &&
      nestedError["message"].length > 0
    ) {
      return new Error(nestedError["message"]);
    }
  }
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(
  event: unknown,
  context = "WebSocket closed",
): WebSocketCloseError {
  const code = isObject(event) && typeof event["code"] === "number" ? event["code"] : undefined;
  let reason =
    isObject(event) && typeof event["reason"] === "string" && event["reason"].length > 0
      ? event["reason"]
      : undefined;
  if (reason === undefined && code === 1_009) reason = "message too big";
  const wasClean =
    isObject(event) && typeof event["wasClean"] === "boolean" ? event["wasClean"] : undefined;
  const details = [
    code === undefined ? undefined : `code ${code}`,
    reason === undefined ? undefined : `reason: ${reason}`,
    wasClean === undefined ? undefined : `wasClean: ${String(wasClean)}`,
  ].filter((detail): detail is string => detail !== undefined);
  return new WebSocketCloseError(
    details.length > 0 ? `${context} (${details.join(", ")})` : context,
    { code, reason, wasClean },
  );
}

function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function isCodexNonTransportError(error: unknown): boolean {
  return (
    error instanceof CodexApiError ||
    error instanceof CodexHttpError ||
    error instanceof CodexProtocolError
  );
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function diagnosticError(error: unknown): CodexTransportFailureDiagnostic["error"] {
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

function transportDiagnostic(
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

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryBackoffMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) return 0;
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.floor(exponential * jitter);
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeoutMs: ${String(value)}`);
  }
  return Math.floor(value);
}

function normalizeRetryCount(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`Invalid ${name}: ${String(resolved)}`);
  }
  return Math.floor(resolved);
}

function isTerminalRateLimitError(errorText: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|usage_limit_reached|usage_not_included|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorText,
  );
}

function retryDelayMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const milliseconds = Number(retryAfterMs);
    if (Number.isFinite(milliseconds)) return Math.max(0, milliseconds);
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

class RetryDelayExceededError extends Error {}
class SseStreamIncompleteError extends Error {}

function validateRetryDelay(delayMs: number, options: CodexTransportOptions): number {
  const maximum = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maximum > 0 && delayMs > maximum) {
    throw new RetryDelayExceededError(
      `Server requested ${Math.ceil(delayMs / 1_000)}s retry delay (max: ${Math.ceil(maximum / 1_000)}s)`,
    );
  }
  return delayMs;
}

function codexHttpError(status: number, statusText: string, raw: string): CodexHttpError {
  let message = raw || statusText || "Request failed";
  let friendlyMessage: string | undefined;
  const retryable = isRetryable(status, raw);
  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        type?: string;
        message?: string;
        plan_type?: string;
        resets_at?: number;
      };
    };
    const error = parsed?.error;
    if (!error) return new CodexHttpError(message, retryable);
    const code = error.code || error.type || "";
    if (
      status === 429 ||
      /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)
    ) {
      const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
      const resetMinutes = error.resets_at
        ? Math.max(0, Math.round((error.resets_at * 1_000 - Date.now()) / 60_000))
        : undefined;
      const reset = resetMinutes === undefined ? "" : ` Try again in ~${String(resetMinutes)} min.`;
      friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${reset}`.trim();
    }
    message = error.message || friendlyMessage || message;
  } catch {}
  return new CodexHttpError(friendlyMessage || message, retryable);
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal?: AbortSignal;
  cleanup(): void;
} {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return { cleanup() {} };
  if (active.length === 1) {
    const signal = active[0];
    return signal ? { signal, cleanup() {} } : { cleanup() {} };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

function webSocketRecoveryAttempt(
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

function sseRecoveryAttempt(
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

function transportRecoveryDiagnostic(options: {
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

function cacheUsageDiagnostic(event: JsonRecord): CodexCacheUsageDiagnostic | undefined {
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

function transportRequestDiagnostic(options: {
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

function shouldReportRequestDiagnostic(options: CodexTransportOptions): boolean {
  return options.cacheDiagnostics !== undefined || options.turnState !== undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function applyTurnStateHeader(
  headers: Headers,
  turnState: CodexTurnState | undefined,
): string | undefined {
  if (!turnState) return undefined;
  const value = turnState?.replayValue();
  if (!value) {
    headers.delete(CODEX_TURN_STATE_HEADER);
    return undefined;
  }
  headers.set(CODEX_TURN_STATE_HEADER, value);
  return value;
}

function codexRoutingHint(body: JsonRecord): string | undefined {
  if (typeof body.model !== "string" || body.model.length === 0) return undefined;
  const tier =
    typeof body.service_tier === "string" && body.service_tier.length > 0
      ? `;tier=${body.service_tier}`
      : "";
  return `model=${body.model}${tier}`;
}

function applyCodexRoutingHint(headers: Headers, body: JsonRecord): void {
  const hint = codexRoutingHint(body);
  if (!hint) {
    headers.delete(CODEX_ROUTING_HINT_HEADER);
    return;
  }
  headers.set(CODEX_ROUTING_HINT_HEADER, hint);
}

function captureTurnStateHeader(headers: Headers, turnState: CodexTurnState | undefined): boolean {
  return turnState?.capture(headers.get(CODEX_TURN_STATE_HEADER) ?? undefined) ?? false;
}

function captureTurnStateEvent(event: JsonRecord, turnState: CodexTurnState | undefined): boolean {
  if (event.type !== "response.metadata" || !isObject(event["headers"])) return false;
  for (const [name, value] of Object.entries(event["headers"])) {
    if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && typeof value === "string") {
      return turnState?.capture(value) ?? false;
    }
  }
  return false;
}

function withTurnStateMetadata(
  body: JsonRecord,
  turnState: CodexTurnState | undefined,
): { body: JsonRecord; replayedValue?: string } {
  const value = turnState?.replayValue();
  if (!value) return { body };
  return {
    body: {
      ...body,
      client_metadata: {
        ...(isObject(body.client_metadata) ? body.client_metadata : {}),
        [CODEX_TURN_STATE_HEADER]: value,
      },
    },
    replayedValue: value,
  };
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JsonRecord;
    const authentication = payload["https://api.openai.com/auth"];
    if (
      !isObject(authentication) ||
      typeof authentication["chatgpt_account_id"] !== "string" ||
      authentication["chatgpt_account_id"].length === 0
    ) {
      throw new Error("No account ID");
    }
    return authentication["chatgpt_account_id"];
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

export function validateCodexAuthentication(model: Model<any>, apiKey: string | undefined): string {
  if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  return extractAccountId(apiKey);
}

function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export function resolveCodexApiUrl(baseUrl: string | undefined, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  const responsesUrl = resolveCodexUrl(baseUrl);
  return `${responsesUrl.slice(0, -"/responses".length)}/${normalizedPath}`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

function baseHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  const os = nodeOs();
  headers.set(
    "User-Agent",
    os ? `pi (${os.platform()} ${os.release()}; ${os.arch()})` : "pi (browser)",
  );
  return headers;
}

function sseHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  sessionId: string | undefined,
  body: JsonRecord,
): Headers {
  const headers = baseHeaders(modelHeaders, additionalHeaders, accountId, token);
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (sessionId) {
    headers.set("session-id", sessionId);
  }
  applyCodexMetadataHeaders(headers, body);
  if (sessionId && !headers.has("thread-id")) headers.set("thread-id", sessionId);
  const threadId = headers.get("thread-id");
  if (threadId) {
    // Official Responses HTTP uses the thread identity as x-client-request-id.
    headers.set("x-client-request-id", threadId);
  }
  applyResponsesLiteHeaders(headers, body);
  applyCodexRoutingHint(headers, body);
  return headers;
}

function jsonHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  extraHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = baseHeaders(modelHeaders, additionalHeaders, accountId, token);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

function websocketHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  requestId: string,
  body: JsonRecord,
): Headers {
  const headers = baseHeaders(modelHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session-id", requestId);
  applyCodexMetadataHeaders(headers, body);
  if (!headers.has("thread-id")) headers.set("thread-id", requestId);
  const threadId = headers.get("thread-id");
  if (threadId) headers.set("x-client-request-id", threadId);
  applyCodexRoutingHint(headers, body);
  return headers;
}

function cacheIdentitySnapshot(
  body: JsonRecord,
  headers: Headers,
  accountId: string,
): CacheIdentitySnapshot {
  const metadata = isObject(body.client_metadata) ? body.client_metadata : undefined;
  return {
    promptCacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
    sessionHeader: headers.get("session-id"),
    threadHeader: headers.get("thread-id"),
    clientRequestHeader: headers.get("x-client-request-id"),
    ...(typeof metadata?.[CODEX_INSTALLATION_ID_METADATA_KEY] === "string"
      ? { installationId: metadata[CODEX_INSTALLATION_ID_METADATA_KEY] }
      : {}),
    ...(typeof metadata?.[CODEX_WINDOW_ID_HEADER] === "string"
      ? { windowId: metadata[CODEX_WINDOW_ID_HEADER] }
      : {}),
    routingHint: headers.get(CODEX_ROUTING_HINT_HEADER),
    accountId,
  };
}

function cacheAffinityEnabled(identity: CacheIdentitySnapshot): boolean {
  return Boolean(identity.promptCacheKey || identity.sessionHeader || identity.clientRequestHeader);
}

function promptKeyAndHeaderAligned(identity: CacheIdentitySnapshot): boolean {
  return Boolean(
    identity.promptCacheKey &&
    identity.promptCacheKey === identity.sessionHeader &&
    identity.promptCacheKey === identity.threadHeader &&
    identity.promptCacheKey === identity.clientRequestHeader,
  );
}

function sameCacheIdentity(a: CacheIdentitySnapshot, b: CacheIdentitySnapshot): boolean {
  return (
    a.promptCacheKey === b.promptCacheKey &&
    a.sessionHeader === b.sessionHeader &&
    a.threadHeader === b.threadHeader &&
    a.clientRequestHeader === b.clientRequestHeader &&
    a.installationId === b.installationId &&
    a.windowId === b.windowId &&
    a.routingHint === b.routingHint
  );
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compressBody(body: string): Uint8Array | undefined {
  const zlib = nodeZlib();
  if (!zlib || typeof zlib.zstdCompressSync !== "function") return undefined;
  try {
    const compressed = zlib.zstdCompressSync(body, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
    });
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  } catch {
    return undefined;
  }
}

function isRetryable(status: number, text: string): boolean {
  if (status === 429 && isTerminalRateLimitError(text)) return false;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    text,
  );
}

async function* parseSse(response: Response, signal?: AbortSignal): AsyncGenerator<JsonRecord> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("Request was aborted");
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data) as unknown;
          } catch (error) {
            throw new CodexProtocolError(
              `Invalid Codex SSE JSON: ${thrownMessage(error)}`,
              data,
              error,
            );
          }
          if (!isObject(parsed)) throw new Error("Invalid Codex SSE event");
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  }
}

function websocketConstructor(): WebSocketConstructor | undefined {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof candidate === "function" ? (candidate as WebSocketConstructor) : undefined;
}

function closeSocket(socket: WebSocketLike, reason = "done"): void {
  try {
    socket.close(1_000, reason);
  } catch {}
}

function socketReusable(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<WebSocketLike> {
  const WebSocketClass = websocketConstructor();
  if (!WebSocketClass) {
    throw new Error("WebSocket transport is not available in this runtime");
  }
  const requestHeaders = headersToRecord(headers);
  delete requestHeaders["OpenAI-Beta"];

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error, closeReason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(socket, closeReason);
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: unknown) => fail(extractWebSocketError(event), "connect_failure");
    const onClose = (event: unknown) =>
      fail(extractWebSocketCloseError(event, "WebSocket closed during connect"), "connect_failure");
    const onAbort = () => fail(new Error("Request was aborted"), "aborted");

    try {
      socket = new WebSocketClass(url, { headers: requestHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`), "connect_timeout"),
        timeoutMs,
      );
    }
    if (signal?.aborted) onAbort();
  });
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  accountId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{
  socket: WebSocketLike;
  entry?: CachedWebSocket;
  reused: boolean;
  release(keep: boolean): void;
}> {
  if (signal?.aborted) throw new Error("Request was aborted");
  if (sessionId) {
    let accountEntries = websocketSessions.get(sessionId);
    const cached = accountEntries?.get(accountId);
    if (cached && !cached.busy && socketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release(keep) {
          if (!keep || !socketReusable(cached.socket)) {
            closeSocket(cached.socket);
            const currentEntries = websocketSessions.get(sessionId);
            if (currentEntries?.get(accountId) === cached) currentEntries.delete(accountId);
            if (currentEntries?.size === 0) websocketSessions.delete(sessionId);
            return;
          }
          cached.busy = false;
        },
      };
    }
    if (cached && !cached.busy) {
      closeSocket(cached.socket, "done");
      accountEntries?.delete(accountId);
      if (accountEntries?.size === 0) websocketSessions.delete(sessionId);
    }
    if (cached?.busy) {
      const socket = await connectWebSocket(url, headers, signal, timeoutMs);
      return { socket, reused: false, release: () => closeSocket(socket) };
    }

    const socket = await connectWebSocket(url, headers, signal, timeoutMs);
    const entry: CachedWebSocket = { socket, busy: true };
    accountEntries = websocketSessions.get(sessionId);
    if (!accountEntries) {
      accountEntries = new Map();
      websocketSessions.set(sessionId, accountEntries);
    }
    accountEntries.set(accountId, entry);
    return {
      socket,
      entry,
      reused: false,
      release(keep) {
        if (!keep || !socketReusable(socket)) {
          closeSocket(socket);
          const currentEntries = websocketSessions.get(sessionId);
          if (currentEntries?.get(accountId) === entry) currentEntries.delete(accountId);
          if (currentEntries?.size === 0) websocketSessions.delete(sessionId);
          return;
        }
        entry.busy = false;
      },
    };
  }

  const socket = await connectWebSocket(url, headers, signal, timeoutMs);
  return { socket, reused: false, release: () => closeSocket(socket) };
}

function requestWithoutHistory(body: JsonRecord): JsonRecord {
  const result = { ...body };
  delete result.input;
  delete result.previous_response_id;
  delete result.client_metadata;
  // This controls response delivery only, not the model context retained by
  // previous_response_id.
  delete result["stream_options"];
  return result;
}

function responseItemsMatch(previous: unknown, current: unknown): boolean {
  if (!isObject(previous) || !isObject(current)) {
    return stableResponsesJson(previous) === stableResponsesJson(current);
  }
  const previousComparable = structuredClone(previous);
  const currentComparable = structuredClone(current);
  delete previousComparable["internal_chat_message_metadata_passthrough"];
  delete currentComparable["internal_chat_message_metadata_passthrough"];
  return stableResponsesJson(previousComparable) === stableResponsesJson(currentComparable);
}

function jsonWireRequestBody(body: JsonRecord): JsonRecord {
  const snapshot = JSON.parse(JSON.stringify(body)) as unknown;
  if (!isObject(snapshot)) {
    throw new Error("Codex request body must serialize to a JSON object");
  }
  return snapshot;
}

type CachedRequestDecision = {
  body: JsonRecord;
  contextMode: "full" | "delta";
  previousResponseId?: string;
  bypassReason?: CodexContinuationBypassReason;
  historyMismatch?: CodexContinuationHistoryMismatch;
  cacheIdentityPreserved?: boolean;
};

type CodexWebSocketAttempt = {
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

function cachedRequestBody(entry: CachedWebSocket, body: JsonRecord): CachedRequestDecision {
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

function requestInputLength(body: JsonRecord): number {
  return typeof body.input === "string" || Array.isArray(body.input) ? body.input.length : 0;
}

function webSocketEventStartsVisibleOutput(event: JsonRecord): boolean {
  return (
    event.type !== "response.created" &&
    event.type !== "response.queued" &&
    event.type !== "response.in_progress" &&
    event.type !== "response.metadata"
  );
}

async function decodeWebSocketData(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (isObject(data) && typeof data["arrayBuffer"] === "function") {
    const arrayBuffer = await (data["arrayBuffer"] as () => Promise<ArrayBuffer>)();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return undefined;
}

async function* parseWebSocket(
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

function normalizeEvent(event: JsonRecord): JsonRecord | undefined {
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) return undefined;
  if (type === "error") {
    const nested = isObject(event["error"]) ? event["error"] : undefined;
    const code =
      typeof event["code"] === "string"
        ? event["code"]
        : typeof nested?.["code"] === "string"
          ? nested["code"]
          : undefined;
    const message =
      typeof event["message"] === "string"
        ? event["message"]
        : typeof nested?.["message"] === "string"
          ? nested["message"]
          : undefined;
    throw new CodexApiError(
      `Codex error: ${message || code || JSON.stringify(event)}`,
      code,
      event,
    );
  }
  if (type === "response.done") {
    return { ...event, type: "response.completed" };
  }
  return event;
}

function isTerminalEvent(event: JsonRecord): boolean {
  return (
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed"
  );
}

async function* requestSse(
  model: Model<any>,
  bodyJson: string,
  options: CodexTransportOptions,
  headers: Headers,
  timeoutMs: number | undefined,
  onAttempt: (turnStateReplayedValue: string | undefined) => void,
): AsyncGenerator<JsonRecord> {
  const compressed = compressBody(bodyJson);
  if (compressed) headers.set("content-encoding", "zstd");
  const requestBody = compressed ?? bodyJson;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) throw new Error("Request was aborted");
    try {
      onAttempt(applyTurnStateHeader(headers, options.turnState));
      const timeoutSignal =
        timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const combined = combineAbortSignals([options.signal, timeoutSignal]);
      try {
        try {
          response = await (options.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers,
            body: requestBody,
            ...(combined.signal ? { signal: combined.signal } : {}),
          });
        } catch (error) {
          if (timeoutSignal?.aborted && !options.signal?.aborted) {
            throw new Error(`Codex SSE response headers timed out after ${String(timeoutMs)}ms`);
          }
          throw error;
        }
      } finally {
        combined.cleanup();
      }
      captureTurnStateHeader(response.headers, options.turnState);
      await options.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      if (response.ok) break;

      const errorText = await response.text();
      if (attempt < maxRetries && isRetryable(response.status, errorText)) {
        const requestedDelay = retryDelayMs(response.headers);
        const delay =
          requestedDelay === undefined
            ? retryBackoffMs(BASE_DELAY_MS, attempt + 1)
            : validateRetryDelay(requestedDelay, options);
        await sleep(delay, options.signal);
        continue;
      }
      throw codexHttpError(response.status, response.statusText, errorText);
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.message === "Request was aborted"))
      ) {
        throw new Error("Request was aborted");
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < maxRetries &&
        !(lastError instanceof CodexHttpError) &&
        !(lastError instanceof RetryDelayExceededError) &&
        !lastError.message.includes("usage limit")
      ) {
        await sleep(retryBackoffMs(BASE_DELAY_MS, attempt + 1), options.signal);
        continue;
      }
      throw lastError;
    }
  }

  if (!response?.ok) throw lastError ?? new Error("Failed after retries");
  if (!response.body) throw new Error("No response body");
  options.onTransportStart?.();
  let terminal = false;
  for await (const event of parseSse(response, options.signal)) {
    const normalized = normalizeEvent(event);
    if (!normalized) continue;
    yield normalized;
    if (isTerminalEvent(normalized)) {
      terminal = true;
      break;
    }
  }
  if (!terminal)
    throw new SseStreamIncompleteError("Codex SSE stream ended before a terminal event");
}

async function* requestWebSocket(
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
