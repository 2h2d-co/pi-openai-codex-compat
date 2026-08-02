import {
  buildSessionContext,
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Message, Model, OpenAIResponsesCompat, Tool } from "@earendil-works/pi-ai";
import { APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import {
  installCompactionItem,
  isObject,
  isResponsesItem,
  type ResponsesItem,
} from "./codex-protocol.ts";
import { nativeResponseOverrides } from "./native-history.ts";
import { convertResponsesMessages } from "./vendor/pi-ai/openai-responses-serialization.ts";

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

export type GrammarToolInputProperties = ReadonlyMap<string, string>;

function asResponsesTool(
  tool: ToolInfo,
  grammarToolInputProperties: GrammarToolInputProperties,
): ResponsesItem {
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
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
    strict: null,
  };
}

export function activeResponsesTools(
  allTools: readonly ToolInfo[],
  activeNames: readonly string[],
  grammarToolInputProperties: GrammarToolInputProperties = new Map(),
): unknown[] | undefined {
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
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.name === APPLY_PATCH_TOOL_NAME && grammarToolInputProperties.has(tool.name)
      ? {
          constrainedSampling: {
            type: "grammar" as const,
            variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
          },
        }
      : {}),
  };
}

/** Encode Pi's canonical messages using Pi AI's OpenAI Responses serializer. */
function encodeMessages(
  model: Model<any>,
  messages: Message[],
  allTools: readonly ToolInfo[],
  grammarToolInputProperties: GrammarToolInputProperties,
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesItem[]>,
): ResponsesItem[] {
  const tools = allTools.map((tool) => asPiTool(tool, grammarToolInputProperties));
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  return convertResponsesMessages(model, { messages, tools }, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
    deferredTools: new Map(tools.map((tool) => [tool.name, tool])),
    toolOptions: {
      strict: null,
      supportsStrictMode: compat?.supportsStrictMode ?? true,
      supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
    },
    ...(nativeAssistantItems ? { nativeAssistantItems } : {}),
  }) as unknown as ResponsesItem[];
}

export function encodeSessionEntries(
  model: Model<any>,
  entries: readonly SessionEntry[],
  allTools: readonly ToolInfo[],
  grammarToolInputProperties: GrammarToolInputProperties = new Map(),
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesItem[]>,
): ResponsesItem[] {
  const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
  return encodeMessages(
    model,
    convertToLlm(messages),
    allTools,
    grammarToolInputProperties,
    nativeAssistantItems,
  );
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
  if (history.length === 0) return undefined;

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
  postCompactionTail: readonly ResponsesItem[] = [],
): CheckpointData {
  return {
    kind: CHECKPOINT_ENTRY_TYPE,
    version: CHECKPOINT_FORMAT_VERSION,
    modelId,
    history: [
      ...installCompactionItem(inputHistory, compactionItem),
      ...postCompactionTail.map((item) => structuredClone(item)),
    ],
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
  grammarToolInputProperties?: GrammarToolInputProperties;
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
        nativeAssistantItems,
      ),
    ];
  }

  const context = buildSessionContext(branch);
  return encodeMessages(
    options.wireModel,
    convertToLlm(context.messages),
    options.allTools,
    options.grammarToolInputProperties ?? new Map(),
    nativeAssistantItems,
  );
}
