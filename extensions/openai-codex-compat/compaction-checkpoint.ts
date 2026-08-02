import { createHash } from "node:crypto";
import {
  buildSessionContext,
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  installCompactionItem,
  isObject,
  isResponsesItem,
  type JsonRecord,
  type ResponsesItem,
} from "./codex-protocol.ts";

export const CHECKPOINT_ENTRY_TYPE = "openai-codex-compat-remote-compaction";
export const CHECKPOINT_FORMAT_VERSION = 1;

export type CheckpointData = {
  kind: typeof CHECKPOINT_ENTRY_TYPE;
  version: typeof CHECKPOINT_FORMAT_VERSION;
  modelId: string;
  history: ResponsesItem[];
};

export type CheckpointSearch =
  | { kind: "absent" }
  | { kind: "corrupt"; entryIndex: number; entryId: string }
  | { kind: "found"; entryIndex: number; entryId: string; data: CheckpointData };

function asFunctionTool(tool: ToolInfo, deferred = false): ResponsesItem {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
    strict: null,
    ...(deferred ? { defer_loading: true } : {}),
  };
}

export function activeResponsesTools(
  allTools: readonly ToolInfo[],
  activeNames: readonly string[],
): unknown[] | undefined {
  const enabled = new Set(activeNames);
  const tools = allTools.filter((tool) => enabled.has(tool.name));
  return tools.length > 0 ? tools.map((tool) => asFunctionTool(tool)) : undefined;
}

function textParts(content: unknown): unknown[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((part): unknown[] => {
    if (!isObject(part)) return [];
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "input_text", text: part.text }];
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      return [
        {
          type: "input_image",
          detail: "auto",
          image_url: `data:${part.mimeType};base64,${part.data}`,
        },
      ];
    }
    return [];
  });
}

function outputForToolResult(message: JsonRecord, model: Model<any>): unknown {
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .flatMap((part) =>
      isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
  const images = content.filter((part) => isObject(part) && part.type === "image");

  if (images.length === 0 || !model.input.includes("image")) {
    if (text) return text;
    return images.length > 0 ? "(see attached image)" : "(no tool output)";
  }

  return [
    ...(text ? [{ type: "input_text", text }] : []),
    ...images.flatMap((image) =>
      typeof image.data === "string" && typeof image.mimeType === "string"
        ? [
            {
              type: "input_image",
              detail: "auto",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            },
          ]
        : [],
    ),
  ];
}

function decodeTextSignature(signature: unknown): {
  id?: string;
  phase?: "commentary" | "final_answer";
} {
  if (typeof signature !== "string" || !signature) return {};
  if (!signature.startsWith("{")) return { id: signature };

  try {
    const parsed = JSON.parse(signature) as JsonRecord;
    if (parsed.v !== 1 || typeof parsed.id !== "string") return {};
    const phase =
      parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
    return {
      id: parsed.id,
      ...(phase ? { phase } : {}),
    };
  } catch {
    return {};
  }
}

function assistantMessageId(
  signature: string | undefined,
  messageIndex: number,
  textIndex: number,
): string {
  const fallback =
    textIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textIndex}`;
  if (!signature) return fallback;
  return signature.length <= 64
    ? signature
    : `msg_${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

function reasoningFromSignature(signature: unknown): ResponsesItem | undefined {
  if (typeof signature !== "string") return undefined;
  try {
    const parsed = JSON.parse(signature);
    return isResponsesItem(parsed) && parsed.type === "reasoning" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Encode Pi's canonical messages into the OpenAI Responses history format. */
function encodeMessages(
  model: Model<any>,
  messages: Message[],
  allTools: readonly ToolInfo[],
): ResponsesItem[] {
  const encoded: ResponsesItem[] = [];
  const outstandingCalls = new Map<string, string>();
  const tools = new Map(allTools.map((tool) => [tool.name, tool]));
  const emittedDeferredTools = new Set<string>();

  const finishUnansweredCalls = () => {
    for (const callId of outstandingCalls.values()) {
      encoded.push({ type: "function_call_output", call_id: callId, output: "No result provided" });
    }
    outstandingCalls.clear();
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex] as unknown as JsonRecord;

    if (message.role === "user") {
      finishUnansweredCalls();
      const content = textParts(message.content);
      if (content.length > 0) encoded.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      finishUnansweredCalls();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      if (!Array.isArray(message.content)) continue;

      let textIndex = 0;
      for (const block of message.content) {
        if (!isObject(block)) continue;

        if (block.type === "thinking") {
          const reasoning = reasoningFromSignature(block.thinkingSignature);
          if (reasoning) encoded.push(reasoning);
          continue;
        }

        if (block.type === "text" && typeof block.text === "string") {
          const signature = decodeTextSignature(block.textSignature);
          encoded.push({
            type: "message",
            role: "assistant",
            id: assistantMessageId(signature.id, messageIndex, textIndex),
            status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            ...(signature.phase ? { phase: signature.phase } : {}),
          });
          textIndex++;
          continue;
        }

        if (block.type === "toolCall" && typeof block.id === "string") {
          const [callId, itemId] = block.id.split("|");
          outstandingCalls.set(block.id, callId!);
          encoded.push({
            type: "function_call",
            call_id: callId,
            ...(itemId?.startsWith("fc_") ? { id: itemId } : {}),
            name: typeof block.name === "string" ? block.name : "",
            arguments: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const [callId] = message.toolCallId.split("|");
      outstandingCalls.delete(message.toolCallId);
      encoded.push({
        type: "function_call_output",
        call_id: callId,
        output: outputForToolResult(message, model),
      });

      if (Array.isArray(message.addedToolNames)) {
        const added = message.addedToolNames.flatMap((name) => {
          if (typeof name !== "string" || !tools.has(name) || emittedDeferredTools.has(name))
            return [];
          emittedDeferredTools.add(name);
          return [tools.get(name)!];
        });
        if (added.length > 0) {
          const names = added.map((tool) => tool.name);
          const callId = `pi_tool_load_${createHash("sha256")
            .update(`${message.toolCallId}:${names.join(",")}`)
            .digest("hex")
            .slice(0, 16)}`;
          encoded.push({
            type: "tool_search_call",
            call_id: callId,
            execution: "client",
            status: "completed",
            arguments: { query: names.join(" "), limit: names.length },
          });
          encoded.push({
            type: "tool_search_output",
            call_id: callId,
            execution: "client",
            status: "completed",
            tools: added.map((tool) => asFunctionTool(tool, true)),
          });
        }
      }
    }
  }

  finishUnansweredCalls();
  return encoded;
}

function encodeEntries(
  model: Model<any>,
  entries: readonly SessionEntry[],
  allTools: readonly ToolInfo[],
): ResponsesItem[] {
  const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
  return encodeMessages(model, convertToLlm(messages), allTools);
}

export function parseCheckpoint(value: unknown): CheckpointData | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind !== CHECKPOINT_ENTRY_TYPE || value.version !== CHECKPOINT_FORMAT_VERSION) {
    return undefined;
  }
  if (typeof value.modelId !== "string" || !Array.isArray(value.history)) return undefined;

  const history: ResponsesItem[] = [];
  for (const item of value.history) {
    if (!isResponsesItem(item)) return undefined;
    history.push(structuredClone(item));
  }
  if (history.length === 0 || history.at(-1)?.type !== "compaction") return undefined;

  const compactionItems = history.filter((item) => item.type === "compaction");
  if (compactionItems.length !== 1 || typeof compactionItems[0]!.encrypted_content !== "string") {
    return undefined;
  }

  return {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: CHECKPOINT_FORMAT_VERSION,
    modelId: value.modelId,
    history,
  };
}

/** Find the newest applicable checkpoint on the active branch. */
export function searchCheckpoint(branch: readonly SessionEntry[]): CheckpointSearch {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    let candidate: unknown;

    if (entry.type === "compaction") {
      if (!isObject(entry.details) || entry.details.kind !== CHECKPOINT_ENTRY_TYPE) {
        return { kind: "absent" };
      }
      candidate = entry.details;
    } else if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE) {
      candidate = entry.data;
    } else {
      continue;
    }

    const data = parseCheckpoint(candidate);
    if (!data) return { kind: "corrupt", entryIndex: index, entryId: entry.id };
    return { kind: "found", entryIndex: index, entryId: entry.id, data };
  }

  return { kind: "absent" };
}

export function checkpointData(
  modelId: string,
  inputHistory: readonly ResponsesItem[],
  compactionItem: ResponsesItem,
): CheckpointData {
  return {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: CHECKPOINT_FORMAT_VERSION,
    modelId,
    history: installCompactionItem(inputHistory, compactionItem),
  };
}

/**
 * Materialize provider history for the active branch. Checkpoint history
 * replaces everything before its entry; later branch entries form the tail.
 */
export function providerHistory(options: {
  branch: readonly SessionEntry[];
  wireModel: Model<any>;
  allTools: readonly ToolInfo[];
  dropLatestFailedAssistant?: boolean;
}): ResponsesItem[] {
  const branch = [...options.branch];
  if (options.dropLatestFailedAssistant) {
    const index = branch.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const entry = index >= 0 ? branch[index] : undefined;
    if (
      entry?.type === "message" &&
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")
    ) {
      branch.splice(index, 1);
    }
  }

  const checkpoint = searchCheckpoint(branch);
  if (checkpoint.kind === "corrupt") {
    throw new Error("The latest Codex compaction checkpoint is corrupt.");
  }
  if (checkpoint.kind === "found") {
    if (checkpoint.data.modelId !== options.wireModel.id) {
      throw new Error(
        `The latest Codex compaction checkpoint belongs to ${checkpoint.data.modelId}, not ${options.wireModel.id}.`,
      );
    }
    return [
      ...checkpoint.data.history.map((item) => structuredClone(item)),
      ...encodeEntries(
        options.wireModel,
        branch.slice(checkpoint.entryIndex + 1),
        options.allTools,
      ),
    ];
  }

  const context = buildSessionContext(branch);
  return encodeMessages(options.wireModel, convertToLlm(context.messages), options.allTools);
}
