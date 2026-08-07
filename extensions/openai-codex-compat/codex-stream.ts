import {
  calculateCost,
  parseStreamingJson,
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
 * Focused adaptation of @earendil-works/pi-ai@0.83.0
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

type ProcessCodexStreamOptions = {
  applyServiceTierPricing?(usage: Usage, responseServiceTier: string | undefined): void;
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
  return typeof event["output_index"] === "number" ? event["output_index"] : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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
  const value = block.arguments[property];
  return typeof value === "string" ? value : "";
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

function responseItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject);
}

function itemContentText(item: JsonRecord): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(isObject)
    .map((content) =>
      typeof content.text === "string"
        ? content.text
        : typeof content["refusal"] === "string"
          ? content["refusal"]
          : "",
    )
    .join("");
}

function reasoningText(item: JsonRecord): string {
  const summary = Array.isArray(item["summary"])
    ? item["summary"]
        .filter(isObject)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n\n")
    : "";
  if (summary) return summary;
  return Array.isArray(item.content)
    ? item.content
        .filter(isObject)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n\n")
    : "";
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  return typeof status === "string" && CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus)
    ? (status as CodexResponseStatus)
    : undefined;
}

function mapStopReason(
  status: CodexResponseStatus | undefined,
  incompleteReason: string | undefined,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
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
  stream: AssistantMessageEventStream,
  model: Model<any>,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  options?: ProcessCodexStreamOptions,
): Promise<void> {
  let terminal = false;
  const slots = new Map<number, OutputSlot>();
  const reasoningById = new Map<string, ThinkingContent>();
  const applyMessagePhaseStopReason = (item: JsonRecord): void => {
    if (item.type === "message" && item["phase"] === "final_answer") {
      output.stopReason = "stop";
    }
  };

  const getSlot = <TType extends OutputSlot["type"]>(
    index: number,
    type: TType,
  ): Extract<OutputSlot, { type: TType }> | undefined => {
    const slot = slots.get(index);
    return slot?.type === type ? (slot as Extract<OutputSlot, { type: TType }>) : undefined;
  };

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
        partialJson: typeof item.arguments === "string" ? item.arguments : "",
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
      const input = typeof item["input"] === "string" ? item["input"] : "";
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

  const finalize = (response: JsonRecord): void => {
    terminal = true;
    if (typeof response.id === "string") output.responseId = response.id;
    const usage = isObject(response.usage) ? response.usage : undefined;
    if (usage) {
      const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
      const cached = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
      const cacheWrite =
        typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
      const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const outputDetails = isObject(usage["output_tokens_details"])
        ? usage["output_tokens_details"]
        : undefined;
      output.usage = {
        input: Math.max(0, input - cached - cacheWrite),
        output: outputTokens,
        cacheRead: cached,
        cacheWrite,
        reasoning:
          typeof outputDetails?.["reasoning_tokens"] === "number"
            ? outputDetails["reasoning_tokens"]
            : 0,
        totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens || 0 : 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    calculateCost(model, output.usage);
    options?.applyServiceTierPricing?.(
      output.usage,
      typeof response.service_tier === "string" ? response.service_tier : undefined,
    );
    for (const item of responseItems(response["output"])) {
      if (item.type !== "reasoning" || typeof item.id !== "string") continue;
      const block = reasoningById.get(item.id);
      if (!block?.thinkingSignature || typeof item.encrypted_content !== "string") continue;
      const stored = JSON.parse(block.thinkingSignature) as JsonRecord;
      if (typeof stored.encrypted_content !== "string") {
        block.thinkingSignature = JSON.stringify({
          ...stored,
          encrypted_content: item.encrypted_content,
        });
      }
    }
    const status = normalizeCodexStatus(response["status"]);
    const incompleteDetails = isObject(response["incomplete_details"])
      ? response["incomplete_details"]
      : undefined;
    const incompleteReason =
      typeof incompleteDetails?.["reason"] === "string" ? incompleteDetails["reason"] : undefined;
    const rawStopReason =
      status === "incomplete" && incompleteReason ? `${status}.${incompleteReason}` : status;
    if (rawStopReason === undefined) delete output.rawStopReason;
    else output.rawStopReason = rawStopReason;
    const mappedStop = mapStopReason(status, incompleteReason);
    output.stopReason = mappedStop.stopReason;
    if (mappedStop.errorMessage === undefined) delete output.errorMessage;
    else output.errorMessage = mappedStop.errorMessage;
    if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall")) {
      output.stopReason = "toolUse";
    }
  };

  for await (const event of events) {
    const index = outputIndex(event);
    if (event.type === "response.created" && isObject(event.response)) {
      if (typeof event.response.id === "string") output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added" && isObject(event.item)) {
      createSlot(index, event.item);
    } else if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    ) {
      const slot = getSlot(index, "thinking");
      if (!slot || typeof event["delta"] !== "string") continue;
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
      if (!slot || typeof event["delta"] !== "string") continue;
      slot.block.text += event["delta"];
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: event["delta"],
        partial: output,
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const slot = getSlot(index, "toolCall");
      if (!slot || slot.block.partialJson === undefined || typeof event["delta"] !== "string") {
        continue;
      }
      slot.block.partialJson += event["delta"];
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);
      pushToolDelta(slot, event["delta"]);
    } else if (event.type === "response.function_call_arguments.done") {
      const slot = getSlot(index, "toolCall");
      if (!slot || slot.block.partialJson === undefined || typeof event.arguments !== "string") {
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
      if (!slot || typeof event["delta"] !== "string") continue;
      pushToolDelta(
        slot,
        appendCustomInput(slot.block, customInput(slot.block) + event["delta"], false),
      );
    } else if (event.type === "response.custom_tool_call_input.done") {
      const slot = getSlot(index, "toolCall");
      if (!slot || typeof event["input"] !== "string") continue;
      pushToolDelta(slot, appendCustomInput(slot.block, event["input"], true));
    } else if (event.type === "response.output_item.done" && isObject(event.item)) {
      const item = event.item;
      applyMessagePhaseStopReason(item);
      const slot = slotFor(index, item);
      if (item.type === "reasoning" && slot?.type === "thinking") {
        slot.block.thinking = reasoningText(item) || slot.block.thinking;
        slot.block.thinkingSignature = JSON.stringify(item);
        if (typeof item.id === "string") reasoningById.set(item.id, slot.block);
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
        if (typeof item.id === "string") {
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
        const argumentsJson =
          typeof item.arguments === "string" ? item.arguments : slot.block.partialJson || "{}";
        slot.block.arguments = parseStreamingJson(argumentsJson);
        delete slot.block.partialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex: slot.contentIndex,
          toolCall: slot.block,
          partial: output,
        });
        trackCompleted(slot);
        slots.delete(index);
      } else if (item.type === "custom_tool_call" && slot?.type === "toolCall") {
        slot.block.name = piToolCallName(item);
        const input = typeof item["input"] === "string" ? item["input"] : customInput(slot.block);
        pushToolDelta(slot, appendCustomInput(slot.block, input, true));
        delete slot.block.customInput;
        stream.push({
          type: "toolcall_end",
          contentIndex: slot.contentIndex,
          toolCall: slot.block,
          partial: output,
        });
        trackCompleted(slot);
        slots.delete(index);
      }
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
      output.errorMessage =
        typeof error?.["message"] === "string" ? error["message"] : "Codex response failed";
    }
  }

  if (!terminal) {
    throw new Error("OpenAI Responses stream ended before a terminal response event");
  }
}
