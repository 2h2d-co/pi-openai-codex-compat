import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isNonNullObject } from "./value-contracts.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const OUTPUT_LIMIT_RAW_STOP_REASON = "incomplete.max_output_tokens";

export const OUTPUT_LIMIT_CONTINUATION_TYPE = "openai-codex-compat-output-limit-continuation";
export const OUTPUT_LIMIT_CONTINUATION_PROMPT =
  "The previous model response reached its output token limit. Continue the interrupted task from where it stopped without repeating completed work.";

type OutputLimitContinuationDetails = {
  reason: "max_output_tokens";
  responseIdHash?: string;
};

type PendingRecovery = {
  responseIdHash: string | undefined;
  compaction: "none" | "started" | "completed";
  cancelled: boolean;
};

function isSelectedCodexModel(model: Model<any> | undefined): boolean {
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

function continuationAlreadyRecorded(ctx: ExtensionContext, hash: string | undefined): boolean {
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

export default function registerOutputLimitContinuation(pi: ExtensionAPI): void {
  const pendingRecoveries = new Map<string, PendingRecovery>();

  // Record intent at agent_end, then wait for agent_settled. Pi performs any
  // post-run threshold compaction between those events, so a successful
  // compaction is installed before the continuation starts.
  pi.on("agent_end", (event, ctx) => {
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

  pi.on("session_before_compact", (event, ctx) => {
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

  pi.on("session_compact", (_event, ctx) => {
    const recovery = pendingRecoveries.get(ctx.sessionManager.getSessionId());
    if (recovery?.compaction === "started") recovery.compaction = "completed";
  });

  pi.on("agent_settled", (_event, ctx) => {
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

  pi.on("session_shutdown", (_event, ctx) => {
    pendingRecoveries.delete(ctx.sessionManager.getSessionId());
  });
}
