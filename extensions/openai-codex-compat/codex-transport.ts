import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import {
  registerSessionResourceCleanup,
  type Model,
  type OpenAICodexResponsesOptions,
  type ProviderEnv,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { normalizeReplayItem, replayItemsEqual, stableResponsesJson } from "./responses-replay.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.83.0
 * src/api/openai-codex-responses.ts transport behavior.
 */

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1_000;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1_000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1_000;

type ProcessWithBuiltinModules = typeof process & {
  getBuiltinModule?: {
    (id: "node:os"): typeof NodeOs;
    (id: "node:zlib"): typeof NodeZlib;
  };
};

type CodexTransportOptions = OpenAICodexResponsesOptions & {
  env?: ProviderEnv;
};

export type CodexJsonRequestOptions = {
  apiKey: string;
  headers?: ProviderHeaders;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
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

const websocketSessions = new Map<string, CachedWebSocket>();
const websocketFallbackSessions = new Set<string>();

class CodexResponseError extends Error {}

function nodeOs(): typeof NodeOs | undefined {
  const currentProcess = process as ProcessWithBuiltinModules;
  return currentProcess.getBuiltinModule?.("node:os");
}

function nodeZlib(): typeof NodeZlib | undefined {
  const currentProcess = process as ProcessWithBuiltinModules;
  return currentProcess.getBuiltinModule?.("node:zlib");
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (
    status === 429 &&
    /usage limit|insufficient_quota|out of budget|quota exceeded|billing/i.test(text)
  ) {
    return false;
  }
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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
          const parsed = JSON.parse(data) as unknown;
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

function scheduleSocketExpiry(sessionId: string, entry: CachedWebSocket): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeSocket(entry.socket, "idle_timeout");
    websocketSessions.delete(sessionId);
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
    const onError = (event: unknown) => fail(new Error(`WebSocket error: ${explain(event)}`));
    const onClose = (event: unknown) =>
      fail(new Error(`WebSocket closed during connect: ${explain(event)}`));
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
    timer = setTimeout(
      () => fail(new Error(`WebSocket connect timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
  });
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ socket: WebSocketLike; entry?: CachedWebSocket; release(keep: boolean): void }> {
  if (sessionId) {
    const cached = websocketSessions.get(sessionId);
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
            websocketSessions.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSocketExpiry(sessionId, cached);
        },
      };
    }
    if (cached && !cached.busy) {
      closeSocket(cached.socket);
      websocketSessions.delete(sessionId);
    }
  }

  const socket = await connectWebSocket(url, headers, signal, timeoutMs);
  if (!sessionId) {
    return { socket, release: () => closeSocket(socket) };
  }
  const entry: CachedWebSocket = { socket, busy: true, createdAt: Date.now() };
  websocketSessions.set(sessionId, entry);
  return {
    socket,
    entry,
    release(keep) {
      if (!keep || !socketReusable(socket)) {
        closeSocket(socket);
        websocketSessions.delete(sessionId);
        return;
      }
      entry.busy = false;
      scheduleSocketExpiry(sessionId, entry);
    },
  };
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
    stableResponsesJson(requestWithoutHistory(body)) !==
    stableResponsesJson(requestWithoutHistory(continuation.lastRequestBody))
  ) {
    delete entry.continuation;
    return body;
  }

  const currentInput = Array.isArray(body.input) ? body.input.filter(isObject) : [];
  const previousInput = Array.isArray(continuation.lastRequestBody.input)
    ? continuation.lastRequestBody.input.filter(isObject)
    : [];
  const baseline = [...previousInput, ...continuation.lastResponseItems];
  if (
    currentInput.length < baseline.length ||
    !replayItemsEqual(currentInput.slice(0, baseline.length), baseline)
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
      try {
        if (!isObject(event)) return;
        const text = await decodeWebSocketData(event["data"]);
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
        failure = error instanceof Error ? error : new Error(String(error));
        done = true;
        notify();
      }
    })();
  };
  const onError = (event: unknown) => {
    failure = new Error(`WebSocket error: ${explain(event)}`);
    done = true;
    notify();
  };
  const onClose = (event: unknown) => {
    if (!terminal) failure = new Error(`WebSocket closed: ${explain(event)}`);
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

function normalizeEvent(event: JsonRecord): JsonRecord {
  const type = event.type;
  if (type === "error") {
    const nested = isObject(event["error"]) ? event["error"] : undefined;
    throw new CodexResponseError(
      typeof event["message"] === "string"
        ? event["message"]
        : typeof nested?.["message"] === "string"
          ? nested["message"]
          : "Codex request failed",
    );
  }
  if (type === "response.failed") {
    const response = isObject(event.response) ? event.response : undefined;
    const error = isObject(response?.["error"]) ? response["error"] : undefined;
    throw new CodexResponseError(
      typeof error?.["message"] === "string" ? error["message"] : "Codex response failed",
    );
  }
  if (type === "response.done") {
    return { ...event, type: "response.completed" };
  }
  return event;
}

async function* requestSse(
  model: Model<any>,
  body: JsonRecord,
  options: CodexTransportOptions,
  headers: Headers,
): AsyncGenerator<JsonRecord> {
  const bodyJson = JSON.stringify(body);
  const compressed = compressBody(bodyJson);
  if (compressed) headers.set("content-encoding", "zstd");
  const requestBody = compressed ?? bodyJson;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutSignal =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
    const combined = combineAbortSignals([options.signal, timeoutSignal]);
    let response: Response;
    try {
      try {
        response = await (options.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
          method: "POST",
          headers,
          body: requestBody,
          ...(combined.signal ? { signal: combined.signal } : {}),
        });
      } catch (error) {
        if (attempt < maxRetries && !options.signal?.aborted) {
          await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
          continue;
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
    if (!response.ok) {
      const errorText = await response.text();
      if (attempt < maxRetries && isRetryable(response.status, errorText)) {
        await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
        continue;
      }
      throw new Error(errorText || `Codex request failed with status ${response.status}`);
    }
    for await (const event of parseSse(response, options.signal)) {
      yield normalizeEvent(event);
    }
    return;
  }
}

async function* requestWebSocket(
  model: Model<any>,
  body: JsonRecord,
  options: CodexTransportOptions,
  headers: Headers,
  sessionId: string | undefined,
): AsyncGenerator<JsonRecord> {
  const acquired = await acquireWebSocket(
    resolveCodexWebSocketUrl(model.baseUrl),
    headers,
    sessionId,
    options.signal,
    options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  );
  let keep = true;
  try {
    const useContinuation =
      options.transport === "auto" || options.transport === "websocket-cached";
    const requestBody =
      useContinuation && acquired.entry ? cachedRequestBody(acquired.entry, body) : body;
    acquired.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    const responseItems: JsonRecord[] = [];
    let responseId: string | undefined;
    for await (const event of parseWebSocket(acquired.socket, options.signal, options.timeoutMs)) {
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
      yield normalizeEvent(event);
    }
    if (useContinuation && acquired.entry && responseId) {
      acquired.entry.continuation = {
        lastRequestBody: structuredClone(body),
        lastResponseId: responseId,
        lastResponseItems: responseItems.map(normalizeReplayItem),
      };
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
    extractAccountId(options.apiKey),
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
    throw new Error(responseText || `Codex request failed with status ${response.status}`);
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
    const accountId = extractAccountId(options.apiKey);
    const sessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
    const transport = options.transport ?? "auto";

    const websocketDisabled =
      transport === "auto" && sessionId !== undefined && websocketFallbackSessions.has(sessionId);
    if (transport !== "sse" && !websocketDisabled) {
      const headers = websocketHeaders(
        model.headers,
        options.headers,
        accountId,
        options.apiKey,
        sessionId ?? crypto.randomUUID(),
      );
      let emitted = false;
      try {
        for await (const event of requestWebSocket(model, body, options, headers, sessionId)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (
          emitted ||
          error instanceof CodexResponseError ||
          transport === "websocket" ||
          transport === "websocket-cached"
        ) {
          throw error;
        }
        if (sessionId) websocketFallbackSessions.add(sessionId);
      }
    }

    const headers = sseHeaders(
      model.headers,
      options.headers,
      accountId,
      options.apiKey,
      sessionId,
    );
    yield* requestSse(model, body, options, headers);
  }

  close(sessionId?: string): void {
    if (sessionId) {
      const entry = websocketSessions.get(sessionId);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      if (entry) closeSocket(entry.socket, "session_shutdown");
      websocketSessions.delete(sessionId);
      websocketFallbackSessions.delete(sessionId);
      return;
    }
    for (const entry of websocketSessions.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      closeSocket(entry.socket, "shutdown");
    }
    websocketSessions.clear();
    websocketFallbackSessions.clear();
  }
}

const transportCleanup = new CodexTransport();
registerSessionResourceCleanup((sessionId) => transportCleanup.close(sessionId));
