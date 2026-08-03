const MAX_PROVIDER_ERROR_BODY_CHARS = 4_000;

type ProviderErrorShape = Error & {
  statusCode?: unknown;
  status?: unknown;
  body?: unknown;
  error?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  $response?: { statusCode?: unknown; body?: unknown };
};

function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function truncateErrorText(text: string): string {
  return text.length <= MAX_PROVIDER_ERROR_BODY_CHARS
    ? text
    : `${text.slice(0, MAX_PROVIDER_ERROR_BODY_CHARS)}... [truncated ${
        text.length - MAX_PROVIDER_ERROR_BODY_CHARS
      } chars]`;
}

function isPlainNonEmptyObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length > 0;
}

function isReadableStreamLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipe" in value &&
    typeof value.pipe === "function"
  );
}

function errorStatus(error: ProviderErrorShape): number | undefined {
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.status === "number") return error.status;
  if (typeof error.$metadata?.httpStatusCode === "number") {
    return error.$metadata.httpStatusCode;
  }
  if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
  return undefined;
}

function errorBody(error: ProviderErrorShape): string | undefined {
  let body: string | undefined;
  if (typeof error.body === "string") body = error.body;
  else if (isPlainNonEmptyObject(error.error)) body = safeJsonStringify(error.error);
  else if (typeof error.$response?.body === "string") body = error.$response.body;
  else if (
    !isReadableStreamLike(error.$response?.body) &&
    isPlainNonEmptyObject(error.$response?.body)
  ) {
    body = safeJsonStringify(error.$response.body);
  }
  const trimmed = body?.trim();
  return trimmed ? truncateErrorText(trimmed) : undefined;
}

/** Match Pi AI's provider error normalization without importing a private package subpath. */
export function formatProviderError(error: unknown): string {
  if (!(error instanceof Error)) return safeJsonStringify(error);
  const providerError = error as ProviderErrorShape;
  const status = errorStatus(providerError);
  const body = errorBody(providerError);
  if (status !== undefined && body !== undefined && !error.message.includes(body)) {
    return `${status}: ${body}`;
  }
  return error.message;
}
