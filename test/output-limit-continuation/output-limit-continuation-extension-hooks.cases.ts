import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
  OUTPUT_LIMIT_CONTINUATION_TYPE,
  type OutputLimitContinuationContext,
} from "../../extensions/openai-codex-compat/output-limit-continuation.ts";
import { codexModel, assistant } from "./output-limit-continuation-contracts-and-builders.ts";
import {
  continuationHarness,
  outputLimitResponseIdHash,
} from "./output-limit-continuation-hook-harness.ts";

test("starts one hidden continuation after an exact Codex output-limit stop", async () => {
  const harness = continuationHarness();
  await harness.emit("agent_end", { messages: [assistant("stop"), assistant("length")] });
  assert.deepEqual(harness.sent, []);
  await harness.emit("agent_settled");

  assert.deepEqual(harness.sent, [
    {
      message: {
        customType: OUTPUT_LIMIT_CONTINUATION_TYPE,
        content: OUTPUT_LIMIT_CONTINUATION_PROMPT,
        display: false,
        details: {
          reason: "max_output_tokens",
          responseIdHash: outputLimitResponseIdHash(),
        },
      },
      options: { triggerTurn: true },
    },
  ]);
});

test("requires the exact raw stop reason and respects existing work", async () => {
  const pending = continuationHarness({ pending: true });
  await pending.emit("agent_end", { messages: [assistant("length")] });
  await pending.emit("agent_settled");
  assert.deepEqual(pending.sent, []);

  const completed = continuationHarness();
  await completed.emit("agent_end", {
    messages: [assistant("length"), assistant("stop")],
  });
  await completed.emit("agent_settled");
  assert.deepEqual(completed.sent, []);

  const otherModel = {
    model: { ...codexModel(), provider: "openai" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "session-output-limit",
      getBranch: () => [],
    },
  } satisfies OutputLimitContinuationContext;
  await completed.emit("agent_end", { messages: [assistant("length")] }, otherModel);
  await completed.emit("agent_settled", {}, otherModel);
  assert.deepEqual(completed.sent, []);

  const genericLength = continuationHarness();
  await genericLength.emit("agent_end", {
    messages: [assistant("length", "length")],
  });
  await genericLength.emit("agent_settled");
  assert.deepEqual(genericLength.sent, []);

  const modelStillRunning = continuationHarness({ idle: false });
  await modelStillRunning.emit("agent_end", { messages: [assistant("length")] });
  await modelStillRunning.emit("agent_settled");
  assert.deepEqual(modelStillRunning.sent, []);
});

test("deduplicates recovery and suppresses cancelled or failed compaction", async () => {
  const recorded = continuationHarness({
    branch: [
      {
        type: "custom_message",
        id: "continuation-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: OUTPUT_LIMIT_CONTINUATION_TYPE,
        content: OUTPUT_LIMIT_CONTINUATION_PROMPT,
        display: false,
        details: {
          reason: "max_output_tokens",
          responseIdHash: outputLimitResponseIdHash(),
        },
      },
    ],
  });
  await recorded.emit("agent_end", { messages: [assistant("length")] });
  await recorded.emit("agent_settled");
  assert.deepEqual(recorded.sent, []);

  const cancelled = continuationHarness();
  const controller = new AbortController();
  await cancelled.emit("agent_end", { messages: [assistant("length")] });
  await cancelled.emit("session_before_compact", { signal: controller.signal });
  controller.abort();
  await cancelled.emit("agent_settled");
  assert.deepEqual(cancelled.sent, []);

  const failed = continuationHarness();
  await failed.emit("agent_end", { messages: [assistant("length")] });
  await failed.emit("session_before_compact", {
    signal: new AbortController().signal,
  });
  await failed.emit("agent_settled");
  assert.deepEqual(failed.sent, []);
});

test("continues after successful compaction completes", async () => {
  const harness = continuationHarness();
  await harness.emit("agent_end", { messages: [assistant("length")] });
  await harness.emit("session_before_compact", {
    signal: new AbortController().signal,
  });
  await harness.emit("session_compact");
  await harness.emit("agent_settled");

  assert.deepEqual(harness.sent, [
    {
      message: {
        customType: OUTPUT_LIMIT_CONTINUATION_TYPE,
        content: OUTPUT_LIMIT_CONTINUATION_PROMPT,
        display: false,
        details: {
          reason: "max_output_tokens",
          responseIdHash: outputLimitResponseIdHash(),
        },
      },
      options: { triggerTurn: true },
    },
  ]);
});
