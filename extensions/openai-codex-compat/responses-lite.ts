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
  const prefix: JsonRecord[] = [{ type: "additional_tools", role: "developer", tools }];
  if (isString(result.instructions) && result.instructions.length > 0) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: result.instructions }],
    });
  }
  result.input = [...prefix, ...input];
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
