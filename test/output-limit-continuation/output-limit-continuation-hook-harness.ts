import { extensionContextFixture } from "../support/pi-fixtures.ts";
import { extensionApiFixture } from "../support/pi-fixtures.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import registerOutputLimitContinuation from "../../extensions/openai-codex-compat/output-limit-continuation.ts";
import { codexModel, type JsonRecord } from "./output-limit-continuation-contracts-and-builders.ts";

export type TestEvent = {
  messages?: unknown[];
  signal?: AbortSignal;
};

export type TestHandler = (event: TestEvent, ctx: ExtensionContext) => void | Promise<void>;

export function continuationHarness(options?: {
  pending?: boolean;
  idle?: boolean;
  branch?: SessionEntry[];
}) {
  const handlers = new Map<string, TestHandler>();
  const sent: Array<{ message: JsonRecord; options: JsonRecord | undefined }> = [];
  const branch = options?.branch ?? [];
  const pi = extensionApiFixture({
    on(event: string, candidate: TestHandler) {
      handlers.set(event, candidate);
    },
    sendMessage(message: JsonRecord, options?: JsonRecord) {
      sent.push({ message, options });
    },
  });
  registerOutputLimitContinuation(pi);
  const ctx = extensionContextFixture({
    model: codexModel(),
    isIdle: () => options?.idle ?? true,
    hasPendingMessages: () => options?.pending ?? false,
    sessionManager: {
      getSessionId: () => "session-output-limit",
      getBranch: () => branch,
    },
  });
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
