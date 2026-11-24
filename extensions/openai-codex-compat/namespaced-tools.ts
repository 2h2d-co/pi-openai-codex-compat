import { isObject, type JsonRecord, type JsonValue } from "./codex-protocol.ts";
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

function payloadToolName(tool: JsonValue): JsonValue | undefined {
  if (!isObject(tool)) return undefined;
  if (isString(tool.name)) return tool.name;
  const fn = tool["function"];
  return isObject(fn) ? fn.name : undefined;
}

/**
 * A request payload without the Codex namespaced tools declared as plain tools, or undefined when
 * it declares none.
 *
 * These tools carry a dotted name that only this extension's Codex transport can send, as a
 * namespace. Any other transport sends the name as it is, and OpenAI refuses the whole request:
 * "tools[n].name ... does not match pattern '^[a-zA-Z0-9_-]+$'".
 *
 * Pi's own Codex provider is such a transport, and it builds a Codex request that starts during
 * session start: Pi activates a registered tool at once, whatever the configuration says, but the
 * `session_start` handler that replaces Pi's provider and synchronises the tools waits for every
 * earlier extension's handler. A request of another provider that applies OpenAI's rule would be
 * refused the same way if it were built while the tools are active.
 *
 * Pi 1.6.0's Codex provider declares tools in `additional_tools` items of `input` and leaves
 * `tools` out, so both places are searched. A namespace this extension's transport built is kept:
 * its name has no dot.
 */
export function withoutCodexNamespacedTools(payload: JsonRecord): JsonRecord | undefined {
  let removed = false;
  const sendable = (tools: JsonValue[]): JsonValue[] => {
    const kept = tools.filter((tool) => {
      const name = payloadToolName(tool);
      return !(isString(name) && CODEX_NAMESPACED_TOOL_NAMES.has(name));
    });
    if (kept.length !== tools.length) removed = true;
    return kept;
  };
  const result: JsonRecord = { ...payload };
  if (Array.isArray(payload.tools)) result.tools = sendable(payload.tools);
  if (Array.isArray(payload.input)) {
    result.input = payload.input.flatMap((item): JsonValue[] => {
      if (!isObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
        return [item];
      }
      const tools = sendable(item.tools);
      if (tools.length === item.tools.length) return [item];
      return tools.length === 0 ? [] : [{ ...item, tools }];
    });
  }
  return removed ? result : undefined;
}
