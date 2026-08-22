import type { Static } from "typebox";
import type { JsonRecord } from "./codex-protocol.ts";
import { RESPONSES_TOOL_DEFINITION_SCHEMA } from "./responses-tool-schema.ts";

export const RESPONSES_ITEM_STATUS_SCHEMA = {
  enum: ["in_progress", "completed", "incomplete"],
} as const;

export type ResponsesItemStatus = Static<typeof RESPONSES_ITEM_STATUS_SCHEMA>;

const RESPONSES_INPUT_MESSAGE_ROLE_SCHEMA = {
  enum: ["user", "system", "developer"],
} as const;

const RESPONSES_ASSISTANT_MESSAGE_ROLE_SCHEMA = {
  const: "assistant",
} as const;

export const RESPONSES_MESSAGE_ROLE_SCHEMA = {
  anyOf: [RESPONSES_INPUT_MESSAGE_ROLE_SCHEMA, RESPONSES_ASSISTANT_MESSAGE_ROLE_SCHEMA],
} as const;

export type ResponsesMessageRole = Static<typeof RESPONSES_MESSAGE_ROLE_SCHEMA>;

export const RESPONSES_MESSAGE_PHASE_SCHEMA = {
  enum: ["commentary", "final_answer"],
} as const;

export type ResponsesMessagePhase = Static<typeof RESPONSES_MESSAGE_PHASE_SCHEMA>;

export const RESPONSES_INPUT_TEXT_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "input_text" },
    text: { type: "string" },
  },
  required: ["type", "text"],
} as const;

export type ResponsesInputTextContent = Static<typeof RESPONSES_INPUT_TEXT_CONTENT_SCHEMA>;

export const RESPONSES_INPUT_IMAGE_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "input_image" },
    image_url: { type: "string" },
    detail: { enum: ["auto", "low", "high", "original"] },
  },
  required: ["type", "image_url"],
} as const;

export type ResponsesInputImageContent = Static<typeof RESPONSES_INPUT_IMAGE_CONTENT_SCHEMA>;

export const RESPONSES_OUTPUT_TEXT_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "output_text" },
    text: { type: "string" },
    annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
        },
        required: ["type"],
      },
    },
  },
  required: ["type", "text"],
} as const;

export type ResponsesOutputTextContent = Static<typeof RESPONSES_OUTPUT_TEXT_CONTENT_SCHEMA>;

export const RESPONSES_REFUSAL_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "refusal" },
    refusal: { type: "string" },
  },
  required: ["type", "refusal"],
} as const;

export type ResponsesRefusalContent = Static<typeof RESPONSES_REFUSAL_CONTENT_SCHEMA>;

export const RESPONSES_REASONING_SUMMARY_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "summary_text" },
    text: { type: "string" },
  },
  required: ["type", "text"],
} as const;

export type ResponsesReasoningSummaryContent = Static<
  typeof RESPONSES_REASONING_SUMMARY_CONTENT_SCHEMA
>;

export const RESPONSES_REASONING_TEXT_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "reasoning_text" },
    text: { type: "string" },
  },
  required: ["type", "text"],
} as const;

export type ResponsesReasoningTextContent = Static<typeof RESPONSES_REASONING_TEXT_CONTENT_SCHEMA>;

export const RESPONSES_INPUT_CONTENT_SCHEMA = {
  anyOf: [RESPONSES_INPUT_TEXT_CONTENT_SCHEMA, RESPONSES_INPUT_IMAGE_CONTENT_SCHEMA],
} as const;

export type ResponsesInputContent = Static<typeof RESPONSES_INPUT_CONTENT_SCHEMA>;

export const RESPONSES_OUTPUT_CONTENT_SCHEMA = {
  anyOf: [RESPONSES_OUTPUT_TEXT_CONTENT_SCHEMA, RESPONSES_REFUSAL_CONTENT_SCHEMA],
} as const;

export type ResponsesOutputContent = Static<typeof RESPONSES_OUTPUT_CONTENT_SCHEMA>;

export const RESPONSES_REASONING_CONTENT_SCHEMA = {
  anyOf: [RESPONSES_REASONING_SUMMARY_CONTENT_SCHEMA, RESPONSES_REASONING_TEXT_CONTENT_SCHEMA],
} as const;

export type ResponsesReasoningContent = Static<typeof RESPONSES_REASONING_CONTENT_SCHEMA>;

export const RESPONSES_TOOL_OUTPUT_CONTENT_SCHEMA = RESPONSES_INPUT_CONTENT_SCHEMA;

export type ResponsesToolOutputContent = Static<typeof RESPONSES_TOOL_OUTPUT_CONTENT_SCHEMA>;

export const PI_INPUT_MESSAGE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "message" },
    role: RESPONSES_INPUT_MESSAGE_ROLE_SCHEMA,
    content: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: RESPONSES_INPUT_CONTENT_SCHEMA,
        },
      ],
    },
  },
  required: ["role", "content"],
} as const;

export type PiInputMessageItem = Static<typeof PI_INPUT_MESSAGE_ITEM_SCHEMA>;

export const RESPONSES_INPUT_MESSAGE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "message" },
    id: { type: "string" },
    role: RESPONSES_INPUT_MESSAGE_ROLE_SCHEMA,
    content: {
      type: "array",
      items: RESPONSES_INPUT_CONTENT_SCHEMA,
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
    phase: {
      anyOf: [RESPONSES_MESSAGE_PHASE_SCHEMA, { type: "null" }],
    },
  },
  required: ["type", "role", "content"],
} as const;

export type ResponsesInputMessageItem = Static<typeof RESPONSES_INPUT_MESSAGE_ITEM_SCHEMA>;

export const RESPONSES_OUTPUT_MESSAGE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "message" },
    id: { type: "string" },
    role: RESPONSES_ASSISTANT_MESSAGE_ROLE_SCHEMA,
    content: {
      type: "array",
      items: RESPONSES_OUTPUT_CONTENT_SCHEMA,
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
    phase: {
      anyOf: [RESPONSES_MESSAGE_PHASE_SCHEMA, { type: "null" }],
    },
  },
  required: ["type", "role", "content"],
} as const;

export type ResponsesOutputMessageItem = Static<typeof RESPONSES_OUTPUT_MESSAGE_ITEM_SCHEMA>;

export const RESPONSES_MESSAGE_ITEM_SCHEMA = {
  anyOf: [
    PI_INPUT_MESSAGE_ITEM_SCHEMA,
    RESPONSES_INPUT_MESSAGE_ITEM_SCHEMA,
    RESPONSES_OUTPUT_MESSAGE_ITEM_SCHEMA,
  ],
} as const;

export type ResponsesMessageItem = JsonRecord & Static<typeof RESPONSES_MESSAGE_ITEM_SCHEMA>;

export const RESPONSES_ADDITIONAL_TOOLS_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "additional_tools" },
    role: { const: "developer" },
    tools: {
      type: "array",
      items: RESPONSES_TOOL_DEFINITION_SCHEMA,
    },
  },
  required: ["type", "role", "tools"],
} as const;

export type ResponsesAdditionalToolsItem = Static<typeof RESPONSES_ADDITIONAL_TOOLS_ITEM_SCHEMA>;

export const RESPONSES_REASONING_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "reasoning" },
    id: { type: "string" },
    summary: {
      type: "array",
      items: RESPONSES_REASONING_SUMMARY_CONTENT_SCHEMA,
    },
    content: {
      type: "array",
      items: RESPONSES_REASONING_TEXT_CONTENT_SCHEMA,
    },
    encrypted_content: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "summary", "encrypted_content"],
} as const;

export type ResponsesReasoningItem = Static<typeof RESPONSES_REASONING_ITEM_SCHEMA>;

export const RESPONSES_FUNCTION_CALL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "function_call" },
    id: { type: "string" },
    call_id: { type: "string" },
    name: { type: "string" },
    namespace: { type: "string" },
    arguments: { type: "string" },
    encrypted_function_args: {
      type: "array",
      items: { type: "string" },
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "call_id", "name", "arguments"],
} as const;

export type ResponsesFunctionCallItem = Static<typeof RESPONSES_FUNCTION_CALL_ITEM_SCHEMA>;

export const RESPONSES_FUNCTION_CALL_OUTPUT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "function_call_output" },
    id: { type: "string" },
    call_id: { type: "string" },
    name: { type: "string" },
    namespace: { type: "string" },
    output: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: RESPONSES_TOOL_OUTPUT_CONTENT_SCHEMA,
        },
      ],
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "call_id", "output"],
} as const;

export type ResponsesFunctionCallOutputItem = Static<
  typeof RESPONSES_FUNCTION_CALL_OUTPUT_ITEM_SCHEMA
>;

export const RESPONSES_CUSTOM_TOOL_CALL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "custom_tool_call" },
    id: { type: "string" },
    call_id: { type: "string" },
    name: { type: "string" },
    namespace: { type: "string" },
    input: { type: "string" },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "call_id", "name", "input"],
} as const;

export type ResponsesCustomToolCallItem = Static<typeof RESPONSES_CUSTOM_TOOL_CALL_ITEM_SCHEMA>;

export const RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "custom_tool_call_output" },
    id: { type: "string" },
    call_id: { type: "string" },
    name: { type: "string" },
    output: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: RESPONSES_TOOL_OUTPUT_CONTENT_SCHEMA,
        },
      ],
    },
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "call_id", "output"],
} as const;

export type ResponsesCustomToolCallOutputItem = Static<
  typeof RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_ITEM_SCHEMA
>;

export const RESPONSES_TOOL_SEARCH_CALL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "tool_search_call" },
    id: { type: "string" },
    call_id: { type: "string" },
    execution: { type: "string" },
    arguments: {},
    status: RESPONSES_ITEM_STATUS_SCHEMA,
  },
  required: ["type", "call_id", "execution", "arguments"],
} as const;

export type ResponsesToolSearchCallItem = Static<typeof RESPONSES_TOOL_SEARCH_CALL_ITEM_SCHEMA>;

export const RESPONSES_TOOL_SEARCH_OUTPUT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "tool_search_output" },
    id: { type: "string" },
    call_id: { type: "string" },
    execution: { type: "string" },
    status: { type: "string" },
    tools: {
      type: "array",
      items: RESPONSES_TOOL_DEFINITION_SCHEMA,
    },
  },
  required: ["type", "call_id", "execution", "status", "tools"],
} as const;

export type ResponsesToolSearchOutputItem = Static<typeof RESPONSES_TOOL_SEARCH_OUTPUT_ITEM_SCHEMA>;

export const RESPONSES_WEB_SEARCH_CALL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "web_search_call" },
    id: { type: "string" },
    status: { type: "string" },
    action: { type: "object" },
  },
  required: ["type"],
} as const;

export type ResponsesWebSearchCallItem = Static<typeof RESPONSES_WEB_SEARCH_CALL_ITEM_SCHEMA>;

export const RESPONSES_IMAGE_GENERATION_CALL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "image_generation_call" },
    id: { type: "string" },
    status: { type: "string" },
    revised_prompt: { type: "string" },
    result: { type: "string" },
  },
  required: ["type", "status", "result"],
} as const;

export type ResponsesImageGenerationCallItem = Static<
  typeof RESPONSES_IMAGE_GENERATION_CALL_ITEM_SCHEMA
>;

export const RESPONSES_COMPACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "compaction" },
    id: { type: "string" },
    encrypted_content: { type: "string" },
  },
  required: ["type", "encrypted_content"],
} as const;

export type ResponsesCompactionItem = Static<typeof RESPONSES_COMPACTION_ITEM_SCHEMA>;

export const RESPONSES_COMPACTION_TRIGGER_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "compaction_trigger" },
  },
  required: ["type"],
} as const;

export type ResponsesCompactionTriggerItem = Static<
  typeof RESPONSES_COMPACTION_TRIGGER_ITEM_SCHEMA
>;

export const RESPONSES_TOOL_CALL_ITEM_SCHEMA = {
  anyOf: [
    RESPONSES_FUNCTION_CALL_ITEM_SCHEMA,
    RESPONSES_CUSTOM_TOOL_CALL_ITEM_SCHEMA,
    RESPONSES_TOOL_SEARCH_CALL_ITEM_SCHEMA,
  ],
} as const;

export type ResponsesToolCallItem = Static<typeof RESPONSES_TOOL_CALL_ITEM_SCHEMA>;

export const RESPONSES_TOOL_CALL_OUTPUT_ITEM_SCHEMA = {
  anyOf: [
    RESPONSES_FUNCTION_CALL_OUTPUT_ITEM_SCHEMA,
    RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_ITEM_SCHEMA,
    RESPONSES_TOOL_SEARCH_OUTPUT_ITEM_SCHEMA,
  ],
} as const;

export type ResponsesToolCallOutputItem = Static<typeof RESPONSES_TOOL_CALL_OUTPUT_ITEM_SCHEMA>;

export const RESPONSES_OUTPUT_ITEM_SCHEMA = {
  anyOf: [
    RESPONSES_OUTPUT_MESSAGE_ITEM_SCHEMA,
    RESPONSES_REASONING_ITEM_SCHEMA,
    RESPONSES_FUNCTION_CALL_ITEM_SCHEMA,
    RESPONSES_CUSTOM_TOOL_CALL_ITEM_SCHEMA,
    RESPONSES_TOOL_SEARCH_CALL_ITEM_SCHEMA,
    RESPONSES_TOOL_SEARCH_OUTPUT_ITEM_SCHEMA,
    RESPONSES_WEB_SEARCH_CALL_ITEM_SCHEMA,
    RESPONSES_IMAGE_GENERATION_CALL_ITEM_SCHEMA,
    RESPONSES_COMPACTION_ITEM_SCHEMA,
  ],
} as const;

export type ResponsesOutputItem = JsonRecord & Static<typeof RESPONSES_OUTPUT_ITEM_SCHEMA>;

export const RESPONSES_INPUT_ITEM_SCHEMA = {
  anyOf: [
    PI_INPUT_MESSAGE_ITEM_SCHEMA,
    RESPONSES_INPUT_MESSAGE_ITEM_SCHEMA,
    RESPONSES_OUTPUT_ITEM_SCHEMA,
    RESPONSES_FUNCTION_CALL_OUTPUT_ITEM_SCHEMA,
    RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_ITEM_SCHEMA,
    RESPONSES_ADDITIONAL_TOOLS_ITEM_SCHEMA,
    RESPONSES_COMPACTION_TRIGGER_ITEM_SCHEMA,
  ],
} as const;

export type ResponsesInputItem = JsonRecord & Static<typeof RESPONSES_INPUT_ITEM_SCHEMA>;
