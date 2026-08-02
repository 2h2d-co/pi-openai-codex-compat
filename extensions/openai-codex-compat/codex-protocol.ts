import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

export const REMOTE_COMPACTION_BETA = "remote_compaction_v2";
export const RETAINED_CONTEXT_BUDGET = 64_000;

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_RETRIES = 2;
const UTF8_BYTES_PER_TOKEN = 4;

export interface JsonRecord {
  [key: string]: unknown;
  type?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  verbosity?: unknown;
  encrypted_content?: unknown;
  input?: unknown;
  messages?: unknown;
  previous_response_id?: unknown;
  include?: unknown;
  model?: unknown;
  store?: unknown;
  stream?: unknown;
  instructions?: unknown;
  parallel_tool_calls?: unknown;
  tool_choice?: unknown;
  prompt_cache_key?: unknown;
  tools?: unknown;
  service_tier?: unknown;
  chatgpt_account_id?: unknown;
  message?: unknown;
  item?: unknown;
  response?: unknown;
  usage?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: unknown;
  cached_tokens?: unknown;
  cache_write_tokens?: unknown;
  total_tokens?: unknown;
  v?: unknown;
  id?: unknown;
  phase?: unknown;
  data?: unknown;
  mimeType?: unknown;
  stopReason?: unknown;
  thinkingSignature?: unknown;
  textSignature?: unknown;
  name?: unknown;
  arguments?: unknown;
  toolCallId?: unknown;
  addedToolNames?: unknown;
  kind?: unknown;
  version?: unknown;
  modelId?: unknown;
  history?: unknown;
}

export interface ResponsesItem extends JsonRecord {
  type?: string;
}

export type RemoteCompactionResponse = {
  item: ResponsesItem;
  usage?: Usage;
};

export function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isResponsesItem(value: unknown): value is ResponsesItem {
  if (!isObject(value)) return false;
  return (
    typeof value.type === "string" ||
    (typeof value.role === "string" &&
      (typeof value.content === "string" || Array.isArray(value.content)))
  );
}

export function approximateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / UTF8_BYTES_PER_TOKEN);
}

export function messageTextTokens(item: ResponsesItem): number {
  if (item.type !== undefined && item.type !== "message") return 0;
  if (typeof item.content === "string") return approximateTokens(item.content);
  if (!Array.isArray(item.content)) return 0;

  let tokens = 0;
  for (const part of item.content) {
    if (!isObject(part) || typeof part.text !== "string") continue;
    if (part.type === "input_text" || part.type === "output_text") {
      tokens += approximateTokens(part.text);
    }
  }
  return tokens;
}

function splitUtf8Bytes(
  text: string,
  beginningBytes: number,
  endBytes: number,
): { removedCharacters: number; prefix: string; suffix: string } {
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

function shortenMessage(item: ResponsesItem, tokenLimit: number): ResponsesItem | undefined {
  if (tokenLimit <= 0 || (item.type !== undefined && item.type !== "message")) return undefined;
  const result = structuredClone(item);

  if (typeof result.content === "string") {
    result.content = truncateMiddleWithTokenBudget(result.content, tokenLimit);
    return result.content ? result : undefined;
  }
  if (!Array.isArray(result.content)) return result;

  let remaining = tokenLimit;
  const content: unknown[] = [];
  for (const part of result.content) {
    if (
      !isObject(part) ||
      typeof part.text !== "string" ||
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
  return content.length > 0 ? result : undefined;
}

function retainedRole(item: ResponsesItem): boolean {
  return (
    (item.type === undefined || item.type === "message") &&
    (item.role === "user" || item.role === "developer" || item.role === "system")
  );
}

/**
 * Reproduce Codex remote-compaction-v2 history installation: select recent
 * user/developer/system messages from newest to oldest, then restore their
 * chronological order. The oldest selected message may be truncated.
 */
export function selectRetainedContext(
  history: readonly ResponsesItem[],
  budget = RETAINED_CONTEXT_BUDGET,
): ResponsesItem[] {
  let remaining = budget;
  const newestFirst: ResponsesItem[] = [];

  for (let index = history.length - 1; index >= 0 && remaining > 0; index--) {
    const item = history[index]!;
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
  previousHistory: readonly ResponsesItem[],
  compactionItem: ResponsesItem,
): ResponsesItem[] {
  if (
    compactionItem.type !== "compaction" ||
    typeof compactionItem.encrypted_content !== "string"
  ) {
    throw new Error("Codex returned an invalid remote compaction item.");
  }
  return [...selectRetainedContext(previousHistory), structuredClone(compactionItem)];
}

export function responsesEndpoint(baseUrl?: string): string {
  const base = (baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
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
  history: readonly ResponsesItem[];
  instructions: string;
  sessionId: string;
  fallbackTools?: unknown[] | undefined;
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
  payload.parallel_tool_calls =
    typeof payload.parallel_tool_calls === "boolean" ? payload.parallel_tool_calls : true;
  payload.tool_choice ??= "auto";
  payload.include = [...new Set([...include, "reasoning.encrypted_content"])];
  payload.prompt_cache_key = options.sessionId;
  payload.text =
    isObject(payload.text) && typeof payload.text.verbosity === "string"
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
    const claims = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8")) as JsonRecord;
    const openAIClaims = claims["https://api.openai.com/auth"];
    if (!isObject(openAIClaims) || typeof openAIClaims.chatgpt_account_id !== "string") {
      throw new Error("account id missing");
    }
    return openAIClaims.chatgpt_account_id;
  } catch {
    throw new Error("Could not read the ChatGPT account id from OpenAI Codex authentication.");
  }
}

export function remoteCompactionHeaders(options: {
  token: string;
  providerHeaders?: Record<string, string> | undefined;
  sessionId: string;
}): Headers {
  const headers = new Headers(options.providerHeaders);
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
): Promise<{ item: ResponsesItem; usage?: unknown }> {
  if (!response.body)
    throw new IncompleteRemoteStream("Codex returned an empty compaction stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const compacted: ResponsesItem[] = [];
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
    } catch {
      throw new PermanentRemoteError("Codex returned malformed compaction stream data.");
    }
    if (!isObject(event)) return;

    if (event.type === "error") {
      if (typeof event.message === "string" && event.message.trim()) {
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
    if (event.type === "response.output_item.done" && isResponsesItem(event.item)) {
      if (event.item.type === "compaction") compacted.push(event.item);
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      finished = true;
      usage = isObject(event.response) ? event.response.usage : undefined;
    }
  };

  while (true) {
    const chunk = await reader.read();
    pending += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
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
  if (typeof compacted[0]!.encrypted_content !== "string") {
    throw new PermanentRemoteError("Codex compaction output did not contain encrypted_content.");
  }

  return { item: compacted[0]!, usage };
}

export function responseUsage(
  model: Model<any>,
  value: unknown,
  priority: boolean,
): Usage | undefined {
  if (!isObject(value)) return undefined;
  const totalInput = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const output = typeof value.output_tokens === "number" ? value.output_tokens : 0;
  const inputDetails = isObject(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const cacheRead =
    typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
  const cacheWrite =
    typeof inputDetails?.cache_write_tokens === "number" ? inputDetails.cache_write_tokens : 0;
  const usage: Usage = {
    input: Math.max(0, totalInput - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : totalInput + output,
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
  accountingModel: Model<any>,
  priority: boolean,
): Promise<RemoteCompactionResponse> {
  const compacted: ResponsesItem[] = [];
  let finished = false;
  let usageValue: unknown;

  for await (const event of events) {
    if (event.type === "response.output_item.done" && isResponsesItem(event.item)) {
      if (event.item.type === "compaction") compacted.push(structuredClone(event.item));
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      finished = true;
      if (isObject(event.response)) {
        usageValue = event.response.usage;
        if (Array.isArray(event.response["output"])) {
          for (const item of event.response["output"]) {
            if (
              isResponsesItem(item) &&
              item.type === "compaction" &&
              !compacted.some(
                (existing) =>
                  (typeof existing.id === "string" &&
                    typeof item.id === "string" &&
                    existing.id === item.id) ||
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
  if (typeof compacted[0]!.encrypted_content !== "string") {
    throw new Error("Codex compaction output did not contain encrypted_content.");
  }

  const usage = responseUsage(accountingModel, usageValue, priority);
  return {
    item: compacted[0]!,
    ...(usage ? { usage } : {}),
  };
}

export async function requestRemoteCompaction(options: {
  endpoint: string;
  headers: Headers;
  payload: JsonRecord;
  accountingModel: Model<any>;
  priority: boolean;
  signal?: AbortSignal | undefined;
  fetcher?: typeof fetch | undefined;
}): Promise<RemoteCompactionResponse> {
  const fetcher = options.fetcher ?? fetch;
  let lastFailure: unknown;

  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      const response = await fetcher(options.endpoint, {
        method: "POST",
        headers: options.headers,
        body: JSON.stringify(options.payload),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const message = `Codex remote compaction failed (${response.status}): ${body || response.statusText}`;
        if (!retryableStatus(response.status)) throw new PermanentRemoteError(message);
        if (attempt === REQUEST_RETRIES) throw new Error(message);
        lastFailure = new Error(message);
        await wait(serverRetryDelay(response) ?? 1000 * 2 ** attempt, options.signal);
        continue;
      }

      const result = await readCompactionStream(response);
      const usage = responseUsage(options.accountingModel, result.usage, options.priority);
      return {
        item: result.item,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted || error instanceof PermanentRemoteError) throw error;
      lastFailure = error;
      if (attempt === REQUEST_RETRIES) throw error;
      await wait(1000 * 2 ** attempt, options.signal);
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error("Codex remote compaction failed.");
}
