import { isBoolean, isString } from "./value-contracts.ts";
import {
  buildSessionContext,
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import type { ImageDetail } from "./config.ts";
import {
  installCompactionItem,
  isObject,
  requireResponsesInputItems,
  type JsonRecord,
} from "./codex-protocol.ts";
import { nativeCommittedPrefixBeforeOverflow, nativeResponseOverrides } from "./native-history.ts";
import {
  CODEX_NAMESPACED_TOOL_NAMES,
  CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
  splitNamespacedToolName,
} from "./namespaced-tools.ts";
import {
  RESPONSES_COMPACTION_ITEM_SCHEMA,
  RESPONSES_INPUT_ITEM_SCHEMA,
  type ResponsesCompactionItem,
  type ResponsesInputItem,
  type ResponsesOutputItem,
} from "./responses-item-schema.ts";
import type { ResponsesToolDefinition } from "./responses-tool-schema.ts";
import { convertResponsesMessages } from "./vendor/pi-ai/openai-responses-serialization.ts";

export const CHECKPOINT_ENTRY_TYPE = "openai-codex-compat-remote-compaction";
export const CHECKPOINT_FORMAT_VERSION = 1;

export type CompactionDecision = {
  reason: "manual" | "threshold" | "overflow" | "provider-boundary";
  willRetry: boolean;
};

export type CheckpointData = {
  kind: typeof CHECKPOINT_ENTRY_TYPE;
  version: typeof CHECKPOINT_FORMAT_VERSION;
  modelId: string;
  history: ResponsesInputItem[];
  compactionDecision?: CompactionDecision;
};

export type CheckpointSearch =
  | { kind: "absent" }
  | { kind: "corrupt"; entryIndex: number; entryId: string }
  | { kind: "found"; entryIndex: number; entryId: string; data: CheckpointData };

export type GrammarToolInputProperties = ReadonlyMap<string, string>;

export interface ResponsesCompatibility {
  supportsOpenAIGrammarTools?: boolean;
  supportsStrictMode?: boolean;
  supportsToolSearch?: boolean;
}

export function responsesCompatibility(value: unknown): ResponsesCompatibility {
  const compatibility: ResponsesCompatibility = {};
  if (!isObject(value)) return compatibility;
  if (isBoolean(value["supportsOpenAIGrammarTools"])) {
    compatibility.supportsOpenAIGrammarTools = value["supportsOpenAIGrammarTools"];
  }
  if (isBoolean(value["supportsStrictMode"])) {
    compatibility.supportsStrictMode = value["supportsStrictMode"];
  }
  if (isBoolean(value["supportsToolSearch"])) {
    compatibility.supportsToolSearch = value["supportsToolSearch"];
  }
  return compatibility;
}

function responsesToolParameters(tool: ToolInfo): JsonRecord {
  if (!isObject(tool.parameters)) {
    throw new Error(`Tool ${tool.name} must have JSON object parameters.`);
  }
  return tool.parameters;
}

function asResponsesTool(
  tool: ToolInfo,
  grammarToolInputProperties: GrammarToolInputProperties,
): ResponsesToolDefinition {
  if (tool.name === APPLY_PATCH_TOOL_NAME && grammarToolInputProperties.has(tool.name)) {
    return {
      type: "custom",
      name: tool.name,
      description: tool.description,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: APPLY_PATCH_LARK_GRAMMAR,
      },
    };
  }
  const namespaced = splitNamespacedToolName(tool.name);
  if (namespaced) {
    return {
      type: "namespace",
      name: namespaced.namespace,
      description: `Tools in the ${namespaced.namespace} namespace.`,
      tools: [
        {
          type: "function",
          name: namespaced.name,
          description: tool.description,
          parameters: responsesToolParameters(tool),
          strict: false,
        },
      ],
    };
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: responsesToolParameters(tool),
    strict: false,
  };
}

export function activeResponsesTools(
  allTools: readonly ToolInfo[],
  activeNames: readonly string[],
  grammarToolInputProperties: GrammarToolInputProperties = new Map(),
): ResponsesToolDefinition[] | undefined {
  const enabled = new Set(activeNames);
  const tools = allTools.filter((tool) => enabled.has(tool.name));
  return tools.length > 0
    ? tools.map((tool) => asResponsesTool(tool, grammarToolInputProperties))
    : undefined;
}

const CODEX_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);

function asPiTool(tool: ToolInfo, grammarToolInputProperties: GrammarToolInputProperties): Tool {
  const piTool: Tool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  if (tool.name === APPLY_PATCH_TOOL_NAME && grammarToolInputProperties.has(tool.name)) {
    piTool.constrainedSampling = {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    };
  }
  return piTool;
}

/** Encode Pi's canonical messages using Pi AI's OpenAI Responses serializer. */
function encodeMessages(
  model: Model<Api>,
  messages: Message[],
  allTools: readonly ToolInfo[],
  grammarToolInputProperties: GrammarToolInputProperties,
  imageDetail: ImageDetail,
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesOutputItem[]>,
): ResponsesInputItem[] {
  const tools = allTools.map((tool) => asPiTool(tool, grammarToolInputProperties));
  const compat = responsesCompatibility(model.compat);
  const serializationOptions: NonNullable<Parameters<typeof convertResponsesMessages>[3]> = {
    includeSystemPrompt: false,
    grammarToolInputProperties,
    deferredTools: new Map(tools.map((tool) => [tool.name, tool])),
    toolOptions: {
      strict: false,
      supportsStrictMode: compat?.supportsStrictMode ?? true,
      supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
    },
    namespacedToolNames: CODEX_NAMESPACED_TOOL_NAMES,
    textContentItemToolResultNames: CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES,
    toolResultImageDetail: imageDetail,
  };
  if (nativeAssistantItems) {
    serializationOptions.nativeAssistantItems = nativeAssistantItems;
  }
  return requireResponsesInputItems(
    convertResponsesMessages(
      model,
      { messages, tools },
      CODEX_TOOL_CALL_PROVIDERS,
      serializationOptions,
    ),
  );
}

export function encodeSessionEntries(
  model: Model<Api>,
  entries: readonly SessionEntry[],
  allTools: readonly ToolInfo[],
  grammarToolInputProperties: GrammarToolInputProperties = new Map(),
  imageDetail: ImageDetail = "auto",
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesOutputItem[]>,
): ResponsesInputItem[] {
  const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
  return encodeMessages(
    model,
    convertToLlm(messages),
    allTools,
    grammarToolInputProperties,
    imageDetail,
    nativeAssistantItems,
  );
}

export function parseCheckpoint(value: unknown): CheckpointData | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind !== CHECKPOINT_ENTRY_TYPE || value.version !== CHECKPOINT_FORMAT_VERSION) {
    return undefined;
  }
  if (!isString(value.modelId) || !Array.isArray(value.history)) return undefined;

  const history: ResponsesInputItem[] = [];
  for (const item of value.history) {
    if (!isObject(item) || !Value.Check(RESPONSES_INPUT_ITEM_SCHEMA, item)) return undefined;
    history.push(structuredClone(item));
  }
  if (history.length === 0) return undefined;

  const compactionItems = history.filter((item) =>
    Value.Check(RESPONSES_COMPACTION_ITEM_SCHEMA, item),
  );
  const compactionItem = compactionItems[0];
  if (compactionItems.length !== 1 || !compactionItem) {
    return undefined;
  }

  const rawDecision = value["compactionDecision"];
  let compactionDecision: CompactionDecision | undefined;
  if (rawDecision !== undefined) {
    if (
      !isObject(rawDecision) ||
      (rawDecision["reason"] !== "manual" &&
        rawDecision["reason"] !== "threshold" &&
        rawDecision["reason"] !== "overflow" &&
        rawDecision["reason"] !== "provider-boundary") ||
      !isBoolean(rawDecision["willRetry"])
    ) {
      return undefined;
    }
    compactionDecision = {
      reason: rawDecision["reason"],
      willRetry: rawDecision["willRetry"],
    };
  }

  const checkpoint: CheckpointData = {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: CHECKPOINT_FORMAT_VERSION,
    modelId: value.modelId,
    history,
  };
  if (compactionDecision) checkpoint.compactionDecision = compactionDecision;
  return checkpoint;
}

/** Find the newest applicable checkpoint on the active branch. */
export function searchCheckpoint(branch: readonly SessionEntry[]): CheckpointSearch {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry === undefined) continue;
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

/** Return whether the active branch contains any native Codex checkpoint entry. */
export function hasNativeCheckpointEntry(branch: readonly SessionEntry[]): boolean {
  return branch.some(
    (entry) =>
      (entry.type === "compaction" &&
        isObject(entry.details) &&
        entry.details.kind === CHECKPOINT_ENTRY_TYPE) ||
      (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE),
  );
}

export function checkpointData(
  modelId: string,
  inputHistory: readonly ResponsesInputItem[],
  compactionItem: ResponsesCompactionItem,
  postCompactionTail: readonly ResponsesInputItem[] = [],
  compactionDecision?: CompactionDecision,
): CheckpointData {
  const checkpoint: CheckpointData = {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: CHECKPOINT_FORMAT_VERSION,
    modelId,
    history: [
      ...installCompactionItem(inputHistory, compactionItem),
      ...postCompactionTail.map((item) => structuredClone(item)),
    ],
  };
  if (compactionDecision) checkpoint.compactionDecision = { ...compactionDecision };
  return checkpoint;
}

/**
 * Materialize provider history for the active branch. Checkpoint history
 * replaces everything before its entry; later branch entries form the tail.
 */
export function providerHistory(options: {
  branch: readonly SessionEntry[];
  wireModel: Model<Api>;
  allTools: readonly ToolInfo[];
  grammarToolInputProperties?: GrammarToolInputProperties;
  imageDetail?: ImageDetail;
  recoverLatestOverflowPrefix?: boolean;
}): ResponsesInputItem[] {
  const branch = [...options.branch];
  let recoveredPrefix: ResponsesInputItem[] = [];
  if (options.recoverLatestOverflowPrefix) {
    const index = branch.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const entry = index >= 0 ? branch[index] : undefined;
    if (
      entry?.type === "message" &&
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")
    ) {
      if (entry.message.stopReason === "error" && entry.message.responseId) {
        recoveredPrefix =
          nativeCommittedPrefixBeforeOverflow(
            branch,
            options.wireModel.id,
            entry.message.responseId,
          ) ?? [];
      }
      branch.splice(index, 1);
    }
  }

  const checkpoint = searchCheckpoint(branch);
  const nativeAssistantItems = nativeResponseOverrides(branch, options.wireModel.id);
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
      ...encodeSessionEntries(
        options.wireModel,
        branch.slice(checkpoint.entryIndex + 1),
        options.allTools,
        options.grammarToolInputProperties,
        options.imageDetail,
        nativeAssistantItems,
      ),
      ...recoveredPrefix,
    ];
  }

  const context = buildSessionContext(branch);
  return [
    ...encodeMessages(
      options.wireModel,
      convertToLlm(context.messages),
      options.allTools,
      options.grammarToolInputProperties ?? new Map(),
      options.imageDetail ?? "auto",
      nativeAssistantItems,
    ),
    ...recoveredPrefix,
  ];
}
