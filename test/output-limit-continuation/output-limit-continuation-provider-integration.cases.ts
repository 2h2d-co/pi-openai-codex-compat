import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
  OUTPUT_LIMIT_CONTINUATION_TYPE,
} from "../../extensions/openai-codex-compat/output-limit-continuation.ts";
import type { JsonRecord } from "./output-limit-continuation-contracts-and-builders.ts";
import {
  incompleteEvents,
  exhaustedOutputLimitEvents,
  compactionEvents,
  contextOverflowEvents,
  textEvents,
  followUpEvents,
  startCodexServer,
  createTestSession,
} from "./output-limit-continuation-session-harness.ts";

void test("resamples a Codex output limit before returning control to Pi", async (t) => {
  const server = await startCodexServer(t);
  const { session } = await createTestSession(t, server.baseUrl);

  await session.prompt("finish this task", { expandPromptTemplates: false });
  await session.waitForIdle();

  assert.equal(server.requests.length, 3);
  const [initial, resampled, thresholdCompaction] = server.requests;
  assert.ok(initial);
  assert.ok(resampled);
  assert.ok(thresholdCompaction);
  assert.match(JSON.stringify(resampled["input"]), /partial progress/);
  assert.equal(
    (resampled["input"] as JsonRecord[]).some((item) => item["type"] === "compaction_trigger"),
    false,
  );
  assert.equal(
    (thresholdCompaction["input"] as JsonRecord[]).some(
      (item) => item["type"] === "compaction_trigger",
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(resampled["input"]),
    new RegExp(OUTPUT_LIMIT_CONTINUATION_PROMPT),
  );

  const branch = session.sessionManager.getBranch();
  const lengthIndex = branch.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "length",
  );
  const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
  const continuationIndex = branch.findIndex(
    (entry) =>
      entry.type === "custom_message" && entry.customType === OUTPUT_LIMIT_CONTINUATION_TYPE,
  );
  const finalAssistant = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );

  assert.equal(lengthIndex, -1);
  assert.ok(compactionIndex >= 0);
  assert.equal(continuationIndex, -1);
  assert.equal(finalAssistant?.type, "message");
  assert.equal(
    finalAssistant?.type === "message" && finalAssistant.message.role === "assistant"
      ? finalAssistant.message.stopReason
      : undefined,
    "stop",
  );
  assert.match(
    JSON.stringify(
      finalAssistant?.type === "message" && finalAssistant.message.role === "assistant"
        ? finalAssistant.message.content
        : [],
    ),
    /partial progress.*continued after resampling/,
  );
  assert.equal(session.isIdle, true);
});

void test("preserves committed progress across overflow compaction and automatic retry", async (t) => {
  const server = await startCodexServer(t, (requestNumber, body) => {
    const input = body["input"] as JsonRecord[];
    if (input.some((item) => item["type"] === "compaction_trigger")) return compactionEvents();
    if (requestNumber === 1) return incompleteEvents();
    if (requestNumber === 2) return contextOverflowEvents();
    return textEvents("finished after overflow recovery");
  });
  const { session } = await createTestSession(t, server.baseUrl);

  await session.prompt("finish this task", { expandPromptTemplates: false });
  await session.waitForIdle();

  assert.equal(server.requests.length, 4);
  const [initial, overflowAttempt, compaction, retry] = server.requests;
  assert.ok(initial);
  assert.ok(overflowAttempt);
  assert.ok(compaction);
  assert.ok(retry);
  assert.match(JSON.stringify(overflowAttempt["input"]), /partial progress/);
  assert.match(JSON.stringify(compaction["input"]), /finish this task.*partial progress/);
  assert.deepEqual((compaction["input"] as JsonRecord[]).at(-1), {
    type: "compaction_trigger",
  });
  assert.match(JSON.stringify(retry["input"]), /opaque-state/);
  assert.doesNotMatch(JSON.stringify(retry["input"]), /partial progress/);
  assert.doesNotMatch(JSON.stringify(retry["input"]), /context_length_exceeded/);

  const branch = session.sessionManager.getBranch();
  const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
  const failedIndex = branch.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error",
  );
  const finalAssistant = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  assert.ok(failedIndex >= 0);
  assert.ok(compactionIndex > failedIndex);
  assert.equal(
    branch.some(
      (entry) =>
        entry.type === "custom_message" && entry.customType === OUTPUT_LIMIT_CONTINUATION_TYPE,
    ),
    false,
  );
  assert.match(
    JSON.stringify(
      finalAssistant?.type === "message" && finalAssistant.message.role === "assistant"
        ? finalAssistant.message.content
        : [],
    ),
    /finished after overflow recovery/,
  );
  assert.equal(session.isIdle, true);
});

void test("compacts between successful provider follow-ups with an explicit Pi boundary", async (t) => {
  const server = await startCodexServer(t, (requestNumber, body) => {
    const input = body["input"] as JsonRecord[];
    if (input.some((item) => item["type"] === "compaction_trigger")) return compactionEvents();
    if (requestNumber === 1) return followUpEvents("first phase");
    return textEvents("second phase");
  });
  const { session } = await createTestSession(t, server.baseUrl, {
    autoCompactAtPercent: 0.002,
  });

  await session.prompt("finish this task", { expandPromptTemplates: false });
  await session.waitForIdle();

  assert.equal(server.requests.length, 3);
  const [initial, compaction, continued] = server.requests;
  assert.ok(initial);
  assert.ok(compaction);
  assert.ok(continued);
  assert.match(JSON.stringify(compaction["input"]), /finish this task.*first phase/);
  assert.deepEqual((compaction["input"] as JsonRecord[]).at(-1), {
    type: "compaction_trigger",
  });
  assert.match(JSON.stringify(continued["input"]), /opaque-state/);
  assert.doesNotMatch(JSON.stringify(continued["input"]), /first phase/);
  assert.doesNotMatch(
    JSON.stringify(continued["input"]),
    new RegExp(OUTPUT_LIMIT_CONTINUATION_PROMPT),
  );

  const branch = session.sessionManager.getBranch();
  const chronology = branch.flatMap((entry) => {
    if (entry.type === "compaction") return ["K"];
    if (entry.type === "custom_message" && entry.customType === OUTPUT_LIMIT_CONTINUATION_TYPE) {
      return ["H"];
    }
    if (entry.type !== "message") return [];
    if (entry.message.role === "user") return ["U"];
    if (entry.message.role !== "assistant") return [];
    if (entry.message.rawStopReason === "completed.end_turn_false.context_limit") return ["B1"];
    return ["B2"];
  });
  assert.deepEqual(chronology, ["U", "B1", "K", "B2"]);

  const assistants = branch.filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  assert.equal(assistants.length, 2);
  assert.match(JSON.stringify(assistants[0]), /first phase/);
  assert.match(JSON.stringify(assistants[1]), /second phase/);
  assert.equal(session.isIdle, true);
});

void test("continues a fully exhausted output limit after successful threshold compaction", async (t) => {
  const server = await startCodexServer(t, (requestNumber, body) => {
    const input = body["input"] as JsonRecord[];
    if (input.some((item) => item["type"] === "compaction_trigger")) return compactionEvents();
    if (requestNumber <= 6) return exhaustedOutputLimitEvents(requestNumber);
    return textEvents("finished after hidden continuation");
  });
  const { session } = await createTestSession(t, server.baseUrl);

  await session.prompt("finish this long task", { expandPromptTemplates: false });
  await session.waitForIdle();

  assert.equal(server.requests.length, 8);
  const compaction = server.requests[6];
  const continued = server.requests[7];
  assert.ok(compaction);
  assert.ok(continued);
  assert.match(
    JSON.stringify(compaction["input"]),
    /finish this long task.*committed output 1.*committed output 6/,
  );
  assert.deepEqual((compaction["input"] as JsonRecord[]).at(-1), {
    type: "compaction_trigger",
  });
  assert.match(JSON.stringify(continued["input"]), /opaque-state/);
  assert.match(JSON.stringify(continued["input"]), new RegExp(OUTPUT_LIMIT_CONTINUATION_PROMPT));
  assert.doesNotMatch(JSON.stringify(continued["input"]), /committed output [1-6]/);

  const branch = session.sessionManager.getBranch();
  const chronology = branch.flatMap((entry) => {
    if (entry.type === "compaction") return ["K"];
    if (entry.type === "custom_message" && entry.customType === OUTPUT_LIMIT_CONTINUATION_TYPE) {
      return ["H"];
    }
    if (entry.type !== "message") return [];
    if (entry.message.role === "user") return ["U"];
    if (entry.message.role !== "assistant") return [];
    return entry.message.stopReason === "length" ? ["L"] : ["F"];
  });
  assert.deepEqual(chronology, ["U", "L", "K", "H", "F"]);

  const hiddenContinuations = branch.filter(
    (entry) =>
      entry.type === "custom_message" && entry.customType === OUTPUT_LIMIT_CONTINUATION_TYPE,
  );
  assert.equal(hiddenContinuations.length, 1);
  assert.equal(hiddenContinuations[0]?.type, "custom_message");
  assert.equal(
    hiddenContinuations[0]?.type === "custom_message" ? hiddenContinuations[0].display : undefined,
    false,
  );
  assert.match(
    JSON.stringify(
      branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ),
    /finished after hidden continuation/,
  );
  assert.equal(session.isIdle, true);
});

void test("executes an output-limit tool call before the next provider request", async (t) => {
  const call = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    status: "completed",
    arguments: '{"path":"fixture.txt"}',
  };
  const server = await startCodexServer(t, (requestNumber) =>
    requestNumber === 1
      ? [
          { type: "response.output_item.done", output_index: 0, item: call },
          {
            type: "response.incomplete",
            response: {
              id: "resp_read",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [call],
              usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            },
          },
        ]
      : textEvents("finished after reading"),
  );
  const { cwd, session } = await createTestSession(t, server.baseUrl, { tools: true });
  await writeFile(join(cwd, "fixture.txt"), "fixture-content");

  await session.prompt("read the fixture", { expandPromptTemplates: false });
  await session.waitForIdle();

  assert.equal(server.requests.length, 2);
  const followUpInput = server.requests[1]?.["input"] as JsonRecord[];
  const toolOutput = followUpInput.find(
    (item) => item["type"] === "function_call_output" && item["call_id"] === "call_read",
  );
  assert.ok(toolOutput);
  assert.match(JSON.stringify(toolOutput), /fixture-content/);

  const branch = session.sessionManager.getBranch();
  const firstAssistant = branch.find(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "toolUse",
  );
  assert.equal(firstAssistant?.type, "message");
  assert.match(
    JSON.stringify(
      firstAssistant?.type === "message" && firstAssistant.message.role === "assistant"
        ? firstAssistant.message.diagnostics
        : [],
    ),
    /codex_response_decision.*return_tool_use/,
  );
  assert.equal(
    branch.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId.startsWith("call_read|"),
    ),
    true,
  );
  assert.equal(session.isIdle, true);
});
