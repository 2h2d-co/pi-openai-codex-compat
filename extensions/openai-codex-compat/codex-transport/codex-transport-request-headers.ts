import { requireJsonRecord } from "../codex-protocol.ts";
import { isFunction, isString } from "../value-contracts.ts";
import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  applyCodexMetadataHeaders,
  CODEX_INSTALLATION_ID_METADATA_KEY,
  CODEX_WINDOW_ID_HEADER,
} from "../codex-metadata.ts";
import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { applyResponsesLiteHeaders } from "../responses-lite.ts";
import type { CacheIdentitySnapshot } from "./codex-transport-contracts.ts";
import type { CodexTurnState } from "./codex-transport-turn-state.ts";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export const CODEX_WS_REQUEST_START_METADATA_KEY = "x-codex-ws-stream-request-start-ms";

export const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;

export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";

export function nodeOs(): typeof NodeOs | undefined {
  return process.getBuiltinModule?.("node:os");
}

export function nodeZlib(): typeof NodeZlib | undefined {
  return process.getBuiltinModule?.("node:zlib");
}

export function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export function applyTurnStateHeader(
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

export function codexRoutingHint(body: JsonRecord): string | undefined {
  if (!isString(body.model) || body.model.length === 0) return undefined;
  const tier =
    isString(body.service_tier) && body.service_tier.length > 0 ? `;tier=${body.service_tier}` : "";
  return `model=${body.model}${tier}`;
}

export function applyCodexRoutingHint(headers: Headers, body: JsonRecord): void {
  const hint = codexRoutingHint(body);
  if (!hint) {
    headers.delete(CODEX_ROUTING_HINT_HEADER);
    return;
  }
  headers.set(CODEX_ROUTING_HINT_HEADER, hint);
}

export function captureTurnStateHeader(
  headers: Headers,
  turnState: CodexTurnState | undefined,
): boolean {
  return turnState?.capture(headers.get(CODEX_TURN_STATE_HEADER) ?? undefined) ?? false;
}

export function captureTurnStateEvent(
  event: JsonRecord,
  turnState: CodexTurnState | undefined,
): boolean {
  if (event.type !== "response.metadata" || !isObject(event["headers"])) return false;
  for (const [name, value] of Object.entries(event["headers"])) {
    if (name.toLowerCase() === CODEX_TURN_STATE_HEADER && isString(value)) {
      return turnState?.capture(value) ?? false;
    }
  }
  return false;
}

export interface TurnStateMetadata {
  body: JsonRecord;
  replayedValue?: string;
}

export function withTurnStateMetadata(
  body: JsonRecord,
  turnState: CodexTurnState | undefined,
): TurnStateMetadata {
  const value = turnState?.replayValue();
  if (!value) return { body };
  const clientMetadata = isObject(body.client_metadata) ? { ...body.client_metadata } : {};
  clientMetadata[CODEX_TURN_STATE_HEADER] = value;
  return {
    body: {
      ...body,
      client_metadata: clientMetadata,
    },
    replayedValue: value,
  };
}

export function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const claimsSegment = parts[1];
    if (claimsSegment === undefined) throw new Error("Token claims segment is missing");
    const payload = requireJsonRecord(
      JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8")),
    );
    const authentication = payload["https://api.openai.com/auth"];
    if (
      !isObject(authentication) ||
      !isString(authentication["chatgpt_account_id"]) ||
      authentication["chatgpt_account_id"].length === 0
    ) {
      throw new Error("No account ID");
    }
    return authentication["chatgpt_account_id"];
  } catch (error) {
    throw new Error("Failed to extract accountId from token", { cause: error });
  }
}

export function validateCodexAuthentication(model: Model<Api>, apiKey: string | undefined): string {
  if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  return extractAccountId(apiKey);
}

export function resolveCodexUrl(baseUrl?: string): string {
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

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

export function baseHeaders(
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

export function sseHeaders(
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

export function jsonHeaders(
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

export function websocketHeaders(
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

export function cacheIdentitySnapshot(
  body: JsonRecord,
  headers: Headers,
  accountId: string,
): CacheIdentitySnapshot {
  const metadata = isObject(body.client_metadata) ? body.client_metadata : undefined;
  const identity: CacheIdentitySnapshot = {
    promptCacheKey: isString(body.prompt_cache_key) ? body.prompt_cache_key : undefined,
    sessionHeader: headers.get("session-id"),
    threadHeader: headers.get("thread-id"),
    clientRequestHeader: headers.get("x-client-request-id"),
    routingHint: headers.get(CODEX_ROUTING_HINT_HEADER),
    accountId,
  };
  if (isString(metadata?.[CODEX_INSTALLATION_ID_METADATA_KEY])) {
    identity.installationId = metadata[CODEX_INSTALLATION_ID_METADATA_KEY];
  }
  if (isString(metadata?.[CODEX_WINDOW_ID_HEADER])) {
    identity.windowId = metadata[CODEX_WINDOW_ID_HEADER];
  }
  return identity;
}

export function cacheAffinityEnabled(identity: CacheIdentitySnapshot): boolean {
  return Boolean(identity.promptCacheKey || identity.sessionHeader || identity.clientRequestHeader);
}

export function promptKeyAndHeaderAligned(identity: CacheIdentitySnapshot): boolean {
  return Boolean(
    identity.promptCacheKey &&
    identity.promptCacheKey === identity.sessionHeader &&
    identity.promptCacheKey === identity.threadHeader &&
    identity.promptCacheKey === identity.clientRequestHeader,
  );
}

export function sameCacheIdentity(a: CacheIdentitySnapshot, b: CacheIdentitySnapshot): boolean {
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

export function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function compressBody(body: string): Uint8Array | undefined {
  const zlib = nodeZlib();
  if (!zlib || !isFunction(zlib.zstdCompressSync)) return undefined;
  try {
    const compressed = zlib.zstdCompressSync(body, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
    });
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  } catch {
    return undefined;
  }
}
