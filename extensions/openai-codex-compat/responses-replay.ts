import { isObject, type JsonRecord } from "./codex-protocol.ts";

export function stableResponsesJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (!isObject(current)) return current;
    return Object.fromEntries(
      Object.entries(current)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return JSON.stringify(normalize(value));
}

/** Normalize completed provider output into the item shape replayed on the next request. */
export function normalizeReplayItem(item: JsonRecord): JsonRecord {
  const normalized = structuredClone(item);
  if (normalized.type === "message") {
    normalized["status"] = "completed";
  } else if (normalized.type === "function_call" || normalized.type === "custom_tool_call") {
    delete normalized["status"];
  }
  return normalized;
}

export function replayItemsEqual(
  left: readonly JsonRecord[] | undefined,
  right: readonly JsonRecord[] | undefined,
): boolean {
  return stableResponsesJson(left ?? []) === stableResponsesJson(right ?? []);
}
