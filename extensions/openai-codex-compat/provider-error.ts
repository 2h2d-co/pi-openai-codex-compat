import { hasObjectType, isFunction, isNumber, isString } from "./value-contracts.ts";
const MAX_PROVIDER_ERROR_BODY_CHARS = 4_000;

type ProviderErrorDetails = Error & {
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
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
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

function isPlainNonEmptyObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length > 0;
}

function isReadableStreamLike(value: unknown): boolean {
  return hasObjectType(value) && value !== null && "pipe" in value && isFunction(value.pipe);
}

function errorStatus(error: ProviderErrorDetails): number | undefined {
  if (isNumber(error.statusCode)) return error.statusCode;
  if (isNumber(error.status)) return error.status;
  if (isNumber(error.$metadata?.httpStatusCode)) {
    return error.$metadata.httpStatusCode;
  }
  if (isNumber(error.$response?.statusCode)) return error.$response.statusCode;
  return undefined;
}

function errorBody(error: ProviderErrorDetails): string | undefined {
  let body: string | undefined;
  if (isString(error.body)) body = error.body;
  else if (isPlainNonEmptyObject(error.error)) body = safeJsonStringify(error.error);
  else if (isString(error.$response?.body)) body = error.$response.body;
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
  const providerError: ProviderErrorDetails = error;
  const status = errorStatus(providerError);
  const body = errorBody(providerError);
  if (status !== undefined && body !== undefined && !error.message.includes(body)) {
    return `${status}: ${body}`;
  }
  return error.message;
}
