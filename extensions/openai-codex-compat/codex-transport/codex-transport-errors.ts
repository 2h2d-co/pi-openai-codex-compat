import { isObject, type JsonRecord } from "../codex-protocol.ts";

export const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";

export const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

export class CodexApiError extends Error {
  readonly code: string | undefined;
  readonly payload: JsonRecord;

  constructor(message: string, code: string | undefined, payload: JsonRecord) {
    super(message);
    this.name = "CodexApiError";
    this.code = code;
    this.payload = payload;
  }
}

export class CodexProtocolError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown, cause: unknown) {
    super(message, { cause });
    this.name = "CodexProtocolError";
    this.payload = payload;
  }
}

export class CodexHttpError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CodexHttpError";
    this.retryable = retryable;
  }
}

export class WebSocketCloseError extends Error {
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

export function extractWebSocketError(event: unknown): Error {
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

export function extractWebSocketCloseError(
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

export function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

export function isCodexNonTransportError(error: unknown): boolean {
  return (
    error instanceof CodexApiError ||
    error instanceof CodexHttpError ||
    error instanceof CodexProtocolError
  );
}

export function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

export function isPreviousResponseNotFoundError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

export function isTerminalRateLimitError(errorText: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|usage_limit_reached|usage_not_included|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorText,
  );
}

export class RetryDelayExceededError extends Error {}

export class SseStreamIncompleteError extends Error {}

export function codexHttpError(status: number, statusText: string, raw: string): CodexHttpError {
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

export function isRetryable(status: number, text: string): boolean {
  if (status === 429 && isTerminalRateLimitError(text)) return false;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    text,
  );
}
