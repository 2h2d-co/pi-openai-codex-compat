import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { processCodexStream } from "../extensions/openai-codex-compat/codex-stream.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

const model = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<any>;

function output(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

async function* events(values: JsonRecord[]): AsyncGenerator<JsonRecord> {
  yield* values;
}

void test("parses reasoning and grammar tool calls into canonical Pi content", async () => {
  const message = output();
  const stream = createAssistantMessageEventStream();
  const patch = "*** Begin Patch\n*** End Patch";

  await processCodexStream(
    events([
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "Planning",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Planning" }],
          encrypted_content: "opaque-reasoning",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_1",
          name: "apply_patch",
          input: "",
        },
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 1,
        delta: patch,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_1",
          name: "apply_patch",
          input: patch,
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ]),
    message,
    stream,
    model,
    new Map([["apply_patch", "patch"]]),
  );

  assert.equal(message.responseId, "resp_1");
  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.usage.reasoning, 2);
  const thinking = message.content.find((block) => block.type === "thinking");
  assert.ok(thinking?.thinkingSignature?.includes("opaque-reasoning"));
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall?.arguments, { patch });
  assert.equal(toolCall?.id, "call_1|ctc_1");
});
