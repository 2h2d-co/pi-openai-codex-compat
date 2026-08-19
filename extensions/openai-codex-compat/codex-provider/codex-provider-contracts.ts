import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OpenAICodexResponsesOptions, Usage } from "@earendil-works/pi-ai";
import type { GrammarToolInputProperties } from "../compaction-checkpoint.ts";
import type { CodexCompatConfig } from "../config.ts";
import type { ConfigResolver } from "../config-context.ts";
import type { JsonRecord, ResponsesItem } from "../codex-protocol.ts";
import type { CodexTurnState } from "../codex-transport.ts";

export type { ConfigResolver } from "../config-context.ts";

export type SessionContext = {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

export type RuntimeScopeContext = Pick<ExtensionContext, "getContextUsage" | "hasUI"> &
  Parameters<ConfigResolver>[0] & {
    sessionManager: Pick<
      ExtensionContext["sessionManager"],
      "getBranch" | "getLeafId" | "getSessionId"
    >;
    ui: Pick<ExtensionContext["ui"], "notify">;
  };

export type MutableSessionManager = ExtensionContext["sessionManager"] & {
  appendCompaction?: <T>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ) => string;
};

export type RuntimeScope = {
  sessionId: string;
  manager: MutableSessionManager;
  branch: SessionEntry[];
  leafId: string | null;
  contextTokens: number | null;
  contextPercent: number | null;
  config: CodexCompatConfig;
  hasUI: boolean;
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

export type RequestTemplate = {
  modelId: string;
  payload: JsonRecord;
  grammarToolInputProperties: GrammarToolInputProperties;
  requestOptions: OpenAICodexResponsesOptions;
};

export type ActiveAgentTurn = {
  turnId: string;
  startedAtUnixMs: number;
  turnState: CodexTurnState;
};

export type CodexCompat = {
  supportsToolSearch?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
};

export type CodexTerminalState = {
  type?: "response.completed" | "response.incomplete" | "response.failed";
  response?: JsonRecord;
};

export type CodexAttemptCapture = {
  streamedItems: ResponsesItem[];
  streamedToolCallIndexes: Set<number>;
  streamedCompletedToolCallIndexes: Set<number>;
};

export type CodexToolCallAssessment = {
  completedCount: number;
  discardedPartialCount: number;
  hasCompletedCalls: boolean;
};

export type CodexPostToolDisposition = {
  callIds: string[];
  errorMessage?: string;
  response?: JsonRecord;
  retryAttempt: number;
  sessionId?: string;
  terminalType: "response.incomplete" | "response.failed" | "websocket_connection_limit_reached";
  turnId: string;
  type: "error" | "retry";
};

export type CodexResponseDecision =
  | "continue_no_tools"
  | "retry_original_input"
  | "return_compaction_boundary"
  | "return_terminal"
  | "return_tool_use";

export type CodexResponseRetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
};
