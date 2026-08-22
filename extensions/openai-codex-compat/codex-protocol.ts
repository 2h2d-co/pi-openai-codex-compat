import { isBoolean, isNonNullObject, isNumber, isString } from "./value-contracts.ts";
import {
  calculateCost,
  type Api,
  type Model,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { errorFromThrown } from "./error-from-thrown.ts";
import {
  RESPONSES_COMPACTION_ITEM_SCHEMA,
  RESPONSES_INPUT_ITEM_SCHEMA,
  RESPONSES_MESSAGE_ITEM_SCHEMA,
  type ResponsesCompactionItem,
  type ResponsesInputItem,
} from "./responses-item-schema.ts";

export const REMOTE_COMPACTION_BETA = "remote_compaction_v2";
export const RETAINED_CONTEXT_BUDGET = 64_000;

const REQUEST_RETRIES = 2;
const UTF8_BYTES_PER_TOKEN = 4;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];

export interface JsonRecord {
  [key: string]: JsonValue | undefined;
  type?: JsonValue;
  role?: JsonValue;
  content?: JsonValue;
  text?: JsonValue;
  verbosity?: JsonValue;
  encrypted_content?: JsonValue;
  input?: JsonValue;
  messages?: JsonValue;
  previous_response_id?: JsonValue;
  include?: JsonValue;
  model?: JsonValue;
  store?: JsonValue;
  stream?: JsonValue;
  instructions?: JsonValue;
  parallel_tool_calls?: JsonValue;
  tool_choice?: JsonValue;
  prompt_cache_key?: JsonValue;
  tools?: JsonValue;
  service_tier?: JsonValue;
  client_metadata?: JsonValue;
  chatgpt_account_id?: JsonValue;
  message?: JsonValue;
  item?: JsonValue;
  response?: JsonValue;
  usage?: JsonValue;
  input_tokens?: JsonValue;
  output_tokens?: JsonValue;
  input_tokens_details?: JsonValue;
  cached_tokens?: JsonValue;
  cache_write_tokens?: JsonValue;
  total_tokens?: JsonValue;
  v?: JsonValue;
  id?: JsonValue;
  phase?: JsonValue;
  data?: JsonValue;
  mimeType?: JsonValue;
  stopReason?: JsonValue;
  thinkingSignature?: JsonValue;
  textSignature?: JsonValue;
  name?: JsonValue;
  arguments?: JsonValue;
  toolCallId?: JsonValue;
  addedToolNames?: JsonValue;
  kind?: JsonValue;
  version?: JsonValue;
  modelId?: JsonValue;
  history?: JsonValue;
}

export type RemoteCompactionResponse = {
  item: ResponsesCompactionItem;
  usage?: Usage;
};

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isBoolean(value) || isNumber(value) || isString(value)) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isNonNullObject(value) &&
    Object.values(value).every((entry) => entry === undefined || isJsonValue(entry))
  );
}

export function isObject(value: unknown): value is JsonRecord {
  return (
    isNonNullObject(value) &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => entry === undefined || isJsonValue(entry))
  );
}

export function requireJsonRecord(value: unknown, label = "value"): JsonRecord {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

export function optionalJsonRecord(value: unknown, label = "value"): JsonRecord | undefined {
  return value === undefined ? undefined : requireJsonRecord(value, label);
}

export function requireJsonRecords(value: unknown, label = "value"): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new Error(`${label} must be an array of JSON objects.`);
  }
  return value;
}

export function requireJsonValues(value: unknown, label = "value"): JsonValue[] {
  if (!Array.isArray(value) || !value.every(isJsonValue)) {
    throw new Error(`${label} must be an array of JSON values.`);
  }
  return value;
}

export function parseJsonRecord(value: string, label = "value"): JsonRecord {
  const parsed: unknown = JSON.parse(value);
  return requireJsonRecord(parsed, label);
}

export function requireResponsesInputItems(value: unknown, label = "value"): ResponsesInputItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of Responses items.`);
  }
  const items: ResponsesInputItem[] = [];
  for (const item of value) {
    if (!isObject(item) || !Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, item)) {
      throw new Error(`${label} must be an array of Responses items.`);
    }
    items.push(item);
  }
  return items;
}

export function approximateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / UTF8_BYTES_PER_TOKEN);
}

export function messageTextTokens(item: ResponsesInputItem): number {
  if (!Value.Check(RESPONSES_MESSAGE_ITEM_SCHEMA, item)) return 0;
  if (isString(item.content)) return approximateTokens(item.content);
  if (!Array.isArray(item.content)) return 0;

  let tokens = 0;
  for (const part of item.content) {
    if (!isObject(part) || !isString(part.text)) continue;
    if (part.type === "input_text" || part.type === "output_text") {
      tokens += approximateTokens(part.text);
    }
  }
  return tokens;
}

interface Utf8Split {
  removedCharacters: number;
  prefix: string;
  suffix: string;
}

function splitUtf8Bytes(text: string, beginningBytes: number, endBytes: number): Utf8Split {
  const encodedLength = new TextEncoder().encode(text).byteLength;
  const tailStartTarget = Math.max(0, encodedLength - endBytes);
  let currentByte = 0;
  let prefix = "";
  let suffix = "";
  let removedCharacters = 0;
  let suffixStarted = false;

  for (const character of text) {
    const width = new TextEncoder().encode(character).byteLength;
    const characterStart = currentByte;
    const characterEnd = currentByte + width;
    currentByte = characterEnd;

    if (characterEnd <= beginningBytes) {
      prefix += character;
      continue;
    }
    if (characterStart >= tailStartTarget) {
      suffixStarted = true;
      suffix += character;
      continue;
    }
    if (!suffixStarted) removedCharacters += 1;
  }

  const prefixBytes = new TextEncoder().encode(prefix).byteLength;
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  if (prefixBytes + suffixBytes > encodedLength) {
    suffix = text.slice(prefix.length);
    removedCharacters = 0;
  }

  return { removedCharacters, prefix, suffix };
}

export function truncateMiddleWithTokenBudget(text: string, tokenLimit: number): string {
  const originalBytes = new TextEncoder().encode(text).byteLength;
  const byteLimit = Math.max(0, tokenLimit) * UTF8_BYTES_PER_TOKEN;
  if (originalBytes <= byteLimit) return text;

  const leftBytes = Math.floor(byteLimit / 2);
  const rightBytes = byteLimit - leftBytes;
  const { prefix, suffix } = splitUtf8Bytes(text, leftBytes, rightBytes);
  const removedTokens = Math.ceil(Math.max(0, originalBytes - byteLimit) / UTF8_BYTES_PER_TOKEN);
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function shortenMessage(
  item: ResponsesInputItem,
  tokenLimit: number,
): ResponsesInputItem | undefined {
  if (tokenLimit <= 0 || !Value.Check(RESPONSES_MESSAGE_ITEM_SCHEMA, item)) return undefined;
  const result: JsonRecord = structuredClone(item);

  if (isString(result.content)) {
    result.content = truncateMiddleWithTokenBudget(result.content, tokenLimit);
    return result.content && Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, result) ? result : undefined;
  }
  if (!Array.isArray(result.content)) {
    return Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, result) ? result : undefined;
  }

  let remaining = tokenLimit;
  const content: JsonValue[] = [];
  for (const part of result.content) {
    if (
      !isObject(part) ||
      !isString(part.text) ||
      (part.type !== "input_text" && part.type !== "output_text")
    ) {
      content.push(part);
      continue;
    }

    if (remaining === 0) continue;
    const tokens = approximateTokens(part.text);
    if (tokens <= remaining) {
      content.push(part);
      remaining -= tokens;
    } else {
      const text = truncateMiddleWithTokenBudget(part.text, remaining);
      if (text) content.push({ ...part, text });
      remaining = 0;
    }
  }

  result.content = content;
  return content.length > 0 && Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, result)
    ? result
    : undefined;
}

function retainedRole(item: ResponsesInputItem): boolean {
  return (
    Value.Check(RESPONSES_MESSAGE_ITEM_SCHEMA, item) &&
    (item.role === "user" || item.role === "developer" || item.role === "system")
  );
}

/**
 * Reproduce Codex remote-compaction-v2 history installation: select recent
 * user/developer/system messages from newest to oldest, then restore their
 * chronological order. The oldest selected message may be truncated.
 */
export function selectRetainedContext(
  history: readonly ResponsesInputItem[],
  budget = RETAINED_CONTEXT_BUDGET,
): ResponsesInputItem[] {
  let remaining = budget;
  const newestFirst: ResponsesInputItem[] = [];

  for (let index = history.length - 1; index >= 0 && remaining > 0; index--) {
    const item = history[index];
    if (item === undefined) continue;
    if (!retainedRole(item)) continue;

    const tokens = Math.max(1, messageTextTokens(item));
    if (tokens <= remaining) {
      newestFirst.push(structuredClone(item));
      remaining -= tokens;
      continue;
    }

    const partial = shortenMessage(item, remaining);
    if (partial) newestFirst.push(partial);
    remaining = 0;
  }

  return newestFirst.reverse();
}

export function installCompactionItem(
  previousHistory: readonly ResponsesInputItem[],
  compactionItem: ResponsesCompactionItem,
): ResponsesInputItem[] {
  return [...selectRetainedContext(previousHistory), structuredClone(compactionItem)];
}

export function addRemoteCompactionFeature(current: string | null | undefined): string {
  const features = (current ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  return [...new Set([...features, REMOTE_COMPACTION_BETA])].join(",");
}

export function withoutConversationInput(payload: JsonRecord): JsonRecord {
  const template = structuredClone(payload);
  delete template.input;
  delete template.messages;
  delete template.previous_response_id;
  return template;
}

/** Construct the same ordinary Responses request shape used by Codex v2. */
export function remoteCompactionPayload(options: {
  template?: JsonRecord | undefined;
  modelId: string;
  history: readonly ResponsesInputItem[];
  instructions: string;
  sessionId?: string | undefined;
  fallbackTools?: JsonValue[] | undefined;
  priority: boolean;
}): JsonRecord {
  const payload = options.template ? structuredClone(options.template) : {};
  const include = Array.isArray(payload.include)
    ? payload.include.filter((entry): entry is string => typeof entry === "string")
    : [];

  payload.model = options.modelId;
  payload.store = false;
  payload.stream = true;
  payload.instructions = options.instructions;
  payload.input = [
    ...options.history.map((item) => structuredClone(item)),
    { type: "compaction_trigger" },
  ];
  payload.parallel_tool_calls = isBoolean(payload.parallel_tool_calls)
    ? payload.parallel_tool_calls
    : true;
  payload.tool_choice ??= "auto";
  payload.include = [...new Set([...include, "reasoning.encrypted_content"])];
  if (options.sessionId) payload.prompt_cache_key = options.sessionId;
  else delete payload.prompt_cache_key;
  payload.text =
    isObject(payload.text) && isString(payload.text.verbosity)
      ? { verbosity: payload.text.verbosity }
      : { verbosity: "low" };

  if (!Array.isArray(payload.tools) && options.fallbackTools) payload.tools = options.fallbackTools;
  if (options.priority) {
    payload.service_tier = "priority";
  } else if (payload.service_tier === "priority") {
    // A cached request template may still contain this extension's old fast-mode value.
    delete payload.service_tier;
  }
  delete payload.messages;
  delete payload.previous_response_id;
  return payload;
}

function accountIdFromToken(token: string): string {
  try {
    const pieces = token.split(".");
    if (pieces.length !== 3) throw new Error("not a JWT");
    const claimsSegment = pieces[1];
    if (claimsSegment === undefined) throw new Error("JWT claims segment is missing");
    const claims = requireJsonRecord(
      JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8")),
    );
    const openAIClaims = claims["https://api.openai.com/auth"];
    if (!isObject(openAIClaims) || !isString(openAIClaims.chatgpt_account_id)) {
      throw new Error("account id missing");
    }
    return openAIClaims.chatgpt_account_id;
  } catch (error) {
    throw new Error("Could not read the ChatGPT account id from OpenAI Codex authentication.", {
      cause: error,
    });
  }
}

export function remoteCompactionHeaders(options: {
  token: string;
  providerHeaders?: ProviderHeaders | undefined;
  sessionId: string;
}): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.providerHeaders ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${options.token}`);
  headers.set("chatgpt-account-id", accountIdFromToken(options.token));
  headers.set("originator", "pi");
  headers.set("user-agent", "pi-openai-codex-compat");
  headers.set("openai-beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("session-id", options.sessionId);
  headers.set("x-client-request-id", options.sessionId);
  headers.set(
    "x-codex-beta-features",
    addRemoteCompactionFeature(headers.get("x-codex-beta-features")),
  );
  return headers;
}

class PermanentRemoteError extends Error {}
class IncompleteRemoteStream extends Error {}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function serverRetryDelay(response: Response): number | undefined {
  const milliseconds = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;

  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Compaction aborted");
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Compaction aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readCompactionStream(
  response: Response,
): Promise<{ item: ResponsesCompactionItem; usage?: unknown }> {
  if (!response.body)
    throw new IncompleteRemoteStream("Codex returned an empty compaction stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const compacted: ResponsesCompactionItem[] = [];
  let pending = "";
  let finished = false;
  let usage: unknown;

  const consumeEvent = (block: string) => {
    const encoded = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!encoded || encoded === "[DONE]") return;

    let event: unknown;
    try {
      event = JSON.parse(encoded);
    } catch (error) {
      throw new PermanentRemoteError("Codex returned malformed compaction stream data.", {
        cause: error,
      });
    }
    if (!isObject(event)) return;

    if (event.type === "error") {
      if (isString(event.message) && event.message.trim()) {
        throw new PermanentRemoteError(event.message);
      }
      throw new IncompleteRemoteStream("Codex reported an unspecified compaction error.");
    }
    if (event.type === "response.failed") {
      throw new PermanentRemoteError("Codex remote compaction failed.");
    }
    if (event.type === "response.incomplete") {
      throw new IncompleteRemoteStream("Codex remote compaction was incomplete.");
    }
    if (
      event.type === "response.output_item.done" &&
      Value.Check(RESPONSES_COMPACTION_ITEM_SCHEMA, event.item)
    ) {
      compacted.push(event.item);
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      finished = true;
      usage = isObject(event.response) ? event.response.usage : undefined;
    }
  };

  while (true) {
    const chunk = await reader.read();
    const rawChunk: unknown = chunk.value;
    if (rawChunk !== undefined && !(rawChunk instanceof Uint8Array)) {
      throw new PermanentRemoteError("Codex returned a non-byte compaction stream chunk.");
    }
    pending += decoder.decode(rawChunk, { stream: !chunk.done }).replace(/\r\n/g, "\n");
    let separator = pending.indexOf("\n\n");
    while (separator !== -1) {
      consumeEvent(pending.slice(0, separator));
      pending = pending.slice(separator + 2);
      separator = pending.indexOf("\n\n");
    }
    if (chunk.done) break;
  }
  if (pending.trim()) consumeEvent(pending);

  if (!finished) throw new IncompleteRemoteStream("Codex stream ended before response.completed.");
  if (compacted.length !== 1) {
    throw new PermanentRemoteError(
      `Codex returned ${compacted.length} compaction items; exactly one is required.`,
    );
  }
  const compactionItem = compacted[0];
  if (compactionItem === undefined) {
    throw new PermanentRemoteError("Codex compaction output has no compaction item.");
  }
  return { item: compactionItem, usage };
}

export function responseUsage(
  model: Model<Api>,
  value: unknown,
  priority: boolean,
): Usage | undefined {
  if (!isObject(value)) return undefined;
  const totalInput = isNumber(value.input_tokens) ? value.input_tokens : 0;
  const output = isNumber(value.output_tokens) ? value.output_tokens : 0;
  const inputDetails = isObject(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const cacheRead = isNumber(inputDetails?.cached_tokens) ? inputDetails.cached_tokens : 0;
  const cacheWrite = isNumber(inputDetails?.cache_write_tokens)
    ? inputDetails.cache_write_tokens
    : 0;
  const usage: Usage = {
    input: Math.max(0, totalInput - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    totalTokens: isNumber(value.total_tokens) ? value.total_tokens : totalInput + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);

  if (priority) {
    const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total =
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  }
  return usage;
}

export async function collectRemoteCompaction(
  events: AsyncIterable<JsonRecord>,
  accountingModel: Model<Api>,
  priority: boolean,
): Promise<RemoteCompactionResponse> {
  const compacted: ResponsesCompactionItem[] = [];
  let finished = false;
  let usageValue: unknown;

  for await (const event of events) {
    if (
      event.type === "response.output_item.done" &&
      Value.Check(RESPONSES_COMPACTION_ITEM_SCHEMA, event.item)
    ) {
      compacted.push(structuredClone(event.item));
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      finished = true;
      if (isObject(event.response)) {
        usageValue = event.response.usage;
        if (Array.isArray(event.response["output"])) {
          for (const item of event.response["output"]) {
            if (
              Value.Check(RESPONSES_COMPACTION_ITEM_SCHEMA, item) &&
              !compacted.some(
                (existing) =>
                  (isString(existing.id) && isString(item.id) && existing.id === item.id) ||
                  JSON.stringify(existing) === JSON.stringify(item),
              )
            ) {
              compacted.push(structuredClone(item));
            }
          }
        }
      }
    }
  }

  if (!finished) throw new Error("Codex stream ended before response.completed.");
  if (compacted.length !== 1) {
    throw new Error(
      `Codex returned ${compacted.length} compaction items; exactly one is required.`,
    );
  }
  const compactionItem = compacted[0];
  if (compactionItem === undefined) {
    throw new Error("Codex compaction output has no compaction item.");
  }
  if (!isString(compactionItem.encrypted_content)) {
    throw new Error("Codex compaction output did not contain encrypted_content.");
  }

  const usage = responseUsage(accountingModel, usageValue, priority);
  const result: RemoteCompactionResponse = { item: compactionItem };
  if (usage) result.usage = usage;
  return result;
}

export async function requestRemoteCompaction(options: {
  endpoint: string;
  headers: Headers;
  payload: JsonRecord;
  accountingModel: Model<Api>;
  priority: boolean;
  signal?: AbortSignal | undefined;
  fetcher?: typeof fetch | undefined;
}): Promise<RemoteCompactionResponse> {
  const fetcher = options.fetcher ?? fetch;
  let lastFailure: Error | undefined;

  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const init: RequestInit = {
        method: "POST",
        headers: options.headers,
        body: JSON.stringify(options.payload),
      };
      if (options.signal) init.signal = options.signal;
      const response = await fetcher(options.endpoint, init);

      if (!response.ok) {
        let body = "";
        let bodyReadFailure: unknown;
        try {
          body = await response.text();
        } catch (error) {
          bodyReadFailure = error;
        }
        const message = `Codex remote compaction failed (${response.status}): ${body || response.statusText}`;
        if (!retryableStatus(response.status)) {
          throw bodyReadFailure === undefined
            ? new PermanentRemoteError(message)
            : new PermanentRemoteError(message, { cause: bodyReadFailure });
        }
        const statusError =
          bodyReadFailure === undefined
            ? new Error(message)
            : new Error(message, { cause: bodyReadFailure });
        if (attempt === REQUEST_RETRIES) throw statusError;
        lastFailure = statusError;
        await wait(serverRetryDelay(response) ?? 1000 * 2 ** attempt, options.signal);
        continue;
      }

      const result = await readCompactionStream(response);
      const usage = responseUsage(options.accountingModel, result.usage, options.priority);
      const compacted: RemoteCompactionResponse = { item: result.item };
      if (usage) compacted.usage = usage;
      return compacted;
    } catch (cause) {
      if (cause instanceof PermanentRemoteError) throw cause;
      if (options.signal?.aborted) {
        throw new Error("Codex remote compaction was aborted.", { cause });
      }
      const error = errorFromThrown(
        cause,
        "Codex remote compaction failed with a non-Error value.",
      );
      lastFailure = error;
      if (attempt === REQUEST_RETRIES) throw error;
      await wait(1000 * 2 ** attempt, options.signal);
    }
  }

  throw lastFailure ?? new Error("Codex remote compaction failed.");
}
