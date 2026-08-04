import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { uuidv7, type Model } from "@earendil-works/pi-ai";
import {
  CodexTransport,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
} from "../extensions/openai-codex-compat/codex-transport.ts";
import { isObject, type JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

const LIVE_TEST_ENABLED = process.env["PI_CODEX_LIVE_TEST"] === "1";
const LIVE_TEST_TIMEOUT_MS = 4 * 60 * 1_000;

type WebSocketLike = {
  send(data: string): void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

type TurnResult = {
  responseId: string;
  items: JsonRecord[];
};

function liveModel(): Model<any> {
  const id = process.env["PI_CODEX_LIVE_MODEL"] || "gpt-5.6-sol";
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as Model<any>;
}

function liveApiKey(): string {
  const apiKey = process.env["PI_CODEX_LIVE_API_KEY"];
  assert.ok(apiKey, "PI_CODEX_LIVE_API_KEY is required when PI_CODEX_LIVE_TEST=1");
  return apiKey;
}

function userItem(value: string): JsonRecord {
  return {
    role: "user",
    content: [{ type: "input_text", text: `<history-item>${value}</history-item>` }],
  };
}

function historyInstructions(mode: "text" | "tool"): string {
  const action =
    mode === "text"
      ? "Respond with only those values, one value per line."
      : 'Call report_history exactly once with {"items":[...]} containing those values.';
  return [
    "You are a deterministic conversation-history verifier.",
    "Read every user message in the conversation.",
    "Collect the exact inner value of each <history-item> tag in chronological order.",
    "Ignore assistant messages and tool outputs when collecting values.",
    action,
    "Do not add, remove, rewrite, sort, explain, or decorate any value.",
  ].join(" ");
}

function requestBody(options: {
  modelId: string;
  instructions: string;
  input: readonly JsonRecord[];
  sessionId: string;
  tools?: readonly JsonRecord[];
}): JsonRecord {
  return {
    model: options.modelId,
    store: false,
    stream: true,
    instructions: options.instructions,
    input: options.input.map((item) => structuredClone(item)),
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options.sessionId,
    tool_choice: options.tools ? "required" : "none",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    ...(options.tools ? { tools: options.tools.map((tool) => structuredClone(tool)) } : {}),
  };
}

function observeRealWebSocketFrames(t: TestContext): JsonRecord[] {
  const frames: JsonRecord[] = [];
  const OriginalWebSocket = globalThis.WebSocket as unknown as WebSocketConstructor;
  assert.equal(typeof OriginalWebSocket, "function", "A real WebSocket runtime is required");

  class ObservedWebSocket extends OriginalWebSocket {
    override send(data: string): void {
      const parsed = JSON.parse(data) as unknown;
      assert.ok(isObject(parsed), "Codex WebSocket request must be a JSON object");
      frames.push(structuredClone(parsed));
      super.send(data);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: ObservedWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: OriginalWebSocket,
    });
  });
  return frames;
}

async function collectTurn(events: AsyncIterable<JsonRecord>): Promise<TurnResult> {
  const items: JsonRecord[] = [];
  let responseId: string | undefined;
  for await (const event of events) {
    if (event.type === "response.created" && isObject(event.response)) {
      if (typeof event.response.id === "string") responseId = event.response.id;
    }
    if (event.type === "response.output_item.done" && isObject(event.item)) {
      items.push(structuredClone(event.item));
    }
    if (
      (event.type === "response.completed" || event.type === "response.incomplete") &&
      isObject(event.response)
    ) {
      if (typeof event.response.id === "string") responseId = event.response.id;
      if (Array.isArray(event.response["output"])) {
        const terminalItems = event.response["output"].filter(isObject);
        if (terminalItems.length > 0) {
          items.splice(0, items.length, ...terminalItems.map((item) => structuredClone(item)));
        }
      }
    }
  }
  assert.ok(responseId, "Codex response did not contain a response id");
  return { responseId, items };
}

function messageText(items: readonly JsonRecord[]): string {
  const message = items.find((item) => item.type === "message");
  assert.ok(message && Array.isArray(message.content), "Codex did not return a message item");
  return message.content
    .filter(isObject)
    .map((part) =>
      typeof part.text === "string"
        ? part.text
        : typeof part["refusal"] === "string"
          ? part["refusal"]
          : "",
    )
    .join("");
}

function canonicalReplayItems(items: readonly JsonRecord[]): JsonRecord[] {
  return items.map((item) => {
    if (item.type !== "message") return structuredClone(item);
    assert.ok(Array.isArray(item.content), "Codex message item has no content");
    const text = item.content
      .filter(isObject)
      .map((part) =>
        typeof part.text === "string"
          ? part.text
          : typeof part["refusal"] === "string"
            ? part["refusal"]
            : "",
      )
      .join("");
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
      id: item.id,
      ...(item["phase"] === "commentary" || item["phase"] === "final_answer"
        ? { phase: item["phase"] }
        : {}),
    };
  });
}

function responseLines(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function reportHistoryTool(): JsonRecord {
  return {
    type: "function",
    name: "report_history",
    description: "Report every user-provided history item in chronological order.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    strict: false,
  };
}

function functionCall(items: readonly JsonRecord[]): JsonRecord {
  const call = items.find((item) => item.type === "function_call");
  assert.ok(call, "Codex did not return a function call");
  return call;
}

function reportedItems(call: JsonRecord): string[] {
  assert.equal(call.name, "report_history");
  if (typeof call.arguments !== "string") {
    throw new Error("Codex function call did not contain JSON arguments");
  }
  const parsed = JSON.parse(call.arguments) as unknown;
  assert.ok(isObject(parsed) && Array.isArray(parsed["items"]));
  assert.ok(parsed["items"].every((item) => typeof item === "string"));
  return parsed["items"] as string[];
}

function functionOutput(call: JsonRecord): JsonRecord {
  assert.equal(typeof call["call_id"], "string");
  return {
    type: "function_call_output",
    call_id: call["call_id"],
    output: "History report accepted.",
  };
}

void test(
  "live Codex continuation preserves canonical text conversation history",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TEST_TIMEOUT_MS },
  async (t) => {
    const model = liveModel();
    const apiKey = liveApiKey();
    const sessionId = uuidv7();
    const transport = new CodexTransport();
    const frames = observeRealWebSocketFrames(t);
    const diagnostics: CodexTransportDiagnostic[] = [];
    const values = ["canonical-alpha", "canonical-bravo", "canonical-charlie"];
    let fullInput: JsonRecord[] = [];
    let previousResponseId: string | undefined;
    let continuation: CodexContinuationHandle | undefined;
    t.after(() => transport.close(sessionId));

    for (let index = 0; index < values.length; index++) {
      const nextUser = userItem(values[index]!);
      const requestInput = [...fullInput, nextUser];
      const turn = await collectTurn(
        transport.request(
          model,
          requestBody({
            modelId: model.id,
            instructions: historyInstructions("text"),
            input: requestInput,
            sessionId,
          }),
          {
            apiKey,
            sessionId,
            transport: "websocket-cached",
            timeoutMs: 90_000,
            onContinuationReady(handle) {
              continuation = handle;
            },
            onTransportDiagnostic(diagnostic) {
              diagnostics.push(diagnostic);
            },
          },
        ),
      );

      assert.deepEqual(responseLines(messageText(turn.items)), values.slice(0, index + 1));
      assert.equal(continuation?.responseId, turn.responseId);
      const replayItems = canonicalReplayItems(turn.items);
      assert.equal(continuation?.replaceResponseItems(replayItems), true);

      const frame = frames[index];
      assert.ok(frame, `Missing WebSocket frame for canonical turn ${String(index + 1)}`);
      if (index === 0) {
        assert.equal(frame["previous_response_id"], undefined);
        assert.deepEqual(frame.input, requestInput);
      } else {
        assert.equal(frame["previous_response_id"], previousResponseId);
        assert.deepEqual(frame.input, [nextUser]);
      }

      fullInput = [...requestInput, ...replayItems];
      previousResponseId = turn.responseId;
    }

    assert.equal(frames.length, values.length);
    assert.equal(diagnostics.length, 0);
  },
);

void test(
  "live Codex continuation preserves native tool conversation history",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TEST_TIMEOUT_MS },
  async (t) => {
    const model = liveModel();
    const apiKey = liveApiKey();
    const sessionId = uuidv7();
    const transport = new CodexTransport();
    const frames = observeRealWebSocketFrames(t);
    const diagnostics: CodexTransportDiagnostic[] = [];
    const tools = [reportHistoryTool()];
    const values = ["native-alpha", "native-bravo", "native-charlie"];
    let fullInput: JsonRecord[] = [];
    let previousResponseId: string | undefined;
    let previousOutput: JsonRecord | undefined;
    let continuation: CodexContinuationHandle | undefined;
    t.after(() => transport.close(sessionId));

    for (let index = 0; index < values.length; index++) {
      const nextUser = userItem(values[index]!);
      const deltaInput = [...(previousOutput ? [previousOutput] : []), nextUser];
      const requestInput = [...fullInput, ...deltaInput];
      const turn = await collectTurn(
        transport.request(
          model,
          requestBody({
            modelId: model.id,
            instructions: historyInstructions("tool"),
            input: requestInput,
            sessionId,
            tools,
          }),
          {
            apiKey,
            sessionId,
            transport: "websocket-cached",
            timeoutMs: 90_000,
            onContinuationReady(handle) {
              continuation = handle;
            },
            onTransportDiagnostic(diagnostic) {
              diagnostics.push(diagnostic);
            },
          },
        ),
      );

      const call = functionCall(turn.items);
      assert.deepEqual(reportedItems(call), values.slice(0, index + 1));
      assert.equal(continuation?.responseId, turn.responseId);
      assert.equal(continuation?.replaceResponseItems(turn.items), true);

      const frame = frames[index];
      assert.ok(frame, `Missing WebSocket frame for native turn ${String(index + 1)}`);
      if (index === 0) {
        assert.equal(frame["previous_response_id"], undefined);
        assert.deepEqual(frame.input, requestInput);
      } else {
        assert.equal(frame["previous_response_id"], previousResponseId);
        assert.deepEqual(frame.input, deltaInput);
      }

      previousOutput = functionOutput(call);
      fullInput = [...requestInput, ...turn.items];
      previousResponseId = turn.responseId;
    }

    assert.equal(frames.length, values.length);
    assert.equal(diagnostics.length, 0);
  },
);
