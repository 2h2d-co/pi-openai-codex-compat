import type { Api, Model } from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { errorFromThrown } from "../error-from-thrown.ts";
import type { CodexTransportOptions } from "./codex-transport-contracts.ts";
import {
  CodexHttpError,
  CodexProtocolError,
  RetryDelayExceededError,
  SseStreamIncompleteError,
  codexHttpError,
  isRetryable,
  thrownMessage,
} from "./codex-transport-errors.ts";
import { isTerminalEvent, normalizeEvent } from "./codex-transport-events.ts";
import {
  applyTurnStateHeader,
  captureTurnStateHeader,
  compressBody,
  headersToRecord,
  resolveCodexUrl,
} from "./codex-transport-request-headers.ts";
import {
  BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  combineAbortSignals,
  retryBackoffMs,
  retryDelayMs,
  sleep,
  validateRetryDelay,
} from "./codex-transport-retry.ts";

export async function* parseSse(
  response: {
    body: {
      getReader(): Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "read" | "releaseLock">;
    } | null;
  },
  signal?: AbortSignal,
): AsyncGenerator<JsonRecord> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Abort-triggered cancellation is best-effort; the parse loop observes the abort signal directly.
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const chunk = await reader.read();
      const { done } = chunk;
      if (signal?.aborted) throw new Error("Request was aborted");
      if (done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new CodexProtocolError(
          "Codex returned a non-byte SSE stream chunk.",
          value,
          undefined,
        );
      }
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
            parsed = JSON.parse(data);
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
    // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Reader cancellation is best-effort cleanup after parsing has already completed or failed.
    await reader.cancel().catch((_error: unknown) => {});
    try {
      reader.releaseLock();
      // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Releasing an already-invalidated reader lock is best-effort cleanup.
    } catch (_error) {} // oxlint-disable-line no-unused-vars -- The caught release failure is intentionally ignored after stream completion.
  }
}

export async function* requestSse(
  model: Model<Api>,
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
          const init: RequestInit = {
            method: "POST",
            headers,
            body: requestBody,
          };
          if (combined.signal) init.signal = combined.signal;
          response = await (options.fetch ?? globalThis.fetch)(
            resolveCodexUrl(model.baseUrl),
            init,
          );
        } catch (error) {
          if (timeoutSignal?.aborted && !options.signal?.aborted) {
            throw new Error(`Codex SSE response headers timed out after ${String(timeoutMs)}ms`, {
              cause: error,
            });
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
        throw new Error("Request was aborted", { cause: error });
      }
      const requestError = errorFromThrown(
        error,
        "Codex SSE transport failed with a non-Error value.",
      );
      lastError = requestError;
      if (
        attempt < maxRetries &&
        !(requestError instanceof CodexHttpError) &&
        !(requestError instanceof RetryDelayExceededError) &&
        !requestError.message.includes("usage limit")
      ) {
        await sleep(retryBackoffMs(BASE_DELAY_MS, attempt + 1), options.signal);
        continue;
      }
      throw requestError;
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
