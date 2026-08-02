import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isObject, isResponsesItem, type ResponsesItem } from "./codex-protocol.ts";

export const NATIVE_RESPONSE_ENTRY_TYPE = "openai-codex-compat-native-response";
export const NATIVE_RESPONSE_FORMAT_VERSION = 1;

export type NativeResponseData = {
  kind: typeof NATIVE_RESPONSE_ENTRY_TYPE;
  version: typeof NATIVE_RESPONSE_FORMAT_VERSION;
  modelId: string;
  responseId: string;
  items: ResponsesItem[];
};

export function nativeResponseData(
  modelId: string,
  responseId: string,
  items: readonly ResponsesItem[],
): NativeResponseData {
  return {
    kind: NATIVE_RESPONSE_ENTRY_TYPE,
    version: NATIVE_RESPONSE_FORMAT_VERSION,
    modelId,
    responseId,
    items: items.map((item) => structuredClone(item)),
  };
}

export function parseNativeResponse(value: unknown): NativeResponseData | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.kind !== NATIVE_RESPONSE_ENTRY_TYPE ||
    value.version !== NATIVE_RESPONSE_FORMAT_VERSION ||
    typeof value.modelId !== "string" ||
    typeof value["responseId"] !== "string" ||
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

  return {
    kind: NATIVE_RESPONSE_ENTRY_TYPE,
    version: NATIVE_RESPONSE_FORMAT_VERSION,
    modelId: value.modelId,
    responseId: value["responseId"],
    items,
  };
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
