import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
import { providerHistory, type GrammarToolInputProperties } from "../compaction-checkpoint.ts";
import type { ImageDetail } from "../config.ts";
import type { ResponsesItem } from "../codex-protocol.ts";
import { normalizeReplayItem, stableResponsesJson } from "../responses-replay.ts";
import type { ResponsesItem as SerializedResponsesItem } from "../vendor/pi-ai/openai-responses-serialization.ts";

export interface DeferredToolGroups {
  immediate: Tool[];
  deferred: Map<string, Tool>;
}

export function splitDeferredTools(context: Context, enabled: boolean): DeferredToolGroups {
  const unique = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  if (!enabled) return { immediate: [...unique.values()], deferred: new Map() };

  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") usedNames.add(block.name);
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name);
      }
    }
  }

  const immediate: Tool[] = [];
  const deferred = new Map<string, Tool>();
  for (const [name, tool] of unique) {
    if (deferredNames.has(name)) deferred.set(name, tool);
    else immediate.push(tool);
  }
  return { immediate, deferred };
}

export function nativeOverrideRequired(
  rawItems: readonly ResponsesItem[],
  canonicalItems: readonly SerializedResponsesItem[],
): boolean {
  if (rawItems.length !== canonicalItems.length) return true;
  return rawItems.some((item, index) => {
    const canonicalItem = canonicalItems[index];
    return (
      canonicalItem === undefined ||
      stableResponsesJson(normalizeReplayItem(item)) !== stableResponsesJson(canonicalItem)
    );
  });
}

export function userEntryAfterLastSampled(
  branch: readonly SessionEntry[],
): SessionEntry | undefined {
  const lastSampledIndex = branch.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "assistant" || entry.message.role === "toolResult"),
  );
  return branch
    .slice(lastSampledIndex + 1)
    .find((entry) => entry.type === "message" && entry.message.role === "user");
}

export function splitUnsampledUserInput(options: {
  branch: readonly SessionEntry[];
  history: readonly ResponsesItem[];
  model: Model<any>;
  allTools: readonly ToolInfo[];
  grammarToolInputProperties: GrammarToolInputProperties;
  imageDetail: ImageDetail;
}):
  | { kind: "none" | "found"; history: ResponsesItem[]; tail: ResponsesItem[] }
  | { kind: "unsafe" } {
  const firstUnsampled = userEntryAfterLastSampled(options.branch);
  if (!firstUnsampled) {
    return {
      kind: "none",
      history: options.history.map((item) => structuredClone(item)),
      tail: [],
    };
  }

  const unsampledIndex = options.branch.findIndex((entry) => entry.id === firstUnsampled.id);
  const encoded = providerHistory({
    branch: options.branch.slice(unsampledIndex),
    wireModel: options.model,
    allTools: options.allTools,
    grammarToolInputProperties: options.grammarToolInputProperties,
    imageDetail: options.imageDetail,
  });
  if (encoded.length === 0 || encoded.length > options.history.length) return { kind: "unsafe" };

  const splitIndex = options.history.length - encoded.length;
  if (JSON.stringify(options.history.slice(splitIndex)) !== JSON.stringify(encoded)) {
    return { kind: "unsafe" };
  }
  return {
    kind: "found",
    history: options.history.slice(0, splitIndex).map((item) => structuredClone(item)),
    tail: encoded.map((item) => structuredClone(item)),
  };
}
