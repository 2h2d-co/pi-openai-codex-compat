import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { CODEX_API, CODEX_PROVIDER } from "./codex-identifiers.ts";
import { isNonNullObject } from "./value-contracts.ts";
import { selectedRegistryModel } from "./model-context.ts";

const OUTPUT_LIMIT_RAW_STOP_REASON = "incomplete.max_output_tokens";

export const OUTPUT_LIMIT_CONTINUATION_TYPE = "openai-codex-compat-output-limit-continuation";
export const OUTPUT_LIMIT_CONTINUATION_PROMPT =
  "The previous model response reached its output token limit. Continue the interrupted task from where it stopped without repeating completed work.";

export type OutputLimitContinuationContext = {
  hasPendingMessages: () => boolean;
  isIdle: () => boolean;
  model: Model<Api> | undefined;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};

export type OutputLimitContinuationAgentEndHandler = (
  event: {
    messages: readonly unknown[];
  },
  ctx: OutputLimitContinuationContext,
) => Promise<void> | void;

export type OutputLimitContinuationCompactionHandler = (
  event: {
    signal: AbortSignal;
  },
  ctx: OutputLimitContinuationContext,
) => Promise<void> | void;

export type OutputLimitContinuationLifecycleHandler = (
  ctx: OutputLimitContinuationContext,
) => Promise<void> | void;

export type OutputLimitContinuationApi = {
  onAgentEnd: (handler: OutputLimitContinuationAgentEndHandler) => void;
  onAgentSettled: (handler: OutputLimitContinuationLifecycleHandler) => void;
  onSessionBeforeCompact: (handler: OutputLimitContinuationCompactionHandler) => void;
  onSessionCompact: (handler: OutputLimitContinuationLifecycleHandler) => void;
  onSessionShutdown: (handler: OutputLimitContinuationLifecycleHandler) => void;
  sendMessage: (
    message: {
      content: string;
      customType: string;
      details?: unknown;
      display: boolean;
    },
    options?: { triggerTurn?: boolean },
  ) => void;
};

export function outputLimitContinuationApi(pi: ExtensionAPI): OutputLimitContinuationApi {
  const context = (ctx: ExtensionContext): OutputLimitContinuationContext => {
    return {
      hasPendingMessages: () => ctx.hasPendingMessages(),
      isIdle: () => ctx.isIdle(),
      model: selectedRegistryModel(ctx),
      sessionManager: ctx.sessionManager,
    };
  };

  return {
    onAgentEnd: (handler) =>
      pi.on("agent_end", (event, ctx) => handler({ messages: event.messages }, context(ctx))),
    onAgentSettled: (handler) => pi.on("agent_settled", (_event, ctx) => handler(context(ctx))),
    onSessionBeforeCompact: (handler) =>
      pi.on("session_before_compact", (event, ctx) =>
        handler({ signal: event.signal }, context(ctx)),
      ),
    onSessionCompact: (handler) => pi.on("session_compact", (_event, ctx) => handler(context(ctx))),
    onSessionShutdown: (handler) =>
      pi.on("session_shutdown", (_event, ctx) => handler(context(ctx))),
    sendMessage: (message, options) => pi.sendMessage(message, options),
  };
}

type OutputLimitContinuationDetails = {
  reason: "max_output_tokens";
  responseIdHash?: string;
};

type PendingRecovery = {
  responseIdHash: string | undefined;
  compaction: "none" | "started" | "completed";
  cancelled: boolean;
};

function isSelectedCodexModel(model: Model<Api> | undefined): boolean {
  return model?.provider === CODEX_PROVIDER && model.api === CODEX_API;
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  return messages.findLast(
    (message): message is AssistantMessage =>
      isNonNullObject(message) && "role" in message && message.role === "assistant",
  );
}

function recoverableOutputLimit(
  assistant: AssistantMessage | undefined,
): assistant is AssistantMessage {
  return (
    assistant?.provider === CODEX_PROVIDER &&
    assistant.api === CODEX_API &&
    assistant.stopReason === "length" &&
    assistant.rawStopReason === OUTPUT_LIMIT_RAW_STOP_REASON
  );
}

function responseIdHash(responseId: string | undefined): string | undefined {
  return responseId ? createHash("sha256").update(responseId, "utf8").digest("hex") : undefined;
}

function continuationAlreadyRecorded(
  ctx: OutputLimitContinuationContext,
  hash: string | undefined,
): boolean {
  if (!hash) return false;
  return ctx.sessionManager.getBranch().some((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== OUTPUT_LIMIT_CONTINUATION_TYPE) {
      return false;
    }
    return (
      isNonNullObject(entry.details) &&
      "responseIdHash" in entry.details &&
      entry.details.responseIdHash === hash
    );
  });
}

export default function registerOutputLimitContinuation(pi: OutputLimitContinuationApi): void {
  const pendingRecoveries = new Map<string, PendingRecovery>();

  // Record intent at agent_end, then wait for agent_settled. Pi performs any
  // post-run threshold compaction between those events, so a successful
  // compaction is installed before the continuation starts.
  pi.onAgentEnd((event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!isSelectedCodexModel(ctx.model) || ctx.hasPendingMessages()) {
      pendingRecoveries.delete(sessionId);
      return;
    }

    const assistant = lastAssistant(event.messages);
    if (!recoverableOutputLimit(assistant)) {
      pendingRecoveries.delete(sessionId);
      return;
    }

    const hash = responseIdHash(assistant.responseId);
    if (continuationAlreadyRecorded(ctx, hash)) {
      pendingRecoveries.delete(sessionId);
      return;
    }
    pendingRecoveries.set(sessionId, {
      responseIdHash: hash,
      compaction: "none",
      cancelled: false,
    });
  });

  pi.onSessionBeforeCompact((event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const recovery = pendingRecoveries.get(sessionId);
    if (!recovery) return;

    recovery.compaction = "started";
    const cancel = () => {
      if (pendingRecoveries.get(sessionId) === recovery) recovery.cancelled = true;
    };
    if (event.signal.aborted) cancel();
    else event.signal.addEventListener("abort", cancel, { once: true });
  });

  pi.onSessionCompact((ctx) => {
    const recovery = pendingRecoveries.get(ctx.sessionManager.getSessionId());
    if (recovery?.compaction === "started") recovery.compaction = "completed";
  });

  pi.onAgentSettled((ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const recovery = pendingRecoveries.get(sessionId);
    if (!recovery) return;
    pendingRecoveries.delete(sessionId);

    const compactionFailed = recovery.compaction === "started";
    if (
      recovery.cancelled ||
      compactionFailed ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      continuationAlreadyRecorded(ctx, recovery.responseIdHash)
    ) {
      return;
    }

    const details: OutputLimitContinuationDetails = {
      reason: "max_output_tokens",
    };
    if (recovery.responseIdHash) details.responseIdHash = recovery.responseIdHash;
    pi.sendMessage(
      {
        customType: OUTPUT_LIMIT_CONTINUATION_TYPE,
        content: OUTPUT_LIMIT_CONTINUATION_PROMPT,
        display: false,
        details,
      },
      { triggerTurn: true },
    );
  });

  pi.onSessionShutdown((ctx) => {
    pendingRecoveries.delete(ctx.sessionManager.getSessionId());
  });
}
