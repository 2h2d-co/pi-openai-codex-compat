import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
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
} satisfies Model<Api>;

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

void test("ignores terminal output and commits only output_item.done items", async () => {
  const message = output();
  const stream = createAssistantMessageEventStream();
  const reasoning = {
    type: "reasoning",
    id: "rs_terminal",
    status: "completed",
    summary: [{ type: "summary_text", text: "Plan" }],
    encrypted_content: "opaque-terminal-reasoning",
  };

  await processCodexStream(
    events([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoning,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_output",
          status: "completed",
          output: [
            reasoning,
            {
              type: "message",
              id: "msg_terminal",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Ready", annotations: [] }],
            },
            {
              type: "function_call",
              id: "fc_terminal",
              call_id: "call_function",
              name: "report",
              status: "completed",
              arguments: '{"value":"terminal"}',
            },
            {
              type: "custom_tool_call",
              id: "ctc_terminal",
              call_id: "call_custom",
              name: "apply_patch",
              status: "completed",
              input: "*** Begin Patch\n*** End Patch",
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
    message,
    stream,
    model,
    new Map([["apply_patch", "patch"]]),
  );

  assert.equal(message.stopReason, "stop");
  assert.deepEqual(
    message.content.map((block) =>
      block.type === "thinking"
        ? { type: block.type, text: block.thinking }
        : block.type === "text"
          ? { type: block.type, text: block.text }
          : { type: block.type, name: block.name, arguments: block.arguments },
    ),
    [{ type: "thinking", text: "Plan" }],
  );
});

void test("matches Pi AI's closed grammar-input error wording", async () => {
  await assert.rejects(
    processCodexStream(
      events([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "custom_tool_call",
            id: "ctc_1",
            call_id: "call_1",
            name: "apply_patch",
            input: "",
          },
        },
        {
          type: "response.custom_tool_call_input.done",
          output_index: 0,
          input: "first",
        },
        {
          type: "response.custom_tool_call_input.done",
          output_index: 0,
          input: "changed",
        },
      ]),
      output(),
      createAssistantMessageEventStream(),
      model,
      new Map([["apply_patch", "patch"]]),
    ),
    {
      message: 'grammar tool input for property "patch" changed after it was closed',
    },
  );
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

void test("maps the Responses Lite functions namespace to bare Pi tool names", async () => {
  const message = output();

  await processCodexStream(
    events([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          namespace: "functions",
          name: "read",
          arguments: "",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          namespace: "functions",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_read",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
    message,
    createAssistantMessageEventStream(),
    model,
    new Map(),
  );

  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.equal(toolCall?.name, "read");
  assert.deepEqual(toolCall?.arguments, { path: "README.md" });
});

void test("maps default-namespaced custom calls to bare Pi tool names", async () => {
  for (const namespace of ["", "functions"]) {
    const message = output();
    await processCodexStream(
      events([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "custom_tool_call",
            id: "ctc_patch",
            call_id: "call_patch",
            namespace,
            name: "apply_patch",
            input: "",
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "custom_tool_call",
            id: "ctc_patch",
            call_id: "call_patch",
            namespace,
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_patch",
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]),
      message,
      createAssistantMessageEventStream(),
      model,
      new Map([["apply_patch", "patch"]]),
    );

    const toolCall = message.content.find((block) => block.type === "toolCall");
    assert.equal(toolCall?.name, "apply_patch");
    assert.deepEqual(toolCall?.arguments, { patch: "*** Begin Patch\n*** End Patch" });
  }
});

void test("matches Pi AI phase, reasoning, and final tool-delta events", async () => {
  const message = output();
  const pushed: Array<{ type: string; delta?: string; stopReason?: string }> = [];
  const stream: Pick<AssistantMessageEventStream, "push"> = {
    push(event) {
      const pushedEvent: (typeof pushed)[number] = { type: event.type };
      if ("delta" in event && event.delta !== undefined) pushedEvent.delta = event.delta;
      if ("partial" in event) pushedEvent.stopReason = event.partial.stopReason;
      pushed.push(pushedEvent);
    },
  };

  await processCodexStream(
    events([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_final",
          role: "assistant",
          phase: "final_answer",
          content: [],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_final",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "reasoning",
          id: "rs_parts",
          summary: [],
          content: [
            { type: "reasoning_text", text: "First" },
            { type: "reasoning_text", text: "Second" },
          ],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_tool",
          call_id: "call_tool",
          name: "tool",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '{"value":1}',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 2,
        arguments: '{"value":1}',
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_tool",
          call_id: "call_tool",
          name: "tool",
          arguments: '{"value":1}',
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_details",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]),
    message,
    stream,
    model,
    new Map(),
  );

  assert.equal(pushed.find((event) => event.type === "text_start")?.stopReason, "stop");
  assert.equal(
    message.content.find((block) => block.type === "thinking")?.thinking,
    "First\n\nSecond",
  );
  assert.deepEqual(
    pushed.filter((event) => event.type === "toolcall_delta").map((event) => event.delta),
    ['{"value":1}'],
  );
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
    const response: JsonRecord = {
      id: "resp_incomplete",
      status: "incomplete",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    if (scenario.reason) {
      response["incomplete_details"] = { reason: scenario.reason };
    }
    await processCodexStream(
      events([
        {
          type: "response.incomplete",
          response,
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

void test("preserves response.failed details as a terminal provider error", async () => {
  const message = output();
  await processCodexStream(
    events([
      {
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "retry this response" },
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    ]),
    message,
    createAssistantMessageEventStream(),
    model,
    new Map(),
  );

  assert.equal(message.responseId, "resp_failed");
  assert.equal(message.stopReason, "error");
  assert.equal(message.rawStopReason, "failed");
  assert.equal(message.errorMessage, "retry this response");
  assert.equal(message.usage.input, 10);
  assert.equal(message.usage.output, 2);
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

void test("matches Pi AI's missing terminal response error", async () => {
  await assert.rejects(
    processCodexStream(events([]), output(), createAssistantMessageEventStream(), model, new Map()),
    /OpenAI Responses stream ended before a terminal response event/,
  );
});
