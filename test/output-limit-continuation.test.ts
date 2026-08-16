import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Credential, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { CONFIG_FILE } from "../extensions/openai-codex-compat/config.ts";
import {
  OUTPUT_LIMIT_CONTINUATION_PROMPT,
  OUTPUT_LIMIT_CONTINUATION_TYPE,
} from "../extensions/openai-codex-compat/output-limit-continuation.ts";
import registerOutputLimitContinuation from "../extensions/openai-codex-compat/output-limit-continuation.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(rootDir, "extensions/index.ts");
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const MODEL_ID = "gpt-5.6-sol";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

type JsonRecord = Record<string, unknown>;

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function fakeCodexToken(): string {
  return [
    base64Json({ alg: "none", typ: "JWT" }),
    base64Json({ [ACCOUNT_ID_CLAIM]: { chatgpt_account_id: "acct_test" } }),
    "signature",
  ].join(".");
}

function codexCredential(): Credential {
  return {
    type: "oauth",
    access: fakeCodexToken(),
    refresh: "refresh_test",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
}

function codexModel(): Model<any> {
  return {
    id: MODEL_ID,
    api: CODEX_API,
    provider: CODEX_PROVIDER,
  } as Model<any>;
}

function assistant(
  stopReason: AssistantMessage["stopReason"],
  rawStopReason = stopReason === "length" ? "incomplete.max_output_tokens" : "completed",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: CODEX_API,
    provider: CODEX_PROVIDER,
    model: MODEL_ID,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    rawStopReason,
    timestamp: Date.now(),
    responseId: "response-output-limit",
  };
}

type TestEvent = {
  messages?: unknown[];
  signal?: AbortSignal;
};

type TestHandler = (event: TestEvent, ctx: ExtensionContext) => void | Promise<void>;

function continuationHarness(options?: {
  pending?: boolean;
  idle?: boolean;
  branch?: SessionEntry[];
}) {
  const handlers = new Map<string, TestHandler>();
  const sent: Array<{ message: JsonRecord; options: JsonRecord | undefined }> = [];
  const branch = options?.branch ?? [];
  const pi = {
    on(event: string, candidate: TestHandler) {
      handlers.set(event, candidate);
    },
    sendMessage(message: JsonRecord, options?: JsonRecord) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  registerOutputLimitContinuation(pi);
  const ctx = {
    model: codexModel(),
    isIdle: () => options?.idle ?? true,
    hasPendingMessages: () => options?.pending ?? false,
    sessionManager: {
      getSessionId: () => "session-output-limit",
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  return {
    sent,
    async emit(event: string, payload: TestEvent = {}, context = ctx) {
      const handler = handlers.get(event);
      assert.ok(handler);
      await handler(payload, context);
    },
  };
}

function outputLimitResponseIdHash(): string {
  return createHash("sha256").update("response-output-limit", "utf8").digest("hex");
}

void test("starts one hidden continuation after an exact Codex output-limit stop", async () => {
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

void test("requires the exact raw stop reason and respects existing work", async () => {
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
  } as unknown as ExtensionContext;
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

void test("deduplicates recovery and suppresses cancelled or failed compaction", async () => {
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

void test("continues after successful compaction completes", async () => {
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

function sse(events: JsonRecord[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function incompleteEvents(): JsonRecord[] {
  return [
    { type: "response.created", response: { id: "resp_incomplete" } },
    {
      type: "response.output_item.added",
      item: { id: "msg_partial", type: "message", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", delta: "partial progress" },
    {
      type: "response.output_item.done",
      item: {
        id: "msg_partial",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "partial progress", annotations: [] }],
      },
    },
    {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 260_000, output_tokens: 5, total_tokens: 260_005 },
      },
    },
  ];
}

function exhaustedOutputLimitEvents(attempt: number): JsonRecord[] {
  const responseId = `resp_exhausted_${String(attempt)}`;
  const itemId = `msg_exhausted_${String(attempt)}`;
  const text = `committed output ${String(attempt)}`;
  return [
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.added",
      item: { id: itemId, type: "message", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.incomplete",
      response: {
        id: responseId,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: {
          input_tokens: 260_000,
          output_tokens: 128_000,
          total_tokens: 388_000,
        },
      },
    },
  ];
}

function compactionEvents(): JsonRecord[] {
  return [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_compact",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ];
}

function contextOverflowEvents(): JsonRecord[] {
  return [
    { type: "response.created", response: { id: "resp_overflow" } },
    {
      type: "response.failed",
      response: {
        id: "resp_overflow",
        status: "failed",
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model.",
        },
        usage: { input_tokens: 260_005, output_tokens: 0, total_tokens: 260_005 },
      },
    },
  ];
}

function textEvents(text: string): JsonRecord[] {
  return [
    { type: "response.created", response: { id: "resp_continued" } },
    {
      type: "response.output_item.added",
      item: { id: "msg_text", type: "message", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_continued",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

function followUpEvents(text: string): JsonRecord[] {
  const events = textEvents(text);
  const terminal = events.at(-1);
  assert.ok(terminal && typeof terminal["response"] === "object" && terminal["response"] !== null);
  (terminal["response"] as JsonRecord)["end_turn"] = false;
  return events;
}

async function startCodexServer(
  t: TestContext,
  responseEvents?: (requestNumber: number, body: JsonRecord) => JsonRecord[],
): Promise<{ baseUrl: string; requests: JsonRecord[] }> {
  const requests: JsonRecord[] = [];
  let ordinaryRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuffer = Buffer.concat(chunks);
    const compressed = String(request.headers["content-encoding"] ?? "")
      .split(",")
      .some((value) => value.trim().toLowerCase() === "zstd");
    const rawBody = compressed
      ? zstdDecompressSync(bodyBuffer).toString("utf8")
      : bodyBuffer.toString("utf8");
    const body = JSON.parse(rawBody) as JsonRecord;
    requests.push(body);

    const input = Array.isArray(body["input"]) ? (body["input"] as JsonRecord[]) : [];
    const compacting = input.some((item) => item["type"] === "compaction_trigger");
    const events = responseEvents
      ? responseEvents(requests.length, body)
      : compacting
        ? compactionEvents()
        : ++ordinaryRequests === 1
          ? incompleteEvents()
          : textEvents("continued after resampling");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(events));
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(
    () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function pointBuiltInCodexAt(baseUrl: string, t: TestContext): Promise<void> {
  type GetCodexModels = () => Model<typeof CODEX_API>[];
  const modelSources: GetCodexModels[] = [() => getBuiltinModels(CODEX_PROVIDER)];
  const nestedPiAiPath = resolve(
    rootDir,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
  );

  try {
    const nestedPiAi = (await import(pathToFileURL(nestedPiAiPath).href)) as {
      getBuiltinModels?: (provider: typeof CODEX_PROVIDER) => Model<typeof CODEX_API>[];
    };
    if (nestedPiAi.getBuiltinModels) {
      modelSources.push(() => nestedPiAi.getBuiltinModels!(CODEX_PROVIDER));
    }
  } catch {
    // This dependency layout has no nested Pi AI copy.
  }

  const previous: Array<[Model<typeof CODEX_API>, string]> = [];
  for (const source of modelSources) {
    for (const model of source()) {
      previous.push([model, model.baseUrl]);
      model.baseUrl = baseUrl;
    }
  }
  t.after(() => {
    for (const [model, priorBaseUrl] of previous) model.baseUrl = priorBaseUrl;
  });
}

async function createTestSession(
  t: TestContext,
  baseUrl: string,
  options?: { tools?: boolean; autoCompactAtPercent?: number },
) {
  await pointBuiltInCodexAt(baseUrl, t);

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-output-limit-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ [CODEX_PROVIDER]: codexCredential() }),
  );
  if (options?.autoCompactAtPercent !== undefined) {
    await writeFile(
      join(agentDir, CONFIG_FILE),
      JSON.stringify({ autoCompactAtPercent: options.autoCompactAtPercent }),
    );
  }

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    defaultThinkingLevel: "low",
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 1,
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const model = modelRuntime.getModel(CODEX_PROVIDER, MODEL_ID);
  assert.ok(model);
  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    model,
    thinkingLevel: "low",
    ...(options?.tools ? {} : { noTools: "all" as const }),
  });
  t.after(() => result.session.dispose());
  await result.session.bindExtensions({});
  return { cwd, session: result.session };
}

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
