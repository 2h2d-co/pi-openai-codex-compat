import type { TestContext } from "node:test";

// Words that classify a failed response without quoting it.
const CATEGORIES = [
  "abort",
  "overloaded",
  "rate limit",
  "usage limit",
  "quota",
  "credit",
  "authentication",
  "unauthorized",
  "forbidden",
  "OAuth",
  "timeout",
  "network",
  "websocket",
  "context",
  "max_tokens",
  "thinking",
  "tool",
  "model",
  "beta",
];

// Bearer values, API keys, JWTs, and other long opaque tokens.
const CREDENTIAL =
  /Bearer\s+\S+|\bsk-[\w-]{16,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9+_-]{40,}={0,2}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Remove credential-like values and bound the length of text printed in a diagnostic. */
export function redact(text: string): string {
  const redacted = text.replace(CREDENTIAL, "[redacted]");
  return redacted.length > 1000 ? `${redacted.slice(0, 1000)}…` : redacted;
}

/**
 * Describe a failed assistant response by stop reason, HTTP status, and error categories only.
 * Provider error text can echo prompts or credentials, so it is never printed.
 */
export function describeFailure(message: unknown): string {
  const record = isRecord(message) ? message : {};
  const error = typeof record["errorMessage"] === "string" ? record["errorMessage"] : "";
  return JSON.stringify({
    stopReason: record["stopReason"],
    httpStatus: error.match(/\b[45]\d\d\b/)?.[0],
    categories: CATEGORIES.filter((category) =>
      error.toLowerCase().includes(category.toLowerCase()),
    ),
  });
}

/**
 * Report every error a live test meets as a test diagnostic, whether or not the test fails, so a
 * one-off failure keeps its cause. Extension notices and extension errors are printed with
 * credential-like values removed. Failed responses are only summarized.
 */
export function errorLog(t: TestContext) {
  const log = {
    notice: (message: string, level: string | undefined): void => {
      if (level === "error" || level === "warning") {
        t.diagnostic(`Extension ${level}: ${redact(message)}`);
      }
    },
    extensionError: (event: string, error: string): void => {
      t.diagnostic(`Extension error in ${event}: ${redact(error)}`);
    },
    response: (message: unknown): void => {
      if (!isRecord(message) || message["role"] !== "assistant") return;
      if (["error", "aborted", "length"].includes(String(message["stopReason"]))) {
        t.diagnostic(`Failed response: ${describeFailure(message)}`);
      }
    },
    /** Read notices, extension errors, and responses from a Pi RPC client's event stream. */
    rpcEvent: (event: unknown): void => {
      if (!isRecord(event)) return;
      if (
        event["type"] === "extension_ui_request" &&
        event["method"] === "notify" &&
        typeof event["message"] === "string"
      ) {
        log.notice(
          event["message"],
          typeof event["notifyType"] === "string" ? event["notifyType"] : "info",
        );
      } else if (event["type"] === "extension_error") {
        log.extensionError(String(event["event"]), String(event["error"]));
      } else if (event["type"] === "message_end") {
        log.response(event["message"]);
      }
    },
    /**
     * Read a print or JSON mode run. Pi drops extension notices in these modes, prints extension
     * errors to stderr, and saves failed responses in the session. Other stderr lines can quote
     * provider errors, so only extension error lines are printed.
     */
    printRun: (stderr: string, messages: readonly unknown[] = []): void => {
      for (const line of stderr.split("\n")) {
        if (line.startsWith("Extension error")) t.diagnostic(redact(line));
      }
      for (const message of messages) log.response(message);
    },
  };
  return log;
}
