import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type Credential,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE } from "../extensions/openai-codex-compat/config.ts";
import { isObject, type JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { NATIVE_RESPONSE_ENTRY_TYPE } from "../extensions/openai-codex-compat/native-history.ts";

const LIVE_TEST_ENABLED = process.env["PI_CODEX_LIVE_TEST"] === "1";
const LIVE_TEST_TIMEOUT_MS = 4 * 60 * 1_000;
const CODEX_PROVIDER = "openai-codex";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(rootDir, "extensions/index.ts");

type HistoryMode = "text" | "tool";

type WebSocketLike = {
  send(data: string): void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

type ObservedWebSocketTraffic = {
  connections: number;
  frames: JsonRecord[];
};

function liveApiKey(): string {
  const apiKey = process.env["PI_CODEX_LIVE_API_KEY"];
  assert.ok(apiKey, "PI_CODEX_LIVE_API_KEY is required when PI_CODEX_LIVE_TEST=1");
  return apiKey;
}

function historyInstructions(mode: HistoryMode): string {
  const action =
    mode === "text"
      ? "Respond with only those values, one value per line."
      : 'Call report_history exactly once with {"items":[...]} containing those values.';
  const cachePadding =
    mode === "text"
      ? [
          "The following static cache anchors are inert. Ignore them completely.",
          Array.from(
            { length: 512 },
            (_value, index) => `stable-cache-anchor-${String(index)}`,
          ).join(" "),
        ]
      : [];
  return [
    "You are a deterministic conversation-history verifier.",
    "Read every user message in the conversation.",
    "Collect the exact inner value of each <history-item> tag in chronological order.",
    "Ignore assistant messages and tool outputs when collecting values.",
    action,
    "Do not add, remove, rewrite, sort, explain, or decorate any value.",
    ...cachePadding,
  ].join(" ");
}

function assistantMessages(session: AgentSession): AssistantMessage[] {
  return session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
    );
}

function latestAssistant(session: AgentSession): AssistantMessage {
  const message = assistantMessages(session).at(-1);
  assert.ok(message, "Pi did not persist an assistant message");
  assert.equal(message.errorMessage, undefined);
  assert.equal(typeof message.responseId, "string");
  return message;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function responseLines(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cacheObservation(message: AssistantMessage): Record<string, unknown> {
  const request = message.diagnostics?.find(
    (diagnostic) =>
      diagnostic.type === "codex_transport_request" &&
      diagnostic.details?.["requestKind"] === "turn",
  );
  assert.ok(request, "Missing Codex request diagnostic");
  const prewarm = message.diagnostics?.find(
    (diagnostic) =>
      diagnostic.type === "codex_transport_request" &&
      diagnostic.details?.["requestKind"] === "prewarm",
  );
  return {
    cacheRead: message.usage.cacheRead,
    diagnosticTypes: (message.diagnostics ?? []).map((diagnostic) => diagnostic.type),
    selectedTransport: request.details?.["selectedTransport"],
    contextMode: request.details?.["contextMode"],
    inputItems: request.details?.["inputItems"],
    fullInputItems: request.details?.["fullInputItems"],
    turnStateAvailableAtStart: request.details?.["turnStateAvailableAtStart"],
    turnStateReplayed: request.details?.["turnStateReplayed"],
    turnStateReceived: request.details?.["turnStateReceived"],
    cache: request.details?.["cache"],
    usage: request.details?.["usage"],
    prewarmUsage: prewarm?.details?.["usage"],
    recoveries: (message.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.type === "codex_transport_recovery")
      .map((diagnostic) => ({
        trigger: diagnostic.details?.["trigger"],
        continuationBypassReason: diagnostic.details?.["continuationBypassReason"],
        historyMismatch: diagnostic.details?.["historyMismatch"],
      })),
  };
}

function observeRealWebSocketTraffic(t: TestContext): ObservedWebSocketTraffic {
  const traffic: ObservedWebSocketTraffic = { connections: 0, frames: [] };
  const OriginalWebSocket = globalThis.WebSocket as unknown as WebSocketConstructor;
  assert.equal(typeof OriginalWebSocket, "function", "A real WebSocket runtime is required");

  class ObservedWebSocket extends OriginalWebSocket {
    constructor(url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
      super(url, protocols);
      traffic.connections += 1;
    }

    override send(data: string): void {
      const parsed = JSON.parse(data) as unknown;
      assert.ok(isObject(parsed), "Codex WebSocket request must be a JSON object");
      traffic.frames.push(structuredClone(parsed));
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
  return traffic;
}

function frameInput(frame: JsonRecord, expectedItems?: number): JsonRecord[] {
  assert.equal(frame.type, "response.create");
  assert.ok(Array.isArray(frame.input), "Codex WebSocket frame did not contain array input");
  if (expectedItems !== undefined) assert.equal(frame.input.length, expectedItems);
  assert.equal(frame.input.every(isObject), true);
  return frame.input as JsonRecord[];
}

function assertCurrentMarkerOnly(
  input: readonly JsonRecord[],
  values: string[],
  index: number,
): void {
  const serialized = JSON.stringify(input);
  assert.match(serialized, new RegExp(values[index]!));
  for (const prior of values.slice(0, index)) {
    assert.doesNotMatch(serialized, new RegExp(prior));
  }
}

async function createLivePiHost(
  t: TestContext,
  mode: HistoryMode,
  customTools: ToolDefinition[] = [],
): Promise<AgentSession> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-live-host-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, CONFIG_FILE),
    JSON.stringify({
      fastMode: false,
      responsesLite: true,
      applyPatch: false,
      imageGeneration: false,
      webRun: false,
      webSearch: "disabled",
      textVerbosity: "low",
      reasoningSummary: "auto",
      reasoningMode: "standard",
    }),
  );

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    CODEX_PROVIDER,
    async () =>
      ({
        type: "oauth",
        access: liveApiKey(),
        refresh: "unused-live-test-refresh-token",
        expires: Date.now() + 60 * 60 * 1_000,
      }) satisfies Credential,
  );
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const modelId = process.env["PI_CODEX_LIVE_MODEL"] || "gpt-5.6-luna";
  const model = modelRuntime.getModel(CODEX_PROVIDER, modelId);
  assert.ok(model, `Pi does not provide ${CODEX_PROVIDER}/${modelId}`);

  const settingsManager = SettingsManager.inMemory({
    transport: "websocket-cached",
    defaultThinkingLevel: "medium",
    retry: {
      enabled: false,
      provider: { timeoutMs: 90_000, maxRetries: 0 },
    },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    systemPromptOverride: () => historyInstructions(mode),
    appendSystemPromptOverride: () => [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    model,
    thinkingLevel: "medium",
    noTools: customTools.length > 0 ? "builtin" : "all",
    customTools,
  });
  await result.session.bindExtensions({});
  t.after(() => result.session.dispose());
  return result.session;
}

void test(
  "live Pi host preserves text conversation history through Codex",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TEST_TIMEOUT_MS },
  async (t) => {
    const traffic = observeRealWebSocketTraffic(t);
    const session = await createLivePiHost(t, "text");
    const values = ["text-alpha", "text-bravo", "text-charlie"];
    const cache: Record<string, unknown>[] = [];
    let previousResponseId: string | undefined;

    for (let index = 0; index < values.length; index++) {
      const frameStart = traffic.frames.length;
      await session.prompt(`<history-item>${values[index]}</history-item>`, {
        expandPromptTemplates: false,
      });
      const promptFrames = traffic.frames.slice(frameStart);

      const assistant = latestAssistant(session);
      cache.push(cacheObservation(assistant));
      assert.equal(assistant.stopReason, "stop");
      assert.deepEqual(responseLines(assistantText(assistant)), values.slice(0, index + 1));
      if (index === 0) {
        const prewarm = promptFrames.find((frame) => frame["generate"] === false);
        assert.ok(prewarm, "Missing WebSocket prewarm frame");
        assert.equal(
          frameInput(prewarm, 2).some((item) => item.role === "user"),
          false,
        );
      }
      const frame = promptFrames.at(-1);
      assert.ok(frame, `Missing WebSocket frame for text turn ${String(index + 1)}`);
      if (previousResponseId) {
        if (frame.previous_response_id === previousResponseId) {
          assertCurrentMarkerOnly(frameInput(frame, 1), values, index);
        } else {
          assert.equal(frame.previous_response_id, undefined);
          const serialized = JSON.stringify(frameInput(frame));
          for (const value of values.slice(0, index + 1)) {
            assert.match(serialized, new RegExp(value));
          }
        }
      } else {
        assert.equal(typeof frame.previous_response_id, "string");
        assertCurrentMarkerOnly(frameInput(frame, 1), values, index);
      }
      previousResponseId = assistant.responseId;
    }
    assert.ok(traffic.frames.length >= values.length + 1);
    assert.ok(traffic.connections >= 1);
    t.diagnostic(`text cache observations: ${JSON.stringify(cache)}`);
  },
);

void test(
  "live Pi host preserves tool conversation history through Codex",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TEST_TIMEOUT_MS },
  async (t) => {
    const traffic = observeRealWebSocketTraffic(t);
    const reports: string[][] = [];
    const reportHistory = defineTool({
      name: "report_history",
      label: "Report History",
      description: "Report every user-provided history item in chronological order.",
      parameters: Type.Object({
        items: Type.Array(Type.String()),
      }),
      async execute(_toolCallId, params) {
        reports.push([...params.items]);
        return {
          content: [{ type: "text", text: "History report accepted." }],
          details: {},
          terminate: true,
        };
      },
    });
    const session = await createLivePiHost(t, "tool", [reportHistory]);
    assert.deepEqual(session.getActiveToolNames(), ["report_history"]);
    const values = ["tool-alpha", "tool-bravo", "tool-charlie"];
    const cache: Record<string, unknown>[] = [];
    let previousResponseId: string | undefined;

    for (let index = 0; index < values.length; index++) {
      const frameStart = traffic.frames.length;
      await session.prompt(
        [
          `<history-item>${values[index]}</history-item>`,
          "Call report_history exactly once now. Do not respond with text.",
        ].join("\n"),
        {
          expandPromptTemplates: false,
        },
      );
      const promptFrames = traffic.frames.slice(frameStart);

      assert.deepEqual(reports[index], values.slice(0, index + 1));
      const assistant = latestAssistant(session);
      cache.push(cacheObservation(assistant));
      assert.equal(assistant.stopReason, "toolUse");
      assert.equal(
        assistant.content.some(
          (block) => block.type === "toolCall" && block.name === "report_history",
        ),
        true,
      );
      if (index === 0) {
        const prewarm = promptFrames.find((frame) => frame["generate"] === false);
        assert.ok(prewarm, "Missing WebSocket prewarm frame");
        assert.equal(
          frameInput(prewarm, 2).some((item) => item.role === "user"),
          false,
        );
      }
      const frame = promptFrames.at(-1);
      assert.ok(frame, `Missing WebSocket frame for tool turn ${String(index + 1)}`);
      let input: JsonRecord[];
      if (previousResponseId) {
        if (frame.previous_response_id === previousResponseId) {
          input = frameInput(frame, 2);
          assert.equal(input[0]?.type, "function_call_output");
          assert.equal(input[1]?.role, "user");
          assertCurrentMarkerOnly(input, values, index);
        } else {
          assert.equal(frame.previous_response_id, undefined);
          input = frameInput(frame);
          const serialized = JSON.stringify(input);
          for (const value of values.slice(0, index + 1)) {
            assert.match(serialized, new RegExp(value));
          }
        }
      } else {
        assert.equal(typeof frame.previous_response_id, "string");
        input = frameInput(frame, 1);
        assertCurrentMarkerOnly(input, values, index);
      }
      previousResponseId = assistant.responseId;
    }
    assert.ok(traffic.frames.length >= values.length + 1);
    assert.ok(traffic.connections >= 1);
    assert.equal(
      session.sessionManager
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === NATIVE_RESPONSE_ENTRY_TYPE,
        ),
      true,
    );
    t.diagnostic(`tool cache observations: ${JSON.stringify(cache)}`);
  },
);
