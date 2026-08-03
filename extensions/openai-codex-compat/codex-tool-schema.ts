import { IMAGE_GENERATION_WIRE_PARAMETERS } from "./image-generation-schema.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "./namespaced-tools.ts";

export function codexWireToolParameters(toolName: string, parameters: unknown): unknown {
  return toolName === IMAGE_GENERATION_TOOL_NAME ? IMAGE_GENERATION_WIRE_PARAMETERS : parameters;
}

export function withCodexWireToolParameters<T extends { name: string; parameters: unknown }>(
  tool: T,
): T {
  const parameters = codexWireToolParameters(tool.name, tool.parameters);
  return parameters === tool.parameters ? tool : ({ ...tool, parameters } as T);
}
