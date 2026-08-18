import { isString } from "./value-contracts.ts";
export const IMAGE_GENERATION_TOOL_NAME = "image_gen.imagegen";
export const WEB_RUN_TOOL_NAME = "web.run";
export const DEFAULT_FUNCTION_NAMESPACE = "functions";

export const CODEX_NAMESPACED_TOOL_NAMES: ReadonlySet<string> = new Set([
  IMAGE_GENERATION_TOOL_NAME,
  WEB_RUN_TOOL_NAME,
]);

/** Tools whose successful text output Codex transports as `input_text` content items. */
export const CODEX_TEXT_CONTENT_ITEM_TOOL_RESULT_NAMES: ReadonlySet<string> = new Set([
  WEB_RUN_TOOL_NAME,
]);

export type NamespacedToolName = {
  namespace: string;
  name: string;
};

export function splitNamespacedToolName(
  toolName: string,
  allowedNames: ReadonlySet<string> = CODEX_NAMESPACED_TOOL_NAMES,
): NamespacedToolName | undefined {
  if (!allowedNames.has(toolName)) return undefined;
  const separator = toolName.indexOf(".");
  if (separator <= 0 || separator === toolName.length - 1) {
    throw new Error(`Invalid namespaced Codex tool name: ${toolName}`);
  }
  return {
    namespace: toolName.slice(0, separator),
    name: toolName.slice(separator + 1),
  };
}

export function namespacedToolCallName(namespace: unknown, name: unknown): string {
  if (!isString(namespace) || !isString(name)) {
    throw new Error("Codex returned a namespaced tool call without a valid namespace and name.");
  }
  if (namespace === "" || namespace === DEFAULT_FUNCTION_NAMESPACE) return name;
  const toolName = `${namespace}.${name}`;
  if (!CODEX_NAMESPACED_TOOL_NAMES.has(toolName)) {
    throw new Error(`Codex returned an unsupported namespaced tool call: ${toolName}`);
  }
  return toolName;
}
