import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  assert,
  test,
  DEFAULT_CONFIG,
  codexModel,
  userEntry,
  textEvents,
  responseDecisions,
  REPORT_TOOL,
  accessToken,
  createHarness,
  appendToolExchange,
  type Context,
  type JsonRecord,
} from "./codex-provider-harness.ts";

void test("preserves retryable post-tool handling without session affinity or agent hooks", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-done-call-retry", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    if (requests.length === 2) {
      yield* textEvents("recovered", "resp_done_call_recovered");
      return;
    }
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_failed_done",
        call_id: "call_failed_done",
        name: "report",
        arguments: '{"value":"execute me"}',
      },
    };
    yield {
      type: "response.failed",
      response: {
        id: "resp_failed_done_call",
        status: "failed",
        error: { code: "rate_limit_exceeded", message: "retry after tools" },
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
  };
  const initialContext: Context = {
    messages: [user.message],
    tools: [REPORT_TOOL],
  };
  const options = {
    apiKey: accessToken(),
    transport: "sse" as const,
  };

  const callMessage = await harness.runtime
    .streamSimple(codexModel(), initialContext, options)
    .result();
  const toolResult = appendToolExchange(harness, callMessage);
  const finalMessage = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [...initialContext.messages, callMessage, toolResult],
        tools: [REPORT_TOOL],
      },
      options,
    )
    .result();

  assert.equal(callMessage.stopReason, "toolUse");
  assert.equal(responseDecisions(callMessage)[0]?.["postToolDisposition"], "retry");
  assert.equal(finalMessage.stopReason, "stop");
  assert.equal(requests.length, 2);
  const retryInput = requireJsonRecords(requests[1]?.input);
  assert.equal(retryInput.filter((item) => item.type === "function_call").length, 1);
  assert.equal(retryInput.filter((item) => item.type === "function_call_output").length, 1);
  assert.match(JSON.stringify(retryInput), /call_failed_done|completed/);
});

void test("preserves response retry budgets across linked tool execution", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-done-call-budget", {
    maxRetries: 0,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_budget",
        call_id: "call_budget",
        name: "report",
        arguments: '{"value":"execute once"}',
      },
    };
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_budget",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
    };
  };
  const initialContext: Context = {
    messages: [user.message],
    tools: [REPORT_TOOL],
  };
  const options = {
    apiKey: accessToken(),
    transport: "sse" as const,
  };

  const callMessage = await harness.runtime
    .streamSimple(codexModel(), initialContext, options)
    .result();
  const toolResult = appendToolExchange(harness, callMessage);
  const errorMessage = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [...initialContext.messages, callMessage, toolResult],
        tools: [REPORT_TOOL],
      },
      options,
    )
    .result();

  assert.equal(callMessage.stopReason, "toolUse");
  assert.equal(errorMessage.stopReason, "error");
  assert.equal(errorMessage.errorMessage, "Response incomplete: max_output_tokens");
  assert.equal(requests, 1);
});

void test("does not retry an unsuccessful response before linked tool output exists", async () => {
  const user = userEntry("user-1", "inspect");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-missing-linked-output", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_waiting",
        call_id: "call_waiting",
        name: "report",
        arguments: '{"value":"waiting"}',
      },
    };
    yield {
      type: "response.incomplete",
      response: {
        id: "resp_waiting",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
    };
  };
  const initialContext: Context = {
    messages: [user.message],
    tools: [REPORT_TOOL],
  };
  const options = {
    apiKey: accessToken(),
    transport: "sse" as const,
  };

  const callMessage = await harness.runtime
    .streamSimple(codexModel(), initialContext, options)
    .result();
  const errorMessage = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [...initialContext.messages, callMessage],
        tools: [REPORT_TOOL],
      },
      options,
    )
    .result();

  assert.equal(callMessage.stopReason, "toolUse");
  assert.equal(errorMessage.stopReason, "error");
  assert.match(errorMessage.errorMessage ?? "", /until Pi records tool output.*call_waiting/);
  assert.equal(requests, 1);
});

void test("clears abandoned post-tool handling at lifecycle boundaries", async (t) => {
  for (const cleanup of ["agent-end", "session-clear"] as const) {
    await t.test(cleanup, async () => {
      const sessionId = `session-abandoned-${cleanup}`;
      const user = userEntry("user-1", "inspect");
      const harness = createHarness([user], DEFAULT_CONFIG, sessionId, {
        maxRetries: 0,
        baseDelayMs: 0,
      });
      let requests = 0;
      harness.runtime.transport.request = async function* () {
        requests += 1;
        if (requests === 2) {
          yield* textEvents("new turn", "resp_new_turn");
          return;
        }
        yield {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: `fc_abandoned_${cleanup}`,
            call_id: `call_abandoned_${cleanup}`,
            name: "report",
            arguments: '{"value":"old turn"}',
          },
        };
        yield {
          type: "response.incomplete",
          response: {
            id: `resp_abandoned_${cleanup}`,
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          },
        };
      };
      const initialContext: Context = {
        messages: [user.message],
        tools: [REPORT_TOOL],
      };
      const options = {
        apiKey: accessToken(),
        sessionId,
        transport: "sse" as const,
      };

      if (cleanup === "agent-end") {
        harness.runtime.beginAgentTurn(harness.extensionContext);
      }
      const callMessage = await harness.runtime
        .streamSimple(codexModel(), initialContext, options)
        .result();
      if (cleanup === "agent-end") {
        harness.runtime.endAgentTurn(harness.extensionContext);
      } else {
        harness.runtime.clearSession(sessionId);
      }
      const toolResult = appendToolExchange(harness, callMessage);
      const nextMessage = await harness.runtime
        .streamSimple(
          codexModel(),
          {
            messages: [...initialContext.messages, callMessage, toolResult],
            tools: [REPORT_TOOL],
          },
          options,
        )
        .result();

      assert.equal(callMessage.stopReason, "toolUse");
      assert.equal(nextMessage.stopReason, "stop");
      assert.equal(requests, 2);
    });
  }
});

void test("preserves fatal post-tool handling without session affinity or agent hooks", async () => {
  const user = userEntry("user-1", "invalid request");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-done-call-fatal", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_fatal_done",
        call_id: "call_fatal_done",
        name: "report",
        arguments: '{"value":"execute before error"}',
      },
    };
    yield {
      type: "response.failed",
      response: {
        id: "resp_fatal_done_call",
        status: "failed",
        error: { code: "invalid_prompt", message: "Invalid after tool completion." },
        output: [],
      },
    };
  };
  const initialContext: Context = {
    messages: [user.message],
    tools: [REPORT_TOOL],
  };
  const options = {
    apiKey: accessToken(),
    transport: "sse" as const,
  };

  const callMessage = await harness.runtime
    .streamSimple(codexModel(), initialContext, options)
    .result();
  const toolResult = appendToolExchange(harness, callMessage);
  const errorMessage = await harness.runtime
    .streamSimple(
      codexModel(),
      {
        messages: [...initialContext.messages, callMessage, toolResult],
        tools: [REPORT_TOOL],
      },
      options,
    )
    .result();

  assert.equal(callMessage.stopReason, "toolUse");
  assert.equal(responseDecisions(callMessage)[0]?.["postToolDisposition"], "error");
  assert.equal(errorMessage.stopReason, "error");
  assert.equal(errorMessage.errorMessage, "Invalid after tool completion.");
  assert.equal(requests, 1);
});

void test("ignores terminal-only calls in non-retryable failed responses", async () => {
  const user = userEntry("user-1", "invalid request");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-failed-call-fatal", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.failed",
      response: {
        id: "resp_failed_call_fatal",
        status: "failed",
        error: { code: "invalid_prompt", message: "Invalid request." },
        output: [
          {
            type: "function_call",
            id: "fc_fatal",
            call_id: "call_fatal",
            name: "report",
            status: "completed",
            arguments: '{"value":"fatal"}',
          },
        ],
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
        sessionId: "session-failed-call-fatal",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid request.");
  assert.equal(
    message.content.some((block) => block.type === "toolCall"),
    false,
  );
  assert.equal(responseDecisions(message)[0]?.["decision"], "return_terminal");
});

void test("does not resample official fatal response.failed codes", async () => {
  const user = userEntry("user-1", "invalid request");
  const harness = createHarness([user], DEFAULT_CONFIG, "session-fatal-response", {
    maxRetries: 1,
    baseDelayMs: 0,
  });
  let requests = 0;
  harness.runtime.transport.request = async function* () {
    requests += 1;
    yield {
      type: "response.failed",
      response: {
        id: "resp_fatal",
        status: "failed",
        error: { code: "invalid_prompt", message: "Invalid request." },
      },
    };
  };

  const message = await harness.runtime
    .streamSimple(
      codexModel(),
      { messages: [user.message] },
      {
        apiKey: accessToken(),
        sessionId: "session-fatal-response",
        transport: "sse",
      },
    )
    .result();

  assert.equal(requests, 1);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid request.");
});
