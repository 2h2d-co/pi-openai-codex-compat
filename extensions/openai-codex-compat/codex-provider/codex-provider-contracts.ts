import type {
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { OpenAICodexResponsesOptions } from "@earendil-works/pi-ai";
import type { GrammarToolInputProperties } from "../compaction-checkpoint.ts";
import type { CodexCompatConfig } from "../config.ts";
import type { ConfigResolver } from "../config-context.ts";
import type { JsonRecord } from "../codex-protocol.ts";
import type { CodexTurnState } from "../codex-transport.ts";
import type { ResponsesOutputItem } from "../responses-item-schema.ts";
import type { ResponsesTerminalEventType } from "../responses-event-schema.ts";

export type { ConfigResolver } from "../config-context.ts";

export type SessionContext = {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

type SessionScopeReader = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getLeafId" | "getSessionId"
>;

export type RuntimeScopeContext = Pick<ExtensionContext, "getContextUsage" | "hasUI"> &
  Parameters<ConfigResolver>[0] & {
    sessionManager: SessionScopeReader;
    ui: Pick<ExtensionContext["ui"], "notify">;
  };

export type CompactionSessionManager = SessionScopeReader &
  Pick<SessionManager, "appendCompaction">;

export type RuntimeScope = {
  sessionId: string;
  manager: CompactionSessionManager;
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

export type CodexTerminalState =
  | {
      type: Exclude<ResponsesTerminalEventType, "response.failed">;
      response: JsonRecord;
    }
  | {
      type: "response.failed";
      response?: JsonRecord;
    };

export type CodexTerminalCapture = {
  current?: CodexTerminalState;
};

export type CodexAttemptCapture = {
  streamedItems: ResponsesOutputItem[];
  streamedToolCallIndexes: Set<number>;
  streamedCompletedToolCallIndexes: Set<number>;
};

export type CodexToolCallAssessment = {
  completedCount: number;
  discardedPartialCount: number;
};

export type CodexPostToolDisposition = {
  callIds: string[];
  errorMessage?: string;
  response?: JsonRecord;
  retryAttempt: number;
  sessionId?: string;
  terminalType:
    | Exclude<ResponsesTerminalEventType, "response.completed">
    | "websocket_connection_limit_reached";
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
