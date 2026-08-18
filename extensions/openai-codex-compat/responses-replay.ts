import { isBoolean, isNonNullObject, isNumber, isString } from "./value-contracts.ts";
import type { JsonPrimitive, JsonRecord } from "./codex-protocol.ts";

type StableJsonValue = JsonPrimitive | StableJsonObject | StableJsonValue[] | undefined;

interface StableJsonObject {
  [key: string]: StableJsonValue;
}

export function stableResponsesJson(value: unknown): string {
  const normalize = (current: unknown): StableJsonValue => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current === null || isBoolean(current) || isNumber(current) || isString(current)) {
      return current;
    }
    if (!isNonNullObject(current)) return undefined;
    return Object.fromEntries(
      Object.entries(current)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  const serialized = JSON.stringify(normalize(value));
  if (!isString(serialized)) {
    throw new Error("Responses data did not serialize to JSON.");
  }
  return serialized;
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
