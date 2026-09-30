import { isString } from "./value-contracts.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonValue, isObject, type JsonRecord } from "./codex-protocol.ts";
import type { GrammarToolInputProperties } from "./compaction-checkpoint.ts";
import { stableResponsesJson } from "./responses-replay.ts";

/**
 * Custom session entry holding the exact tool declarations a turn request sent.
 * Pi's transcript declares every active tool, but Pi removes some from requests
 * (codemode `only` mode) and other extensions can edit the request. Native
 * compaction declares these saved tools so it shares the turns' prompt-cache
 * prefix, also after a resume or a branch switch.
 */
export const REQUEST_TOOLS_ENTRY_TYPE = "openai-codex-compat-request-tools";
export const REQUEST_TOOLS_FORMAT_VERSION = 1;

export type RequestToolsData = {
  kind: typeof REQUEST_TOOLS_ENTRY_TYPE;
  version: typeof REQUEST_TOOLS_FORMAT_VERSION;
  modelId: string;
  tools: JsonRecord[];
  /** Input properties of grammar tools, which replayed history encodes as custom tool calls. */
  grammarToolInputProperties: Array<[string, string]>;
};

export type RequestTools = {
  tools: JsonRecord[];
  grammarToolInputProperties: GrammarToolInputProperties;
};

export function requestToolsData(
  modelId: string,
  tools: readonly JsonRecord[],
  grammarToolInputProperties: GrammarToolInputProperties,
): RequestToolsData {
  return {
    kind: REQUEST_TOOLS_ENTRY_TYPE,
    version: REQUEST_TOOLS_FORMAT_VERSION,
    modelId,
    tools: tools.map((tool) => structuredClone(tool)),
    grammarToolInputProperties: [...grammarToolInputProperties].toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  };
}

function parseRequestTools(value: unknown): RequestToolsData | undefined {
  if (
    !isObject(value) ||
    value.kind !== REQUEST_TOOLS_ENTRY_TYPE ||
    value.version !== REQUEST_TOOLS_FORMAT_VERSION ||
    !isString(value.modelId) ||
    !Array.isArray(value["tools"]) ||
    !Array.isArray(value["grammarToolInputProperties"])
  ) {
    return undefined;
  }
  const tools: JsonRecord[] = [];
  for (const tool of value["tools"]) {
    if (!isObject(tool) || !isJsonValue(tool)) return undefined;
    tools.push(structuredClone(tool));
  }
  const properties: Array<[string, string]> = [];
  for (const pair of value["grammarToolInputProperties"]) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [name, property] = pair;
    if (!isString(name) || !isString(property)) return undefined;
    properties.push([name, property]);
  }
  return {
    kind: REQUEST_TOOLS_ENTRY_TYPE,
    version: REQUEST_TOOLS_FORMAT_VERSION,
    modelId: value.modelId,
    tools,
    grammarToolInputProperties: properties,
  };
}

/**
 * The tools of the branch's latest request to a model. Entries that do not
 * parse, such as a format a later version wrote, are skipped.
 */
export function latestRequestTools(
  branch: readonly SessionEntry[],
  modelId: string,
): RequestTools | undefined {
  const data = latestRequestToolsData(branch, modelId);
  return data
    ? { tools: data.tools, grammarToolInputProperties: new Map(data.grammarToolInputProperties) }
    : undefined;
}

function latestRequestToolsData(
  branch: readonly SessionEntry[],
  modelId: string,
): RequestToolsData | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== REQUEST_TOOLS_ENTRY_TYPE) continue;
    const data = parseRequestTools(entry.data);
    if (data?.modelId === modelId) return data;
  }
  return undefined;
}

/** Whether a request's tools differ from the branch's latest saved tools for its model. */
export function requestToolsChanged(
  branch: readonly SessionEntry[],
  data: RequestToolsData,
): boolean {
  const latest = latestRequestToolsData(branch, data.modelId);
  return latest === undefined || stableResponsesJson(latest) !== stableResponsesJson(data);
}
