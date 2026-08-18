import { isNumber, isString } from "./value-contracts.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isObject, isResponsesItem, type ResponsesItem } from "./codex-protocol.ts";

export const NATIVE_RESPONSE_ENTRY_TYPE = "openai-codex-compat-native-response";
export const NATIVE_RESPONSE_FORMAT_VERSION = 1;
export const NATIVE_RESPONSE_ITEM_COMMIT = "response.output_item.done";

export type NativeResponseAttempt = {
  itemCount: number;
  terminalType: "response.completed" | "response.incomplete" | "response.failed";
  terminalReason?: string;
};

export type NativeResponseData = {
  kind: typeof NATIVE_RESPONSE_ENTRY_TYPE;
  version: typeof NATIVE_RESPONSE_FORMAT_VERSION;
  modelId: string;
  responseId: string;
  items: ResponsesItem[];
  itemCommit?: typeof NATIVE_RESPONSE_ITEM_COMMIT;
  attempts?: NativeResponseAttempt[];
};

export function nativeResponseData(
  modelId: string,
  responseId: string,
  items: readonly ResponsesItem[],
  attempts?: readonly NativeResponseAttempt[],
): NativeResponseData {
  const data: NativeResponseData = {
    kind: NATIVE_RESPONSE_ENTRY_TYPE,
    version: NATIVE_RESPONSE_FORMAT_VERSION,
    modelId,
    responseId,
    items: items.map((item) => structuredClone(item)),
    itemCommit: NATIVE_RESPONSE_ITEM_COMMIT,
  };
  if (attempts) data.attempts = attempts.map((attempt) => ({ ...attempt }));
  return data;
}

export function parseNativeResponse(value: unknown): NativeResponseData | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.kind !== NATIVE_RESPONSE_ENTRY_TYPE ||
    value.version !== NATIVE_RESPONSE_FORMAT_VERSION ||
    !isString(value.modelId) ||
    !isString(value["responseId"]) ||
    !Array.isArray(value["items"])
  ) {
    return undefined;
  }

  const items: ResponsesItem[] = [];
  for (const item of value["items"]) {
    if (!isResponsesItem(item)) return undefined;
    items.push(structuredClone(item));
  }
  if (items.length === 0) return undefined;

  const rawItemCommit = value["itemCommit"];
  if (rawItemCommit !== undefined && rawItemCommit !== NATIVE_RESPONSE_ITEM_COMMIT) {
    return undefined;
  }
  const rawAttempts = value["attempts"];
  let attempts: NativeResponseAttempt[] | undefined;
  if (rawAttempts !== undefined) {
    if (!Array.isArray(rawAttempts)) return undefined;
    attempts = [];
    for (const rawAttempt of rawAttempts) {
      if (!isObject(rawAttempt)) return undefined;
      const itemCount = rawAttempt["itemCount"];
      if (
        !isNumber(itemCount) ||
        !Number.isSafeInteger(itemCount) ||
        itemCount < 0 ||
        (rawAttempt["terminalType"] !== "response.completed" &&
          rawAttempt["terminalType"] !== "response.incomplete" &&
          rawAttempt["terminalType"] !== "response.failed") ||
        (rawAttempt["terminalReason"] !== undefined && !isString(rawAttempt["terminalReason"]))
      ) {
        return undefined;
      }
      const attempt: NativeResponseAttempt = {
        itemCount,
        terminalType: rawAttempt["terminalType"],
      };
      if (isString(rawAttempt["terminalReason"])) {
        attempt.terminalReason = rawAttempt["terminalReason"];
      }
      attempts.push(attempt);
    }
  }

  const data: NativeResponseData = {
    kind: NATIVE_RESPONSE_ENTRY_TYPE,
    version: NATIVE_RESPONSE_FORMAT_VERSION,
    modelId: value.modelId,
    responseId: value["responseId"],
    items,
  };
  if (rawItemCommit === NATIVE_RESPONSE_ITEM_COMMIT) {
    data.itemCommit = NATIVE_RESPONSE_ITEM_COMMIT;
  }
  if (attempts) data.attempts = attempts;
  return data;
}

function linkedToolCalls(items: readonly ResponsesItem[]): boolean {
  const unresolved = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (!isString(item["call_id"]) || unresolved.has(item["call_id"])) return false;
      unresolved.add(item["call_id"]);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (!isString(item["call_id"]) || !unresolved.delete(item["call_id"])) {
        return false;
      }
    }
  }
  return unresolved.size === 0;
}

/**
 * Recover only done items from attempts completed before a final context-overflow
 * subrequest. Older native entries remain replayable but lack enough provenance
 * for this recovery path.
 */
export function nativeCommittedPrefixBeforeOverflow(
  branch: readonly SessionEntry[],
  modelId: string,
  responseId: string,
): ResponsesItem[] | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "custom" || entry.customType !== NATIVE_RESPONSE_ENTRY_TYPE) continue;
    const parsed = parseNativeResponse(entry.data);
    if (!parsed) {
      throw new Error(`Codex native response entry ${entry.id} is corrupt.`);
    }
    if (parsed.modelId !== modelId || parsed.responseId !== responseId) continue;
    if (parsed.itemCommit !== NATIVE_RESPONSE_ITEM_COMMIT || !parsed.attempts) return undefined;
    if (parsed.attempts.length < 2) return undefined;
    if (
      parsed.attempts.reduce((total, attempt) => total + attempt.itemCount, 0) !==
      parsed.items.length
    ) {
      return undefined;
    }

    const finalAttempt = parsed.attempts.at(-1);
    if (
      finalAttempt?.terminalType !== "response.failed" ||
      finalAttempt.terminalReason?.toLowerCase() !== "context_length_exceeded"
    ) {
      return undefined;
    }
    const prefixLength = parsed.items.length - finalAttempt.itemCount;
    if (prefixLength <= 0) return undefined;
    const prefix = parsed.items.slice(0, prefixLength);
    if (!linkedToolCalls(prefix)) return undefined;
    return prefix.map((item) => structuredClone(item));
  }
  return undefined;
}

/** Load native assistant output overrides from the active Pi branch. */
export function nativeResponseOverrides(
  branch: readonly SessionEntry[],
  modelId: string,
): ReadonlyMap<string, ResponsesItem[]> {
  const overrides = new Map<string, ResponsesItem[]>();

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== NATIVE_RESPONSE_ENTRY_TYPE) continue;
    const parsed = parseNativeResponse(entry.data);
    if (!parsed) {
      throw new Error(`Codex native response entry ${entry.id} is corrupt.`);
    }
    if (parsed.modelId !== modelId) continue;
    overrides.set(
      parsed.responseId,
      parsed.items.map((item) => structuredClone(item)),
    );
  }

  return overrides;
}
