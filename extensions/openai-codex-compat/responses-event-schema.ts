import type { Static } from "typebox";

export const RESPONSES_TERMINAL_EVENT_TYPE_SCHEMA = {
  enum: ["response.completed", "response.incomplete", "response.failed"],
} as const;

export type ResponsesTerminalEventType = Static<typeof RESPONSES_TERMINAL_EVENT_TYPE_SCHEMA>;
