import { isFunction } from "../value-contracts.ts";
import type {
  CachedWebSocket,
  CacheIdentitySnapshot,
  OpenAICodexWebSocketDebugStats,
  WebSocketConstructor,
  WebSocketFallbackSession,
  WebSocketLike,
} from "./codex-transport-contracts.ts";
import {
  extractWebSocketCloseError,
  extractWebSocketError,
  thrownMessage,
} from "./codex-transport-errors.ts";
import { headersToRecord } from "./codex-transport-request-headers.ts";

export const websocketSessions = new Map<string, Map<string, CachedWebSocket>>();

export const websocketFallbackSessions = new Map<string, WebSocketFallbackSession>();

export const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();

export function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
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

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketFallbackSessions.has(sessionId) : false;
}

export function webSocketFallbackSession(
  sessionId: string | undefined,
): WebSocketFallbackSession | undefined {
  return sessionId ? websocketFallbackSessions.get(sessionId) : undefined;
}

export function recordWebSocketSseFallback(sessionId: string | undefined): void {
  if (!sessionId) return;
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.sseFallbacks += 1;
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

export function recordWebSocketFailure(
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

function isWebSocketConstructor(value: unknown): value is WebSocketConstructor {
  return isFunction(value);
}

export function websocketConstructor(): WebSocketConstructor | undefined {
  const candidate: unknown = globalThis.WebSocket;
  return isWebSocketConstructor(candidate) ? candidate : undefined;
}

export function closeSocket(socket: WebSocketLike, reason = "done"): void {
  try {
    socket.close(1_000, reason);
  } catch {}
}

export function socketReusable(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

export async function connectWebSocket(
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

export async function acquireWebSocket(
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
