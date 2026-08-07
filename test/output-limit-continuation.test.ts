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

async function startCodexServer(
  t: TestContext,
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
    const events = compacting
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

void test("resamples a Codex output limit before returning control to Pi", async (t) => {
  const server = await startCodexServer(t);
  await pointBuiltInCodexAt(server.baseUrl, t);

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-output-limit-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ [CODEX_PROVIDER]: codexCredential() }),
  );

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
    noTools: "all",
  });
  t.after(() => result.session.dispose());
  await result.session.bindExtensions({});

  await result.session.prompt("finish this task", { expandPromptTemplates: false });
  await result.session.waitForIdle();

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

  const branch = result.session.sessionManager.getBranch();
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
  assert.equal(result.session.isIdle, true);
});
