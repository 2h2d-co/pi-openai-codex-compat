import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import registerOutputLimitContinuation, {
  type OutputLimitContinuationApi,
  type OutputLimitContinuationContext,
} from "../../extensions/openai-codex-compat/output-limit-continuation.ts";
import { codexModel } from "./output-limit-continuation-contracts-and-builders.ts";

export type TestEvent = {
  messages?: unknown[];
  signal?: AbortSignal;
};
export type TestHandler = (
  event: TestEvent,
  ctx: OutputLimitContinuationContext,
) => Promise<void> | void;

export function continuationHarness(options?: {
  pending?: boolean;
  idle?: boolean;
  branch?: SessionEntry[];
}) {
  const handlers = new Map<string, TestHandler>();
  const sent: Array<{
    message: Parameters<OutputLimitContinuationApi["sendMessage"]>[0];
    options: Parameters<OutputLimitContinuationApi["sendMessage"]>[1];
  }> = [];
  const branch = options?.branch ?? [];
  const pi: OutputLimitContinuationApi = {
    onAgentEnd: (handler) =>
      handlers.set("agent_end", (event, ctx) => {
        if (!event.messages) throw new Error("agent_end test event has no messages.");
        return handler({ messages: event.messages }, ctx);
      }),
    onAgentSettled: (handler) => handlers.set("agent_settled", (_event, ctx) => handler(ctx)),
    onSessionBeforeCompact: (handler) =>
      handlers.set("session_before_compact", (event, ctx) => {
        if (!event.signal) {
          throw new Error("session_before_compact test event has no signal.");
        }
        return handler({ signal: event.signal }, ctx);
      }),
    onSessionCompact: (handler) => handlers.set("session_compact", (_event, ctx) => handler(ctx)),
    onSessionShutdown: (handler) => handlers.set("session_shutdown", (_event, ctx) => handler(ctx)),
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  registerOutputLimitContinuation(pi);
  const ctx = {
    model: codexModel(),
    isIdle: () => options?.idle ?? true,
    hasPendingMessages: () => options?.pending ?? false,
    sessionManager: {
      getSessionId: () => "session-output-limit",
      getBranch: () => branch,
    },
  } satisfies OutputLimitContinuationContext;
  return {
    sent,
    async emit(event: string, payload: TestEvent = {}, context = ctx) {
      const handler = handlers.get(event);
      assert.ok(handler);
      await handler(payload, context);
    },
  };
}

export function outputLimitResponseIdHash(): string {
  return createHash("sha256").update("response-output-limit", "utf8").digest("hex");
}
