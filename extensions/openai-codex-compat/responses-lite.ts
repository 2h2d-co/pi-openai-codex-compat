import { isString } from "./value-contracts.ts";
import { isObject, type JsonRecord, type JsonValue } from "./codex-protocol.ts";
import { DEFAULT_FUNCTION_NAMESPACE } from "./namespaced-tools.ts";

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const RESPONSES_LITE_WS_METADATA_KEY =
  "ws_request_header_x_openai_internal_codex_responses_lite";
const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
]);

function isHostedTool(tool: JsonRecord): boolean {
  return (
    tool.type === "web_search" ||
    tool.type === "web_search_preview" ||
    tool.type === "image_generation"
  );
}

function responsesLiteTools(value: unknown): JsonRecord[] {
  const functionTools: JsonRecord[] = [];
  const functions: JsonRecord = {
    type: "namespace",
    name: DEFAULT_FUNCTION_NAMESPACE,
    description: "",
    tools: functionTools,
  };
  const result: JsonRecord[] = [];
  let functionsIndex: number | undefined;

  for (const candidate of Array.isArray(value) ? value : []) {
    if (!isObject(candidate)) throw new Error("Responses Lite received an invalid tool.");
    const tool = structuredClone(candidate);
    if (tool.type === "function" || tool.type === "custom") {
      if (!isString(tool.name)) {
        throw new Error("Responses Lite received an invalid default-namespace tool.");
      }
      functionsIndex ??= result.length;
      functionTools.push(tool);
      continue;
    }
    if (tool.type === "namespace" && tool.name === DEFAULT_FUNCTION_NAMESPACE) {
      functionsIndex ??= result.length;
      if (isString(tool["description"]) && tool["description"].trim()) {
        functions["description"] = tool["description"];
      }
      if (!Array.isArray(tool.tools)) {
        throw new Error("Responses Lite received an invalid functions namespace.");
      }
      for (const child of tool.tools) {
        if (
          !isObject(child) ||
          (child.type !== "function" && child.type !== "custom") ||
          !isString(child.name)
        ) {
          throw new Error("Responses Lite received an invalid functions namespace tool.");
        }
        const cloned = structuredClone(child);
        functionTools.push(cloned);
      }
      continue;
    }
    if (!isHostedTool(tool)) result.push(tool);
  }

  if (functionsIndex !== undefined && functionTools.length > 0) {
    result.splice(functionsIndex, 0, functions);
  }
  return result;
}

function prepareInputItem(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => prepareInputItem(item));
  }
  if (!isObject(value)) return value;

  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "detail" && value.type === "input_image") continue;
    if (child === undefined) continue;
    result[key] = prepareInputItem(child);
  }
  return result;
}

export function usesResponsesLite(modelId: string, enabled = true): boolean {
  return enabled && RESPONSES_LITE_MODELS.has(modelId);
}

export function applyResponsesLite(
  payload: JsonRecord,
  modelId: string,
  enabled = true,
): JsonRecord {
  if (!usesResponsesLite(modelId, enabled)) return payload;
  if (!Array.isArray(payload.input)) {
    throw new Error("Responses Lite requires array input.");
  }

  const requestInput = payload.input;
  const result = structuredClone(payload);
  const tools = responsesLiteTools(result.tools);
  const input = requestInput.map((item) => prepareInputItem(item));
  result.input = [
    { type: "additional_tools", role: "developer", tools },
    ...promptItems(result.instructions),
    ...input,
  ];
  delete result.instructions;
  delete result.tools;
  result.parallel_tool_calls = false;
  const reasoning = isObject(result["reasoning"]) ? { ...result["reasoning"] } : {};
  reasoning["context"] = "all_turns";
  result["reasoning"] = reasoning;
  const clientMetadata = isObject(result.client_metadata) ? { ...result.client_metadata } : {};
  clientMetadata[RESPONSES_LITE_WS_METADATA_KEY] = "true";
  result.client_metadata = clientMetadata;
  return result;
}

/** The system prompt as the developer message official Codex sends, or nothing when it is empty. */
function promptItems(instructions: JsonValue | undefined): JsonRecord[] {
  if (!isString(instructions) || instructions.length === 0) return [];
  return [
    { type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] },
  ];
}

/**
 * The request as sent. Codex takes the system prompt as the first developer message in `input`,
 * after Responses Lite's `additional_tools`, and no top-level `instructions`, as Pi AI's Codex
 * adapter and official Codex send it. From GPT-6.2 on, Codex places `instructions` after
 * `input`, so every new turn would miss the prompt cache for the system prompt. Requests are
 * built with `instructions`, which native compaction templates and cache diagnostics read, and
 * this projection moves it into `input`.
 */
export function wireRequestBody(
  payload: JsonRecord,
  modelId: string,
  liteEnabled = true,
): JsonRecord {
  if (usesResponsesLite(modelId, liteEnabled))
    return applyResponsesLite(payload, modelId, liteEnabled);
  if (!("instructions" in payload)) return payload;
  if (!Array.isArray(payload.input)) {
    throw new Error("A Codex request requires array input.");
  }
  const result = structuredClone(payload);
  delete result.instructions;
  result.input = [
    ...promptItems(payload.instructions),
    ...payload.input.map((item) => structuredClone(item)),
  ];
  return result;
}

export function applyResponsesLiteHeaders(headers: Headers, payload: JsonRecord): void {
  const metadata = payload.client_metadata;
  if (isObject(metadata) && metadata[RESPONSES_LITE_WS_METADATA_KEY] === "true") {
    headers.set(RESPONSES_LITE_HEADER, "true");
  }
}

/** Keep the WebSocket-only Lite marker out of HTTP/SSE request bodies. */
export function responsesLiteSsePayload(payload: JsonRecord): JsonRecord {
  const metadata = payload.client_metadata;
  if (!isObject(metadata) || metadata[RESPONSES_LITE_WS_METADATA_KEY] === undefined) {
    return payload;
  }
  const clientMetadata = { ...metadata };
  delete clientMetadata[RESPONSES_LITE_WS_METADATA_KEY];
  return {
    ...payload,
    client_metadata: clientMetadata,
  };
}
