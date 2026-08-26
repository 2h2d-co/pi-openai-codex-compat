import type { Static } from "typebox";
import type { JsonRecord } from "./codex-protocol.ts";

export const RESPONSES_GRAMMAR_FORMAT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "grammar" },
    syntax: { type: "string" },
    definition: { type: "string" },
  },
  required: ["type", "syntax", "definition"],
} as const;

export type ResponsesGrammarFormat = Static<typeof RESPONSES_GRAMMAR_FORMAT_SCHEMA>;

export const RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "function" },
    name: { type: "string" },
    description: { type: "string" },
    parameters: { type: "object" },
    output_schema: { type: "object" },
    strict: { type: "boolean" },
    defer_loading: { type: "boolean" },
  },
  required: ["type", "name", "description", "parameters"],
} as const;

export type ResponsesFunctionToolDefinition = Static<
  typeof RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA
>;

export const RESPONSES_CUSTOM_TOOL_DEFINITION_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "custom" },
    name: { type: "string" },
    description: { type: "string" },
    format: RESPONSES_GRAMMAR_FORMAT_SCHEMA,
    defer_loading: { type: "boolean" },
  },
  required: ["type", "name", "description", "format"],
} as const;

export type ResponsesCustomToolDefinition = Static<typeof RESPONSES_CUSTOM_TOOL_DEFINITION_SCHEMA>;

export const RESPONSES_NAMESPACE_TOOL_DEFINITION_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "namespace" },
    name: { type: "string" },
    description: { type: "string" },
    tools: {
      type: "array",
      items: RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA,
    },
  },
  required: ["type", "name", "description", "tools"],
} as const;

export type ResponsesNamespaceToolDefinition = Static<
  typeof RESPONSES_NAMESPACE_TOOL_DEFINITION_SCHEMA
>;

export const RESPONSES_WEB_SEARCH_TOOL_DEFINITION_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "web_search" },
    external_web_access: { type: "boolean" },
    indexed_web_access: { type: "boolean" },
    search_content_types: {
      type: "array",
      items: { enum: ["text", "image"] },
    },
  },
  required: ["type"],
} as const;

export type ResponsesWebSearchToolDefinition = Static<
  typeof RESPONSES_WEB_SEARCH_TOOL_DEFINITION_SCHEMA
>;

export const RESPONSES_TOOL_DEFINITION_SCHEMA = {
  anyOf: [
    RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA,
    RESPONSES_CUSTOM_TOOL_DEFINITION_SCHEMA,
    RESPONSES_NAMESPACE_TOOL_DEFINITION_SCHEMA,
    RESPONSES_WEB_SEARCH_TOOL_DEFINITION_SCHEMA,
  ],
} as const;

export type ResponsesToolDefinition = JsonRecord & Static<typeof RESPONSES_TOOL_DEFINITION_SCHEMA>;
