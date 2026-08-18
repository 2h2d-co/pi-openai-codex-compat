import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  DEFAULT_CONFIG,
  isObject,
  codexModel,
  userEntry,
  textEvents,
  responseDecisions,
  REPORT_TOOL,
  SAMPLE_GRAMMAR_TOOL,
  accessToken,
  createHarness,
  type JsonRecord,
} from "./codex-provider-harness.ts";
import { responseRetryDelayMs } from "../../extensions/openai-codex-compat/codex-provider/codex-provider-response-attempts.ts";

test("calculates exponential response retry delays without waiting", (t) => {
  t.mock.method(Math, "random", () => 0.5);

  assert.equal(responseRetryDelayMs(0, 1), 0);
  assert.equal(responseRetryDelayMs(200, 1), 200);
  assert.equal(responseRetryDelayMs(200, 2), 400);
  assert.equal(responseRetryDelayMs(200, 5), 3_200);
});

test("continues response.completed end_turn false without synthetic input", async () => {
  const user = userEntry("user-1", "finish the task");
  const harness = createHarness([user]);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    const responseNumber = requests.length;
    const responseEvents = textEvents(
      responseNumber === 1 ? "first phase" : "second phase",
      `resp_${String(responseNumber)}`,
    );
    if (responseNumber === 1) {
      const terminal = responseEvents.at(-1);
      assert.ok(terminal && isObject(terminal.response));
      terminal.response["end_turn"] = false;
    }
    yield* responseEvents;
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 2);
  assert.equal(message.responseId, "resp_2");
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(
    message.content.filter((block) => block.type === "text").map((block) => block.text),
    ["first phase", "second phase"],
  );
  assert.equal(message.usage.input, 20);
  assert.equal(message.usage.output, 10);
  assert.equal(message.usage.cacheRead, 0);
  assert.equal(message.usage.cacheWrite, 0);
  assert.equal(message.usage.reasoning, 0);
  assert.equal(message.usage.totalTokens, 30);
  assert.ok(Math.abs(message.usage.cost.input - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.output - 0.00002) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.total - 0.00004) < 1e-12);
  const firstRequest = requests[0];
  const secondRequest = requests[1];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  const firstInput = requireJsonRecords(firstRequest.input);
  const secondInput = requireJsonRecords(secondRequest.input);
  assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput);
  assert.equal(secondInput.at(-1)?.type, "message");
  assert.equal(secondInput.at(-1)?.role, "assistant");
  assert.match(JSON.stringify(secondInput.at(-1)), /first phase/);
  assert.equal(
    requireJsonRecord(firstRequest["client_metadata"])["turn_id"],
    requireJsonRecord(secondRequest["client_metadata"])["turn_id"],
  );
  assert.equal(harness.customEntries.length, 1);
  assert.match(JSON.stringify(harness.customEntries[0]?.data), /first phase.*second phase/);
});

test("returns a Pi compaction boundary when end_turn false crosses the threshold", async () => {
  const user = userEntry("user-1", "finish the task");
  const harness = createHarness([user], {
    ...DEFAULT_CONFIG,
    autoCompactAtPercent: 90,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    const responseEvents = textEvents("first phase", "resp_boundary");
    const terminal = responseEvents.at(-1);
    assert.ok(terminal && isObject(terminal.response));
    terminal.response["end_turn"] = false;
    terminal.response["usage"] = {
      input_tokens: 94_995,
      output_tokens: 5,
      total_tokens: 95_000,
    };
    yield* responseEvents;
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-1",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 1);
  assert.equal(message.stopReason, "length", message.errorMessage);
  assert.equal(message.rawStopReason, "completed.end_turn_false.context_limit");
  assert.deepEqual(
    message.content.filter((block) => block.type === "text").map((block) => block.text),
    ["first phase"],
  );
  assert.match(JSON.stringify(responseDecisions(message)), /return_compaction_boundary/);
  assert.equal(harness.compactions.length, 0);
});

test("resamples retryable failed and incomplete responses from completed output history", async () => {
  for (const firstTerminal of ["response.failed", "response.incomplete"] as const) {
    const user = userEntry("user-1", `test ${firstTerminal}`);
    const harness = createHarness([user], DEFAULT_CONFIG, `session-${firstTerminal}`, {
      maxRetries: 1,
      baseDelayMs: 0,
    });
    const requests: JsonRecord[] = [];
    harness.runtime.transport.request = async function* (_model, body) {
      requests.push(structuredClone(requireJsonRecord(body)));
      if (requests.length === 2) {
        yield* textEvents("after retry", "resp_recovered");
        return;
      }

      const firstEvents = textEvents("before retry", "resp_retryable");
      firstEvents[firstEvents.length - 1] =
        firstTerminal === "response.failed"
          ? {
              type: "response.failed",
              response: {
                id: "resp_retryable",
                status: "failed",
                error: { code: "rate_limit_exceeded", message: "retry this response" },
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            }
          : {
              type: "response.incomplete",
              response: {
                id: "resp_retryable",
                status: "incomplete",
                incomplete_details: { reason: "content_filter" },
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            };
      yield* firstEvents;
    };

    const message = await harness.runtime
      .streamSimple(
        codexModel(),
        { messages: [user.message] },
        {
          apiKey: accessToken(),
          sessionId: `session-${firstTerminal}`,
          transport: "sse",
        },
      )
      .result();

    assert.equal(requests.length, 2);
    assert.equal(message.stopReason, "stop");
    assert.equal(message.responseId, "resp_recovered");
    assert.deepEqual(
      message.content.filter((block) => block.type === "text").map((block) => block.text),
      ["before retry", "after retry"],
    );
    assert.equal(message.usage.input, 14);
    assert.equal(message.usage.output, 7);
    const firstInput = requireJsonRecords(requests[0]?.input);
    const secondInput = requireJsonRecords(requests[1]?.input);
    assert.deepEqual(secondInput.slice(0, firstInput.length), firstInput);
    assert.match(JSON.stringify(secondInput.slice(firstInput.length)), /before retry/);
    assert.equal(harness.customEntries.length, 1);
    assert.match(JSON.stringify(harness.customEntries[0]?.data), /before retry.*after retry/);
  }
});

test("uses done calls and ignores conflicting terminal output", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-empty-completed-output", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  const call = {
    type: "function_call",
    id: "fc_streamed",
    call_id: "call_streamed",
    name: "report",
    status: "completed",
    arguments: '{"value":"streamed"}',
  };
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield { type: "response.output_item.done", output_index: 0, item: call };
    yield {
      type: "response.completed",
      response: {
        id: "resp_empty_completed_output",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_terminal",
            call_id: "call_terminal",
            name: "report",
            status: "completed",
            arguments: '{"value":"terminal"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-empty-completed-output",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "toolUse");
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall?.arguments, { value: "streamed" });
  assert.deepEqual(responseDecisions(message), [
    {
      attempt: 1,
      terminalType: "response.completed",
      outputItemTypes: { function_call: 1 },
      streamedCallsStarted: 1,
      streamedCallsDone: 1,
      returnedCalls: 1,
      discardedPartialCalls: 0,
      postToolDisposition: "continue",
      decision: "return_tool_use",
    },
  ]);
});

test("returns complete function call batches at the output limit without provider continuation", async () => {
  const user = userEntry("user-1", "inspect both");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-function-limit", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  const calls = [
    {
      type: "function_call",
      id: "fc_one",
      call_id: "call_one",
      name: "report",
      status: "completed",
      arguments: '{"value":"one"}',
    },
    {
      type: "function_call",
      id: "fc_two",
      call_id: "call_two",
      name: "report",
      status: "completed",
      arguments: '{"value":"two"}',
    },
  ];
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    for (const [outputIndex, item] of calls.entries()) {
      yield { type: "response.output_item.done", output_index: outputIndex, item };
    }
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_function_limit",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: calls,
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-function-limit",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 1);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.filter((block) => block.type === "toolCall").map((block) => block.arguments),
    [{ value: "one" }, { value: "two" }],
  );
  assert.deepEqual(responseDecisions(message), [
    {
      attempt: 1,
      terminalType: "response.incomplete",
      incompleteReason: "max_output_tokens",
      outputItemTypes: { function_call: 2 },
      streamedCallsStarted: 2,
      streamedCallsDone: 2,
      returnedCalls: 2,
      discardedPartialCalls: 0,
      postToolDisposition: "retry",
      decision: "return_tool_use",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(responseDecisions(message)), /call_one|call_two|report/);
});

test("ignores terminal-only calls while retrying the original input", async () => {
  const user = userEntry("user-1", "apply the custom operation");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-terminal-custom", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    if (requests.length === 2) {
      yield* textEvents("recovered", "resp_terminal_custom_recovered");
      return;
    }
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_terminal_custom",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "custom_tool_call",
            id: "ctc_custom",
            call_id: "call_custom",
            name: "sample_tool",
            status: "completed",
            input: "complete input",
          },
        ],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [SAMPLE_GRAMMAR_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-terminal-custom",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.input, requests[0]?.input);
  assert.equal(message.stopReason, "stop");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.deepEqual(
    responseDecisions(message).map((decision) => decision["decision"]),
    ["retry_original_input", "return_terminal"],
  );
  assert.doesNotMatch(JSON.stringify(requests), /call_custom|complete input/);
});

test("returns the completed subset of a mixed done and partial call batch", async () => {
  const user = userEntry("user-1", "inspect both");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-partial-batch", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    const completeCall = {
      type: "function_call",
      id: "fc_complete",
      call_id: "call_complete",
      name: "report",
      status: "incomplete",
      arguments: '{"value":"complete"}',
    };
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...completeCall, arguments: "" },
    };
    yield { type: "response.output_item.done", output_index: 0, item: completeCall };
    yield {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_partial",
        call_id: "call_partial",
        name: "report",
        status: "in_progress",
        arguments: '{"value":',
      },
    };
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_partial_batch",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          completeCall,
          {
            type: "function_call",
            id: "fc_terminal_only",
            call_id: "call_terminal_only",
            name: "report",
            status: "completed",
            arguments: '{"value":"terminal"}',
          },
        ],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-partial-batch",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.filter((block) => block.type === "toolCall"),
    [
      {
        type: "toolCall",
        id: "call_complete|fc_complete",
        name: "report",
        arguments: { value: "complete" },
      },
    ],
  );
  assert.equal(responseDecisions(message)[0]?.["streamedCallsDone"], 1);
  assert.equal(responseDecisions(message)[0]?.["returnedCalls"], 1);
  assert.equal(responseDecisions(message)[0]?.["discardedPartialCalls"], 1);
  assert.equal(responseDecisions(message)[0]?.["postToolDisposition"], "retry");
  assert.doesNotMatch(JSON.stringify(message), /call_partial|call_terminal_only/);
});

test("returns done calls omitted from incomplete terminal output", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-omitted-call", {
    maxRetries: 5,
    baseDelayMs: 0,
  });
  const call = {
    type: "function_call",
    id: "fc_omitted",
    call_id: "call_omitted",
    name: "report",
    status: "completed",
    arguments: '{"value":"omitted"}',
  };
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield { type: "response.output_item.added", output_index: 0, item: call };
    yield { type: "response.output_item.done", output_index: 0, item: call };
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_omitted_call",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: { input_tokens: 90_000, output_tokens: 10_000, total_tokens: 100_000 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-omitted-call",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "toolUse");
  const toolCall = message.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall?.arguments, { value: "omitted" });
  assert.equal(responseDecisions(message)[0]?.["decision"], "return_tool_use");
  assert.equal(responseDecisions(message)[0]?.["returnedCalls"], 1);
  assert.equal(responseDecisions(message)[0]?.["postToolDisposition"], "retry");
});

test("ignores terminal-only calls while retrying failed responses", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-failed-call-retry", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    if (requests.length > 1) {
      yield* textEvents("recovered", "resp_recovered_call");
      return;
    }
    yield {
      type: "response.failed",
      response: {
        id: "resp_failed_call",
        status: "failed",
        error: { code: "rate_limit_exceeded", message: "retry" },
        output: [
          {
            type: "function_call",
            id: "fc_failed",
            call_id: "call_failed",
            name: "report",
            status: "completed",
            arguments: '{"value":"failed"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
  };
  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [user.message],
        tools: [REPORT_TOOL],
      },
      {
        apiKey: accessToken(),
        sessionId: "session-failed-call-retry",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.input, requests[0]?.input);
  assert.doesNotMatch(JSON.stringify(requests[1]?.input), /function_call|call_failed/);
  assert.equal(message.stopReason, "stop");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.deepEqual(
    responseDecisions(message).map((decision) => decision["decision"]),
    ["retry_original_input", "return_terminal"],
  );
});
