import type { CodexTransportOptions } from "./codex-transport-contracts.ts";
import { RetryDelayExceededError } from "./codex-transport-errors.ts";

export const DEFAULT_MAX_RETRIES = 0;

export const BASE_DELAY_MS = 200;

export const DEFAULT_WEBSOCKET_MAX_RETRIES = 5;

export const DEFAULT_WEBSOCKET_RETRY_BASE_DELAY_MS = 200;

export const DEFAULT_SSE_STREAM_MAX_RETRIES = 5;

export const DEFAULT_SSE_STREAM_RETRY_BASE_DELAY_MS = 200;

export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

export function retryBackoffMs(baseDelayMs: number, attempt: number): number {
  if (baseDelayMs <= 0) return 0;
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.floor(exponential * jitter);
}

export function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeoutMs: ${String(value)}`);
  }
  return Math.floor(value);
}

export function normalizeRetryCount(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`Invalid ${name}: ${String(resolved)}`);
  }
  return Math.floor(resolved);
}

export function retryDelayMs(headers: Headers): number | undefined {
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

export function validateRetryDelay(delayMs: number, options: CodexTransportOptions): number {
  const maximum = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maximum > 0 && delayMs > maximum) {
    throw new RetryDelayExceededError(
      `Server requested ${Math.ceil(delayMs / 1_000)}s retry delay (max: ${Math.ceil(maximum / 1_000)}s)`,
    );
  }
  return delayMs;
}

export interface CombinedAbortSignals {
  signal?: AbortSignal;
  cleanup(): void;
}

export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): CombinedAbortSignals {
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
