import { isAllowedString, isNumber, isString } from "./value-contracts.ts";
import {
  calculateCost,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TextContent,
  type TextSignatureV1,
  type ThinkingContent,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { CODEX_NAMESPACED_TOOL_NAMES, namespacedToolCallName } from "./namespaced-tools.ts";

/**
 * Focused adaptation of @earendil-works/pi-ai@0.84.1
 * src/api/openai-responses-shared.ts stream processing.
 */

type GrammarJsonBuffer = {
  input: string;
  started: boolean;
  closed: boolean;
};

type StreamingToolCall = ToolCall & {
  partialJson?: string;
  customInput?: {
    property: string;
    jsonBuffer: GrammarJsonBuffer;
  };
};

type OutputSlot =
  | { type: "thinking"; block: ThinkingContent; contentIndex: number }
  | { type: "text"; block: TextContent; contentIndex: number }
  | { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallSlot = Extract<OutputSlot, { type: "toolCall" }>;
type ThinkingSlot = Extract<OutputSlot, { type: "thinking" }>;
type TextSlot = Extract<OutputSlot, { type: "text" }>;

type ProcessCodexStreamOptions = {
  applyServiceTierPricing?: (usage: Usage, responseServiceTier: string | undefined) => void;
  attemptState?: CodexStreamAttemptState;
};

export type CodexStreamAttemptState = {
  startedContentIndexes: Set<number>;
  completedContentIndexes: Set<number>;
};

type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress";

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

function outputIndex(event: JsonRecord): number {
  return isNumber(event["output_index"]) ? event["output_index"] : 0;
}

function stringValue(value: unknown): string {
  return isString(value) ? value : "";
}

function piToolCallName(item: JsonRecord): string {
  const wireName = stringValue(item.name);
  const name =
    item["namespace"] === undefined
      ? wireName
      : namespacedToolCallName(item["namespace"], wireName);
  if (item["namespace"] === undefined && CODEX_NAMESPACED_TOOL_NAMES.has(name)) {
    throw new Error(`Codex returned namespaced tool "${name}" as a flat function call.`);
  }
  return name;
}

function encodeTextSignature(id: string, phase: unknown): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase === "commentary" || phase === "final_answer") payload.phase = phase;
  return JSON.stringify(payload);
}

function appendGrammarDelta(
  buffer: GrammarJsonBuffer,
  property: string,
  nextInput: string,
  close: boolean,
): string | undefined {
  if (buffer.closed) {
    if (close && nextInput === buffer.input) return undefined;
    throw new Error(`grammar tool input for property "${property}" changed after it was closed`);
  }
  if (!nextInput.startsWith(buffer.input)) {
    throw new Error(`grammar tool input for property "${property}" changed non-monotonically`);
  }
  const inputDelta = nextInput.slice(buffer.input.length);
  if (!close && inputDelta.length === 0) return undefined;

  let delta = "";
  if (!buffer.started) {
    delta = `{${JSON.stringify(property)}:"`;
    buffer.started = true;
  }
  delta += JSON.stringify(inputDelta).slice(1, -1);
  buffer.input = nextInput;
  if (close) {
    delta += '"}';
    buffer.closed = true;
  }
  return delta;
}

function customInput(block: StreamingToolCall): string {
  const property = block.customInput?.property;
  if (!property) return "";
  const value: unknown = block.arguments[property];
  return isString(value) ? value : "";
}

function appendCustomInput(
  block: StreamingToolCall,
  nextInput: string,
  close: boolean,
): string | undefined {
  const state = block.customInput;
  if (!state) return undefined;
  const delta = appendGrammarDelta(state.jsonBuffer, state.property, nextInput, close);
  block.arguments = { [state.property]: nextInput };
  return delta;
}

function itemContentText(item: JsonRecord): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(isObject)
    .map((content) =>
      isString(content.text)
        ? content.text
        : isString(content["refusal"])
          ? content["refusal"]
          : "",
    )
    .join("");
}

function reasoningText(item: JsonRecord): string {
  const summary = Array.isArray(item["summary"])
    ? item["summary"]
        .filter(isObject)
        .map((part) => (isString(part.text) ? part.text : ""))
        .join("\n\n")
    : "";
  if (summary) return summary;
  return Array.isArray(item.content)
    ? item.content
        .filter(isObject)
        .map((part) => (isString(part.text) ? part.text : ""))
        .join("\n\n")
    : "";
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  return isAllowedString(status, CODEX_RESPONSE_STATUSES) ? status : undefined;
}

interface CodexStopReason {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
}

function mapStopReason(
  status: CodexResponseStatus | undefined,
  incompleteReason: string | undefined,
): CodexStopReason {
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return { stopReason: "length" };
    return {
      stopReason: "error",
      errorMessage: incompleteReason
        ? `Response incomplete: ${incompleteReason}`
        : "Response incomplete without a provider reason",
    };
  }
  if (status === "failed" || status === "cancelled") return { stopReason: "error" };
  return { stopReason: "stop" };
}

export async function processCodexStream(
  events: AsyncIterable<JsonRecord>,
  output: AssistantMessage,
  stream: Pick<AssistantMessageEventStream, "push">,
  model: Model<Api>,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  options?: ProcessCodexStreamOptions,
): Promise<void> {
  let terminal = false;
  const slots = new Map<number, OutputSlot>();
  const completedOutputItems = new Set<string>();
  const completedToolCallContentIndexes = new Set<number>();
  const applyMessagePhaseStopReason = (item: JsonRecord): void => {
    if (item.type === "message" && item["phase"] === "final_answer") {
      output.stopReason = "stop";
    }
  };

  function getSlot(index: number, type: "thinking"): ThinkingSlot | undefined;
  function getSlot(index: number, type: "text"): TextSlot | undefined;
  function getSlot(index: number, type: "toolCall"): ToolCallSlot | undefined;
  function getSlot(index: number, type: OutputSlot["type"]): OutputSlot | undefined {
    const slot = slots.get(index);
    return slot?.type === type ? slot : undefined;
  }

  const pushToolDelta = (slot: ToolCallSlot, delta: string | undefined): void => {
    if (delta === undefined) return;
    stream.push({
      type: "toolcall_delta",
      contentIndex: slot.contentIndex,
      delta,
      partial: output,
    });
  };

  const trackStarted = <TSlot extends OutputSlot>(slot: TSlot): TSlot => {
    options?.attemptState?.startedContentIndexes.add(slot.contentIndex);
    return slot;
  };

  const trackCompleted = (slot: OutputSlot): void => {
    options?.attemptState?.completedContentIndexes.add(slot.contentIndex);
  };

  const createSlot = (index: number, item: JsonRecord): OutputSlot | undefined => {
    if (item.type === "reasoning") {
      const block: ThinkingContent = { type: "thinking", thinking: "" };
      output.content.push(block);
      const slot = trackStarted({
        type: "thinking",
        block,
        contentIndex: output.content.length - 1,
      } satisfies OutputSlot);
      slots.set(index, slot);
      stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "message") {
      applyMessagePhaseStopReason(item);
      const block: TextContent = { type: "text", text: "" };
      output.content.push(block);
      const slot = trackStarted({
        type: "text",
        block,
        contentIndex: output.content.length - 1,
      } satisfies OutputSlot);
      slots.set(index, slot);
      stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "function_call") {
      const name = piToolCallName(item);
      const block: StreamingToolCall = {
        type: "toolCall",
        id: `${stringValue(item["call_id"])}|${stringValue(item.id)}`,
        name,
        arguments: {},
        partialJson: isString(item.arguments) ? item.arguments : "",
      };
      output.content.push(block);
      const slot = trackStarted({
        type: "toolCall",
        block,
        contentIndex: output.content.length - 1,
      } satisfies OutputSlot);
      slots.set(index, slot);
      stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "custom_tool_call") {
      const name = piToolCallName(item);
      const property = grammarToolInputProperties.get(name) ?? "input";
      const input = isString(item["input"]) ? item["input"] : "";
      const block: StreamingToolCall = {
        type: "toolCall",
        id: `${stringValue(item["call_id"])}|${stringValue(item.id)}`,
        name,
        arguments: { [property]: input },
        customInput: {
          property,
          jsonBuffer: { input: "", started: false, closed: false },
        },
      };
      output.content.push(block);
      const slot = trackStarted({
        type: "toolCall",
        block,
        contentIndex: output.content.length - 1,
      } satisfies OutputSlot);
      slots.set(index, slot);
      stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    return undefined;
  };

  const slotFor = (index: number, item: JsonRecord): OutputSlot | undefined =>
    slots.get(index) ?? createSlot(index, item);

  const outputItemKey = (index: number, item: JsonRecord): string => {
    if (isString(item.id)) return `id:${item.id}`;
    const itemType = isString(item.type) ? item.type : JSON.stringify(item.type);
    if (isString(item["call_id"])) {
      return `call:${itemType ?? "undefined"}:${item["call_id"]}`;
    }
    return `index:${String(index)}:${itemType ?? "undefined"}`;
  };

  const completeOutputItem = (index: number, item: JsonRecord): void => {
    const key = outputItemKey(index, item);
    if (completedOutputItems.has(key)) return;
    completedOutputItems.add(key);
    applyMessagePhaseStopReason(item);
    const slot = slotFor(index, item);
    if (item.type === "reasoning" && slot?.type === "thinking") {
      slot.block.thinking = reasoningText(item) || slot.block.thinking;
      slot.block.thinkingSignature = JSON.stringify(item);
      stream.push({
        type: "thinking_end",
        contentIndex: slot.contentIndex,
        content: slot.block.thinking,
        partial: output,
      });
      trackCompleted(slot);
      slots.delete(index);
    } else if (item.type === "message" && slot?.type === "text") {
      slot.block.text = itemContentText(item);
      if (isString(item.id)) {
        slot.block.textSignature = encodeTextSignature(item.id, item["phase"]);
      }
      stream.push({
        type: "text_end",
        contentIndex: slot.contentIndex,
        content: slot.block.text,
        partial: output,
      });
      trackCompleted(slot);
      slots.delete(index);
    } else if (
      item.type === "function_call" &&
      slot?.type === "toolCall" &&
      slot.block.partialJson !== undefined
    ) {
      slot.block.name = piToolCallName(item);
      const argumentsJson = isString(item.arguments)
        ? item.arguments
        : slot.block.partialJson || "{}";
      slot.block.arguments = parseStreamingJson(argumentsJson);
      delete slot.block.partialJson;
      stream.push({
        type: "toolcall_end",
        contentIndex: slot.contentIndex,
        toolCall: slot.block,
        partial: output,
      });
      trackCompleted(slot);
      completedToolCallContentIndexes.add(slot.contentIndex);
      slots.delete(index);
    } else if (item.type === "custom_tool_call" && slot?.type === "toolCall") {
      slot.block.name = piToolCallName(item);
      const input = isString(item["input"]) ? item["input"] : customInput(slot.block);
      pushToolDelta(slot, appendCustomInput(slot.block, input, true));
      delete slot.block.customInput;
      stream.push({
        type: "toolcall_end",
        contentIndex: slot.contentIndex,
        toolCall: slot.block,
        partial: output,
      });
      trackCompleted(slot);
      completedToolCallContentIndexes.add(slot.contentIndex);
      slots.delete(index);
    }
  };

  const finalize = (response: JsonRecord): void => {
    terminal = true;
    if (isString(response.id)) output.responseId = response.id;
    const usage = isObject(response.usage) ? response.usage : undefined;
    if (usage) {
      const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
      const cached = isNumber(details?.cached_tokens) ? details.cached_tokens : 0;
      const cacheWrite = isNumber(details?.cache_write_tokens) ? details.cache_write_tokens : 0;
      const input = isNumber(usage.input_tokens) ? usage.input_tokens : 0;
      const outputTokens = isNumber(usage.output_tokens) ? usage.output_tokens : 0;
      const outputDetails = isObject(usage["output_tokens_details"])
        ? usage["output_tokens_details"]
        : undefined;
      output.usage = {
        input: Math.max(0, input - cached - cacheWrite),
        output: outputTokens,
        cacheRead: cached,
        cacheWrite,
        reasoning: isNumber(outputDetails?.["reasoning_tokens"])
          ? outputDetails["reasoning_tokens"]
          : 0,
        totalTokens: isNumber(usage.total_tokens) ? usage.total_tokens || 0 : 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    calculateCost(model, output.usage);
    options?.applyServiceTierPricing?.(
      output.usage,
      isString(response.service_tier) ? response.service_tier : undefined,
    );
    const status = normalizeCodexStatus(response["status"]);
    const incompleteDetails = isObject(response["incomplete_details"])
      ? response["incomplete_details"]
      : undefined;
    const incompleteReason = isString(incompleteDetails?.["reason"])
      ? incompleteDetails["reason"]
      : undefined;
    const rawStopReason =
      status === "incomplete" && incompleteReason ? `${status}.${incompleteReason}` : status;
    if (rawStopReason === undefined) delete output.rawStopReason;
    else output.rawStopReason = rawStopReason;
    const mappedStop = mapStopReason(status, incompleteReason);
    output.stopReason = mappedStop.stopReason;
    if (mappedStop.errorMessage === undefined) delete output.errorMessage;
    else output.errorMessage = mappedStop.errorMessage;
    if (
      output.stopReason === "stop" &&
      [...completedToolCallContentIndexes].some(
        (contentIndex) => output.content[contentIndex]?.type === "toolCall",
      )
    ) {
      output.stopReason = "toolUse";
    }
  };

  for await (const event of events) {
    const index = outputIndex(event);
    if (event.type === "response.created" && isObject(event.response)) {
      if (isString(event.response.id)) output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added" && isObject(event.item)) {
      createSlot(index, event.item);
    } else if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    ) {
      const slot = getSlot(index, "thinking");
      if (!slot || !isString(event["delta"])) continue;
      slot.block.thinking += event["delta"];
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: event["delta"],
        partial: output,
      });
    } else if (event.type === "response.reasoning_summary_part.done") {
      const slot = getSlot(index, "thinking");
      if (!slot) continue;
      slot.block.thinking += "\n\n";
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: "\n\n",
        partial: output,
      });
    } else if (
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta"
    ) {
      const slot = getSlot(index, "text");
      if (!slot || !isString(event["delta"])) continue;
      slot.block.text += event["delta"];
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: event["delta"],
        partial: output,
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const slot = getSlot(index, "toolCall");
      if (!slot || slot.block.partialJson === undefined || !isString(event["delta"])) {
        continue;
      }
      slot.block.partialJson += event["delta"];
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);
      pushToolDelta(slot, event["delta"]);
    } else if (event.type === "response.function_call_arguments.done") {
      const slot = getSlot(index, "toolCall");
      if (!slot || slot.block.partialJson === undefined || !isString(event.arguments)) {
        continue;
      }
      const previous = slot.block.partialJson;
      slot.block.partialJson = event.arguments;
      slot.block.arguments = parseStreamingJson(event.arguments);
      if (event.arguments.startsWith(previous)) {
        const delta = event.arguments.slice(previous.length);
        if (delta.length > 0) pushToolDelta(slot, delta);
      }
    } else if (event.type === "response.custom_tool_call_input.delta") {
      const slot = getSlot(index, "toolCall");
      if (!slot || !isString(event["delta"])) continue;
      pushToolDelta(
        slot,
        appendCustomInput(slot.block, customInput(slot.block) + event["delta"], false),
      );
    } else if (event.type === "response.custom_tool_call_input.done") {
      const slot = getSlot(index, "toolCall");
      if (!slot || !isString(event["input"])) continue;
      pushToolDelta(slot, appendCustomInput(slot.block, event["input"], true));
    } else if (event.type === "response.output_item.done" && isObject(event.item)) {
      completeOutputItem(index, event.item);
    } else if (
      (event.type === "response.completed" || event.type === "response.incomplete") &&
      isObject(event.response)
    ) {
      finalize(event.response);
    } else if (event.type === "response.failed") {
      const response = isObject(event.response) ? event.response : undefined;
      if (response) {
        finalize(response);
      } else {
        terminal = true;
      }
      output.stopReason = "error";
      output.rawStopReason ??= "failed";
      const error = isObject(response?.["error"]) ? response["error"] : undefined;
      output.errorMessage = isString(error?.["message"])
        ? error["message"]
        : "Codex response failed";
    }
  }

  if (!terminal) {
    throw new Error("OpenAI Responses stream ended before a terminal response event");
  }
}
