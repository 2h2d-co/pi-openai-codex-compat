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

void test("maps allowlisted Responses namespace calls to dotted Pi tool names", async () => {
  const message = output();
  const stream = createAssistantMessageEventStream();

  await processCodexStream(
    events([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_web",
          call_id: "call_web",
          name: "run",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"search_query":[{"q":"Pi"}]}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_web",
          call_id: "call_web",
          namespace: "web",
          name: "run",
          arguments: '{"search_query":[{"q":"Pi"}]}',
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_web",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
    message,
    stream,
    model,
    new Map(),
  );

  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.equal(toolCall?.name, "web.run");
  assert.deepEqual(toolCall?.arguments, { search_query: [{ q: "Pi" }] });
});

void test("rejects unknown and flat namespace tool calls", async () => {
  for (const item of [
    {
      type: "function_call",
      id: "fc_unknown",
      call_id: "call_unknown",
      namespace: "unknown",
      name: "run",
      arguments: "{}",
    },
    {
      type: "function_call",
      id: "fc_flat",
      call_id: "call_flat",
      name: "web.run",
      arguments: "{}",
    },
  ]) {
    await assert.rejects(
      processCodexStream(
        events([{ type: "response.output_item.added", output_index: 0, item }]),
        output(),
        createAssistantMessageEventStream(),
        model,
        new Map(),
      ),
      /namespaced tool|unsupported namespaced tool call/,
    );
  }
});

void test("distinguishes token limits from other incomplete responses", async () => {
  for (const scenario of [
    {
      reason: "max_output_tokens",
      stopReason: "length",
      rawStopReason: "incomplete.max_output_tokens",
      errorMessage: undefined,
    },
    {
      reason: "content_filter",
      stopReason: "error",
      rawStopReason: "incomplete.content_filter",
      errorMessage: "Response incomplete: content_filter",
    },
    {
      reason: undefined,
      stopReason: "error",
      rawStopReason: "incomplete",
      errorMessage: "Response incomplete without a provider reason",
    },
  ] as const) {
    const message = output();
    await processCodexStream(
      events([
        {
          type: "response.incomplete",
          response: {
            id: "resp_incomplete",
            status: "incomplete",
            ...(scenario.reason ? { incomplete_details: { reason: scenario.reason } } : {}),
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]),
      message,
      createAssistantMessageEventStream(),
      model,
      new Map(),
    );

    assert.equal(message.stopReason, scenario.stopReason);
    assert.equal(message.rawStopReason, scenario.rawStopReason);
    assert.equal(message.errorMessage, scenario.errorMessage);
  }
});

void test("drops unknown terminal response statuses like Pi AI", async () => {
  const message = output();
  await processCodexStream(
    events([
      {
        type: "response.completed",
        response: {
          id: "resp_unknown",
          status: "future_status",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
    message,
    createAssistantMessageEventStream(),
    model,
    new Map(),
  );

  assert.equal(message.stopReason, "stop");
  assert.equal(message.rawStopReason, undefined);
});
