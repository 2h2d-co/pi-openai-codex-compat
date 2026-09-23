import { isBoolean, isString } from "./value-contracts.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  buildSessionContext,
  buildSessionProjection,
  convertToLlm,
  sessionEntryToContextMessages,
  type ContextEditEntry,
  type SessionEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  getInitialSystemMessage,
  getSystemMessageText,
  normalizeContext,
  resolveTranscript,
  type Api,
  type Context,
  type Message,
  type Model,
  type SystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_TOOL_NAME } from "./apply-patch.ts";
import { CODEX_TOOL_CALL_PROVIDERS } from "./codex-identifiers.ts";
import type { ImageDetail } from "./config.ts";
import {
  installCompactionItem,
  isObject,
  requireResponsesInputItems,
  type JsonRecord,
} from "./codex-protocol.ts";
import { nativeCommittedPrefixBeforeOverflow, nativeResponseOverrides } from "./native-history.ts";
import { stableResponsesJson } from "./responses-replay.ts";
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

type AgentMessages = ReturnType<typeof sessionEntryToContextMessages>;

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
  supportsMidConvoSystemMessages?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsStrictMode?: boolean;
}

export function responsesCompatibility(value: unknown): ResponsesCompatibility {
  const compatibility: ResponsesCompatibility = {};
  if (!isObject(value)) return compatibility;
  if (isBoolean(value["supportsMidConvoSystemMessages"])) {
    compatibility.supportsMidConvoSystemMessages = value["supportsMidConvoSystemMessages"];
  }
  if (isBoolean(value["supportsOpenAIGrammarTools"])) {
    compatibility.supportsOpenAIGrammarTools = value["supportsOpenAIGrammarTools"];
  }
  if (isBoolean(value["supportsStrictMode"])) {
    compatibility.supportsStrictMode = value["supportsStrictMode"];
  }
  return compatibility;
}

/**
 * Resolve Pi's transcript the way Pi AI's Codex adapter does before building a
 * request: models that accept mid-conversation system messages keep later
 * system messages in place, and every other model collapses them into the
 * leading system message.
 */
export function resolveRequestTranscript(model: Model<Api>, context: Context): TranscriptContext {
  return resolveTranscript(
    normalizeContext(context),
    responsesCompatibility(model.compat).supportsMidConvoSystemMessages ?? false,
  );
}

/** The leading system message of a resolved transcript, rendered as Responses `instructions`. */
export function requestInstructions(context: TranscriptContext): string {
  const initial = getInitialSystemMessage(context.messages);
  return initial ? getSystemMessageText(initial) : "";
}

/** `instructions` for a request built from a session branch rather than Pi's live transcript. */
export function branchInstructions(model: Model<Api>, branch: readonly SessionEntry[]): string {
  return requestInstructions(
    resolveRequestTranscript(model, {
      messages: convertToLlm(buildSessionContext([...branch]).messages),
    }),
  );
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

/** The raw tool definition fields that both Pi AI's `Tool` and Pi's `ToolInfo` carry. */
export type ToolDeclarationSource = Pick<ToolInfo, "name" | "description" | "parameters">;

/**
 * Fingerprint raw tool definitions by name, description, and parameter schema,
 * independent of declaration order. Both the transcript tools a turn request
 * declared and the registry's active `ToolInfo` list produce the same value for
 * the same definitions, so a cached turn template can be compared with the
 * current tools without reversing the strict schema conversion applied on the
 * wire.
 */
export function toolDefinitionFingerprint(tools: readonly ToolDeclarationSource[]): string {
  const declarations = tools
    .map((tool) => {
      // The JSON round-trip drops typebox symbol keys and undefined fields, as
      // Pi AI's own declaration comparison does.
      const parameters: unknown = JSON.parse(JSON.stringify(tool.parameters));
      return { name: tool.name, description: tool.description, parameters };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(stableResponsesJson(declarations)).digest("hex");
}

/** Fingerprint of the registry tools that are currently active. */
export function activeToolFingerprint(
  allTools: readonly ToolInfo[],
  activeNames: readonly string[],
): string {
  const enabled = new Set(activeNames);
  return toolDefinitionFingerprint(allTools.filter((tool) => enabled.has(tool.name)));
}

/**
 * Whether a cached turn template still declares exactly the active tools.
 *
 * The serialized `tools` list must name the active set (namespace members
 * count as `namespace.member`), and the raw definitions that produced it must
 * fingerprint identically to the active registry tools. Comparing names and
 * descriptions alone missed parameter-schema changes under an unchanged name.
 *
 * A cached turn template carries the exact declarations the turn requests sent,
 * including strict schema conversion that `ToolInfo` cannot reproduce. Reusing
 * it keeps the compaction request on the turn requests' prompt-cache prefix.
 */
export function declaresActiveTools(
  serialized: readonly JsonRecord[],
  cachedToolFingerprint: string,
  allTools: readonly ToolInfo[],
  activeNames: readonly string[],
): boolean {
  if (cachedToolFingerprint !== activeToolFingerprint(allTools, activeNames)) return false;
  const declared = new Map<string, string | undefined>();
  for (const item of serialized) {
    if (item.type === "namespace" && isString(item.name) && Array.isArray(item.tools)) {
      for (const member of item.tools) {
        if (!isObject(member) || !isString(member.name)) return false;
        declared.set(
          `${item.name}.${member.name}`,
          isString(member["description"]) ? member["description"] : undefined,
        );
      }
    } else if ((item.type === "function" || item.type === "custom") && isString(item.name)) {
      declared.set(item.name, isString(item["description"]) ? item["description"] : undefined);
    } else {
      return false;
    }
  }
  const enabled = new Set(activeNames);
  const active = allTools.filter((tool) => enabled.has(tool.name));
  return (
    declared.size === active.length &&
    active.every((tool) => declared.has(tool.name) && declared.get(tool.name) === tool.description)
  );
}

export function remoteCompactionMarkerSummary(): string {
  return `OpenAI Codex remote compaction checkpoint (${randomUUID()}).`;
}

type EncodeMessagesOptions = {
  model: Model<Api>;
  messages: Message[];
  grammarToolInputProperties: GrammarToolInputProperties;
  imageDetail: ImageDetail;
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesOutputItem[]>;
};

export type EncodeSessionEntriesOptions = {
  model: Model<Api>;
  entries: readonly SessionEntry[];
  grammarToolInputProperties?: GrammarToolInputProperties;
  imageDetail?: ImageDetail;
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesOutputItem[]>;
  initialSystemMessage?: SystemMessage;
  /** Model-visible messages per entry. Defaults to the entry's raw messages. */
  entryMessages?: (entry: SessionEntry) => AgentMessages;
};

/**
 * Encode Pi's canonical messages using Pi AI's OpenAI Responses serializer.
 *
 * The leading system message travels as `instructions`, so it is excluded here.
 * Later system messages become inline developer items on models that accept
 * mid-conversation system messages and collapse into the leading message
 * otherwise, exactly as Pi AI's Codex adapter does.
 *
 * Tool declarations never enter the input: every request carries the complete
 * current tool set at the top level, as the official Codex client does. Inline
 * `additional_tools` items and synthetic tool-search pairs made the Codex
 * backend unreliable about which tools exist, so neither is emitted.
 */
function encodeMessages(options: EncodeMessagesOptions): ResponsesInputItem[] {
  const { model, messages, grammarToolInputProperties, imageDetail, nativeAssistantItems } =
    options;
  const compat = responsesCompatibility(model.compat);
  const serializationOptions: NonNullable<Parameters<typeof convertResponsesMessages>[3]> = {
    includeSystemPrompt: false,
    supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
    supportsAdditionalTools: false,
    supportsToolSearch: false,
    grammarToolInputProperties,
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
    convertResponsesMessages(model, { messages }, CODEX_TOOL_CALL_PROVIDERS, serializationOptions),
  );
}

export function encodeSessionEntries(options: EncodeSessionEntriesOptions): ResponsesInputItem[] {
  const {
    model,
    entries,
    grammarToolInputProperties = new Map(),
    imageDetail = "auto",
    nativeAssistantItems,
    entryMessages = sessionEntryToContextMessages,
  } = options;
  const messages = entries.flatMap((entry) => entryMessages(entry));
  const encodeOptions: EncodeMessagesOptions = {
    model,
    // A partial tail can start with a system update. Seed its prior state so
    // the serializer renders that update inline instead of dropping it as the
    // leading system message that `instructions` already carries.
    messages: [
      options.initialSystemMessage ?? { role: "system", content: "", timestamp: 0 },
      ...convertToLlm(messages),
    ],
    grammarToolInputProperties,
    imageDetail,
  };
  if (nativeAssistantItems) encodeOptions.nativeAssistantItems = nativeAssistantItems;
  return encodeMessages(encodeOptions);
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
 * The entries Pi 0.87 omits for overflow or length recovery: the latest
 * assistant attempt and the tool results of that turn, each targeted by a
 * `context_edit` omission appended after the attempt. `leafId` is the parent of
 * the first such omission, so a projection built up to it reflects every edit
 * that existed before Pi omitted the attempt.
 *
 * Pi only selects a recovery attempt while it is still projected, so an
 * omission of the latest assistant found here is Pi's recovery omission and
 * not an unrelated edit.
 */
function recoveryOmissions(
  branch: readonly SessionEntry[],
): { entryIds: ReadonlySet<string>; leafId: string } | undefined {
  const attemptIndex = branch.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const attempt = branch[attemptIndex];
  if (attempt?.type !== "message" || attempt.message.role !== "assistant") return undefined;

  const toolCallIds = new Set(
    attempt.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
  );
  const candidates = new Set([attempt.id]);
  for (const entry of branch.slice(attemptIndex + 1)) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult" || !toolCallIds.has(entry.message.toolCallId)) break;
    candidates.add(entry.id);
  }

  const latestEdits = new Map<string, ContextEditEntry>();
  for (const entry of branch.slice(attemptIndex + 1)) {
    if (entry.type === "context_edit" && candidates.has(entry.targetId)) {
      latestEdits.set(entry.targetId, entry);
    }
  }
  if (latestEdits.get(attempt.id)?.replacement !== null) return undefined;
  const omissions = new Set(
    [...latestEdits.values()].filter((entry) => entry.replacement === null),
  );
  const first = branch.find((entry) => entry.type === "context_edit" && omissions.has(entry));
  if (first?.type !== "context_edit" || first.parentId === null) return undefined;
  return {
    entryIds: new Set([...omissions].map((entry) => entry.targetId)),
    leafId: first.parentId,
  };
}

/**
 * Materialize provider history for the active branch. Checkpoint history
 * replaces everything before its entry; later branch entries form the tail.
 *
 * Every request reads the session projection, so `context_edit` omissions and
 * replacements apply exactly as they do for Pi's own adapters. Recovery
 * compaction differs only for the latest attempt: Pi 0.87 omits the failed or
 * truncated assistant and its tool results through `context_edit` entries
 * before it runs `session_before_compact`. Those entries are projected as they
 * were before Pi's omission, so a truncated boundary stays as committed
 * progress while every earlier omission or replacement remains in force. The
 * serializer skips error and aborted assistants; a failed attempt contributes
 * only the native prefix committed before the overflowing subrequest. Entries
 * are never removed from the branch copy because the omission entry's parent
 * chain would break and the history would vanish.
 */
export function providerHistory(options: {
  branch: readonly SessionEntry[];
  wireModel: Model<Api>;
  grammarToolInputProperties?: GrammarToolInputProperties;
  imageDetail?: ImageDetail;
  recoverLatestOverflowPrefix?: boolean;
}): ResponsesInputItem[] {
  const branch = [...options.branch];
  let recoveredPrefix: ResponsesInputItem[] = [];
  if (options.recoverLatestOverflowPrefix) {
    const entry = branch.findLast(
      (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
    );
    if (
      entry?.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error" &&
      entry.message.responseId
    ) {
      recoveredPrefix =
        nativeCommittedPrefixBeforeOverflow(
          branch,
          options.wireModel.id,
          entry.message.responseId,
        ) ?? [];
    }
  }

  const projection = buildSessionProjection(branch);
  const projected = new Map<string, AgentMessages>();
  for (const entry of projection.entries) projected.set(entry.sourceEntry.id, entry.messages);
  const recovery = options.recoverLatestOverflowPrefix ? recoveryOmissions(branch) : undefined;
  if (recovery) {
    for (const entry of buildSessionProjection(branch, recovery.leafId).entries) {
      if (recovery.entryIds.has(entry.sourceEntry.id)) {
        projected.set(entry.sourceEntry.id, entry.messages);
      }
    }
  }
  const entryMessages = (entry: SessionEntry): AgentMessages => projected.get(entry.id) ?? [];

  const checkpoint = searchCheckpoint(branch);
  const nativeAssistantItems = new Map(nativeResponseOverrides(branch, options.wireModel.id));
  for (const entry of branch) {
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.responseId &&
      entryMessages(entry).some((message) => message !== entry.message)
    ) {
      // A replacement keeps the response ID but changes the model-visible content.
      // Its original native output must not override the canonical replacement.
      nativeAssistantItems.delete(entry.message.responseId);
    }
  }
  if (checkpoint.kind === "corrupt") {
    throw new Error("The latest Codex compaction checkpoint is corrupt.");
  }
  if (checkpoint.kind === "found") {
    if (checkpoint.data.modelId !== options.wireModel.id) {
      throw new Error(
        `The latest Codex compaction checkpoint belongs to ${checkpoint.data.modelId}, not ${options.wireModel.id}.`,
      );
    }
    const checkpointEntry = branch[checkpoint.entryIndex];
    const initialSystemMessage =
      checkpointEntry?.type === "compaction" ? checkpointEntry.systemMessage : undefined;
    return [
      ...checkpoint.data.history.map((item) => structuredClone(item)),
      ...encodeSessionEntries({
        model: options.wireModel,
        entries: branch.slice(checkpoint.entryIndex + 1),
        grammarToolInputProperties: options.grammarToolInputProperties ?? new Map(),
        imageDetail: options.imageDetail ?? "auto",
        nativeAssistantItems,
        entryMessages,
        ...(initialSystemMessage ? { initialSystemMessage } : {}),
      }),
      ...recoveredPrefix,
    ];
  }

  return [
    ...encodeMessages({
      model: options.wireModel,
      messages: convertToLlm(
        projection.entries.flatMap((entry) => entryMessages(entry.sourceEntry)),
      ),
      grammarToolInputProperties: options.grammarToolInputProperties ?? new Map(),
      imageDetail: options.imageDetail ?? "auto",
      nativeAssistantItems,
    }),
    ...recoveredPrefix,
  ];
}
