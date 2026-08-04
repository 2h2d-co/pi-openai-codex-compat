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
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { normalizeReplayItem } from "./responses-replay.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.83.0
 * src/api/openai-codex-responses.ts transport behavior.
 */

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1_000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1_000;
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

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

export type CodexTransportDiagnostic = {
  type: "provider_transport_failure";
  timestamp: number;
  error: {
    name: string;
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

export type CodexContinuationHandle = {
  readonly responseId: string;
  replaceResponseItems(items: readonly JsonRecord[]): boolean;
};

type CodexTransportOptions = OpenAICodexResponsesOptions & {
  accountId?: string;
  env?: ProviderEnv;
  onContinuationReady?(handle: CodexContinuationHandle): void;
  onTransportStart?(): void;
  onTransportDiagnostic?(diagnostic: CodexTransportDiagnostic): void;
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
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: {
    lastRequestBody: JsonRecord;
    lastResponseId: string;
    lastResponseItems: JsonRecord[];
  };
};

const websocketSessions = new Map<string, Map<string, CachedWebSocket>>();
const websocketFallbackSessions = new Set<string>();

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
  return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function transportDiagnostic(
  error: unknown,
  transport: string,
  emitted: boolean,
  requestBytes: number,
): CodexTransportDiagnostic {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const code = (normalized as Error & { code?: unknown }).code;
  return {
    type: "provider_transport_failure",
    timestamp: Date.now(),
    error: {
      name: normalized.name || "Error",
      message: normalized.message || normalized.name,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    },
    details: {
      configuredTransport: transport,
      ...(!emitted ? { fallbackTransport: "sse" as const } : {}),
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

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeoutMs: ${String(value)}`);
  }
  return Math.floor(value);
}

function isTerminalRateLimitError(errorText: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
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

function validateRetryDelay(delayMs: number, options: CodexTransportOptions): number {
  const maximum = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maximum > 0 && delayMs > maximum) {
    throw new RetryDelayExceededError(
      `Server requested ${Math.ceil(delayMs / 1_000)}s retry delay (max: ${Math.ceil(maximum / 1_000)}s)`,
    );
  }
  return delayMs;
}

function codexHttpError(status: number, statusText: string, raw: string): Error {
  let message = raw || statusText || "Request failed";
  let friendlyMessage: string | undefined;
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
    if (!error) return new Error(message);
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
  return new Error(friendlyMessage || message);
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

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JsonRecord;
    const authentication = payload["https://api.openai.com/auth"];
    if (!isObject(authentication) || typeof authentication["chatgpt_account_id"] !== "string") {
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

function clampPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const characters = Array.from(key);
  return characters.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
    ? key
    : characters.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
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
): Headers {
  const headers = baseHeaders(modelHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (sessionId) {
    headers.set("session-id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }
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
): Headers {
  const headers = baseHeaders(modelHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session-id", requestId);
  return headers;
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
    reader.releaseLock();
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

function scheduleSocketExpiry(sessionId: string, accountId: string, entry: CachedWebSocket): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeSocket(entry.socket, "idle_timeout");
    const accountEntries = websocketSessions.get(sessionId);
    if (accountEntries?.get(accountId) === entry) accountEntries.delete(accountId);
    if (accountEntries?.size === 0) websocketSessions.delete(sessionId);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<WebSocketLike> {
  const WebSocketClass = websocketConstructor();
  if (!WebSocketClass) throw new Error("WebSocket transport is unavailable");
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
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(socket, "connect_failure");
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: unknown) => fail(extractWebSocketError(event));
    const onClose = (event: unknown) =>
      fail(extractWebSocketCloseError(event, "WebSocket closed during connect"));
    const onAbort = () => fail(new Error("Request was aborted"));

    try {
      socket = new WebSocketClass(url, { headers: requestHeaders });
    } catch (error) {
      reject(error);
      return;
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`)),
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
): Promise<{ socket: WebSocketLike; entry?: CachedWebSocket; release(keep: boolean): void }> {
  if (signal?.aborted) throw new Error("Request was aborted");
  if (sessionId) {
    let accountEntries = websocketSessions.get(sessionId);
    const cached = accountEntries?.get(accountId);
    if (cached?.idleTimer) {
      clearTimeout(cached.idleTimer);
      delete cached.idleTimer;
    }
    const expired = cached && Date.now() - cached.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
    if (cached && !cached.busy && !expired && socketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        release(keep) {
          if (!keep || !socketReusable(cached.socket)) {
            closeSocket(cached.socket);
            const currentEntries = websocketSessions.get(sessionId);
            if (currentEntries?.get(accountId) === cached) currentEntries.delete(accountId);
            if (currentEntries?.size === 0) websocketSessions.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSocketExpiry(sessionId, accountId, cached);
        },
      };
    }
    if (cached && !cached.busy) {
      closeSocket(cached.socket);
      accountEntries?.delete(accountId);
      if (accountEntries?.size === 0) websocketSessions.delete(sessionId);
    }
    if (cached?.busy) {
      const socket = await connectWebSocket(url, headers, signal, timeoutMs);
      return { socket, release: () => closeSocket(socket) };
    }

    const socket = await connectWebSocket(url, headers, signal, timeoutMs);
    const entry: CachedWebSocket = { socket, busy: true, createdAt: Date.now() };
    accountEntries = websocketSessions.get(sessionId);
    if (!accountEntries) {
      accountEntries = new Map();
      websocketSessions.set(sessionId, accountEntries);
    }
    accountEntries.set(accountId, entry);
    return {
      socket,
      entry,
      release(keep) {
        if (!keep || !socketReusable(socket)) {
          closeSocket(socket);
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          const currentEntries = websocketSessions.get(sessionId);
          if (currentEntries?.get(accountId) === entry) currentEntries.delete(accountId);
          if (currentEntries?.size === 0) websocketSessions.delete(sessionId);
          return;
        }
        entry.busy = false;
        scheduleSocketExpiry(sessionId, accountId, entry);
      },
    };
  }

  const socket = await connectWebSocket(url, headers, signal, timeoutMs);
  return { socket, release: () => closeSocket(socket) };
}

function requestWithoutHistory(body: JsonRecord): JsonRecord {
  const result = structuredClone(body);
  delete result.input;
  delete result.previous_response_id;
  return result;
}

function cachedRequestBody(entry: CachedWebSocket, body: JsonRecord): JsonRecord {
  const continuation = entry.continuation;
  if (!continuation) return body;
  if (
    JSON.stringify(requestWithoutHistory(body)) !==
    JSON.stringify(requestWithoutHistory(continuation.lastRequestBody))
  ) {
    delete entry.continuation;
    return body;
  }

  const currentInput = body.input ?? [];
  const previousInput = continuation.lastRequestBody.input ?? [];
  if (!Array.isArray(currentInput) || !Array.isArray(previousInput)) {
    delete entry.continuation;
    return body;
  }
  const baseline = [...previousInput, ...continuation.lastResponseItems];
  if (
    currentInput.length < baseline.length ||
    JSON.stringify(currentInput.slice(0, baseline.length)) !== JSON.stringify(baseline)
  ) {
    delete entry.continuation;
    return body;
  }

  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: currentInput.slice(baseline.length),
  };
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
          type === "response.incomplete"
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
          const timer = setTimeout(
            () => reject(new Error(`WebSocket idle timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
          const priorWake = wake;
          wake = () => {
            clearTimeout(timer);
            priorWake();
          };
        }
      });
    }
    if (failure) throw failure;
    if (!terminal) throw new Error("WebSocket ended without a terminal response");
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
      `Codex error: ${message ?? code ?? JSON.stringify(event)}`,
      code,
      event,
    );
  }
  if (type === "response.failed") {
    const response = isObject(event.response) ? event.response : undefined;
    const error = isObject(response?.["error"]) ? response["error"] : undefined;
    throw new CodexApiError(
      typeof error?.["message"] === "string" ? error["message"] : "Codex response failed",
      typeof error?.["code"] === "string" ? error["code"] : undefined,
      event,
    );
  }
  if (type === "response.done") {
    return { ...event, type: "response.completed" };
  }
  return event;
}

function isTerminalEvent(event: JsonRecord): boolean {
  return event.type === "response.completed" || event.type === "response.incomplete";
}

async function* requestSse(
  model: Model<any>,
  body: JsonRecord,
  options: CodexTransportOptions,
  headers: Headers,
  timeoutMs: number | undefined,
): AsyncGenerator<JsonRecord> {
  const bodyJson = JSON.stringify(body);
  const compressed = compressBody(bodyJson);
  if (compressed) headers.set("content-encoding", "zstd");
  const requestBody = compressed ?? bodyJson;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let response: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) throw new Error("Request was aborted");
    try {
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
            ? BASE_DELAY_MS * 2 ** attempt
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
        !(lastError instanceof RetryDelayExceededError) &&
        !lastError.message.includes("usage limit")
      ) {
        await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
        continue;
      }
      throw lastError;
    }
  }

  if (!response?.ok) throw lastError ?? new Error("Failed after retries");
  if (!response.body) throw new Error("No response body");
  options.onTransportStart?.();
  for await (const event of parseSse(response, options.signal)) {
    const normalized = normalizeEvent(event);
    if (!normalized) continue;
    yield normalized;
    if (isTerminalEvent(normalized)) return;
  }
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
): AsyncGenerator<JsonRecord> {
  const acquired = await acquireWebSocket(
    resolveCodexWebSocketUrl(model.baseUrl),
    headers,
    sessionId,
    accountId,
    options.signal,
    connectTimeoutMs,
  );
  let keep = true;
  try {
    if (options.signal?.aborted) throw new Error("Request was aborted");
    const useContinuation =
      options.transport === "auto" || options.transport === "websocket-cached";
    const requestBody =
      useContinuation && acquired.entry ? cachedRequestBody(acquired.entry, body) : body;
    acquired.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    const responseItems: JsonRecord[] = [];
    let responseId: string | undefined;
    for await (const event of parseWebSocket(acquired.socket, options.signal, timeoutMs)) {
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
          event.type === "response.incomplete") &&
        isObject(event.response)
      ) {
        if (typeof event.response.id === "string") responseId = event.response.id;
        if (Array.isArray(event.response["output"])) {
          const terminalItems = event.response["output"].filter(isObject);
          if (terminalItems.length > 0) {
            responseItems.splice(
              0,
              responseItems.length,
              ...terminalItems.map((item) => structuredClone(item)),
            );
          }
        }
      }
      const normalized = normalizeEvent(event);
      if (!normalized) continue;
      yield normalized;
      if (isTerminalEvent(normalized)) break;
    }
    if (options.signal?.aborted) throw new Error("Request was aborted");
    if (useContinuation && acquired.entry && responseId) {
      const entry = acquired.entry;
      const continuation = {
        lastRequestBody: structuredClone(body),
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
  } catch (error) {
    if (acquired.entry) delete acquired.entry.continuation;
    keep = false;
    throw error;
  } finally {
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
  async *request(
    model: Model<any>,
    body: JsonRecord,
    options: CodexTransportOptions,
  ): AsyncGenerator<JsonRecord> {
    if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const connectTimeoutMs =
      normalizeTimeoutMs(options.websocketConnectTimeoutMs) ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
    const requestBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    const accountId = options.accountId ?? validateCodexAuthentication(model, options.apiKey);
    const cacheSessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
    const requestId = clampPromptCacheKey(cacheSessionId);
    const transport = options.transport ?? "auto";

    const websocketDisabled =
      transport !== "sse" &&
      cacheSessionId !== undefined &&
      websocketFallbackSessions.has(cacheSessionId);
    if (transport !== "sse" && !websocketDisabled) {
      const headers = websocketHeaders(
        model.headers,
        options.headers,
        accountId,
        options.apiKey,
        requestId || uuidv7(),
      );
      let retriedConnectionLimit = false;
      let retriedMissingContinuation = false;
      while (true) {
        let emitted = false;
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
          )) {
            if (!emitted) options.onTransportStart?.();
            emitted = true;
            yield event;
          }
          return;
        } catch (error) {
          const aborted = options.signal?.aborted;
          const connectionLimitBeforeStart =
            !emitted && isWebSocketConnectionLimitReachedError(error);
          if (!aborted && isPreviousResponseNotFoundError(error) && !retriedMissingContinuation) {
            retriedMissingContinuation = true;
            continue;
          }
          if (!aborted && connectionLimitBeforeStart && !retriedConnectionLimit) {
            retriedConnectionLimit = true;
            continue;
          }
          if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
            throw error;
          }
          options.onTransportDiagnostic?.(
            transportDiagnostic(error, transport, emitted, requestBytes),
          );
          if (cacheSessionId) websocketFallbackSessions.add(cacheSessionId);
          if (emitted) throw error;
          break;
        }
      }
    }

    const headers = sseHeaders(
      model.headers,
      options.headers,
      accountId,
      options.apiKey,
      requestId,
    );
    yield* requestSse(model, body, options, headers, timeoutMs);
  }

  close(sessionId?: string): void {
    if (sessionId) {
      for (const entry of websocketSessions.get(sessionId)?.values() ?? []) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        closeSocket(entry.socket, "session_shutdown");
      }
      websocketSessions.delete(sessionId);
      websocketFallbackSessions.delete(sessionId);
      return;
    }
    for (const accountEntries of websocketSessions.values()) {
      for (const entry of accountEntries.values()) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        closeSocket(entry.socket, "shutdown");
      }
    }
    websocketSessions.clear();
    websocketFallbackSessions.clear();
  }
}

const transportCleanup = new CodexTransport();
registerSessionResourceCleanup((sessionId) => transportCleanup.close(sessionId));
