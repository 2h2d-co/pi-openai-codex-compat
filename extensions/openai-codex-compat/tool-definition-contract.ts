import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ConfigContext } from "./config-context.ts";

export type ToolDefinitionWithContext<TParams extends TSchema, TDetails, TState, TContext> = Omit<
  ToolDefinition<TParams, TDetails, TState>,
  "execute"
> & {
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: TContext,
  ): Promise<AgentToolResult<TDetails>>;
};

export type CodexToolExecutionContext = ConfigContext & {
  model: Model<Api> | undefined;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};
