import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Credential, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { CONFIG_FILE } from "../extensions/openai-codex-compat/config.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(rootDir, "extensions/index.ts");
const CODEX_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-sol";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

type SseEvent = Record<string, unknown>;

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};

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

function textResponseEvents(text: string): SseEvent[] {
  return [
    { type: "response.created", response: { id: "resp_text" } },
    {
      type: "response.output_item.added",
      item: { id: "msg_text", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_text",
        status: "completed",
        // Codex can echo default even when priority was explicitly requested.
        service_tier: "default",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function sse(events: SseEvent[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function startCodexServer(t: TestContext): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuffer = Buffer.concat(chunks);
    const contentEncoding = request.headers["content-encoding"];
    const compressed = (Array.isArray(contentEncoding) ? contentEncoding : [contentEncoding])
      .filter((value): value is string => value !== undefined)
      .flatMap((value) => value.split(","))
      .some((value) => value.trim().toLowerCase() === "zstd");
    const rawBody = compressed
      ? zstdDecompressSync(bodyBuffer).toString("utf8")
      : bodyBuffer.toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    });

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(textResponseEvents("modified request ok")));
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
  type GetCodexModels = () => Model<"openai-codex-responses">[];
  const modelSources: GetCodexModels[] = [() => getBuiltinModels(CODEX_PROVIDER)];
  const nestedPiAiPath = resolve(
    rootDir,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
  );

  try {
    const nestedPiAi = (await import(pathToFileURL(nestedPiAiPath).href)) as {
      getBuiltinModels?: (provider: typeof CODEX_PROVIDER) => Model<"openai-codex-responses">[];
    };
    if (nestedPiAi.getBuiltinModels) {
      modelSources.push(() => nestedPiAi.getBuiltinModels!(CODEX_PROVIDER));
    }
  } catch {
    // This dependency layout has no nested Pi AI copy.
  }

  const previous: Array<[Model<"openai-codex-responses">, string]> = [];
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

function assistantMessages(session: AgentSession): AssistantMessage[] {
  return session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
    );
}

void test("modifies requests on the canonical OpenAI Codex provider", async (t) => {
  const server = await startCodexServer(t);
  await pointBuiltInCodexAt(server.baseUrl, t);

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-request-options-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ [CODEX_PROVIDER]: codexCredential() }),
  );
  await writeFile(
    join(agentDir, CONFIG_FILE),
    JSON.stringify({
      fastMode: true,
      responsesLite: true,
      applyPatch: false,
      webSearch: "live",
      textVerbosity: "high",
      reasoningSummary: "detailed",
      reasoningMode: "pro",
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

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    defaultThinkingLevel: "high",
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
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

  const extensionResult = resourceLoader.getExtensions();
  assert.deepEqual(extensionResult.errors, []);
  assert.equal(extensionResult.runtime.pendingProviderRegistrations.length, 0);

  const model = modelRuntime.getModel(CODEX_PROVIDER, MODEL_ID);
  assert.ok(model);
  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(tempRoot, "sessions")),
    resourceLoader,
    model,
    thinkingLevel: "high",
    noTools: "all",
  });
  t.after(() => result.session.dispose());
  await result.session.bindExtensions({});

  assert.equal(result.session.model?.provider, CODEX_PROVIDER);
  assert.equal(result.session.getActiveToolNames().includes("apply_patch"), false);

  await result.session.prompt("exercise request settings", { expandPromptTemplates: false });

  assert.equal(server.requests.length, 1);
  const request = server.requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/codex/responses");
  assert.equal(request.headers.authorization, `Bearer ${fakeCodexToken()}`);
  assert.equal(
    request.headers["x-client-request-id"],
    (request.body["client_metadata"] as Record<string, unknown>)["thread_id"],
  );
  assert.equal(request.body["model"], MODEL_ID);
  assert.equal(request.body["service_tier"], "priority");
  assert.deepEqual(request.body["text"], { verbosity: "high" });
  assert.deepEqual(request.body["reasoning"], {
    effort: "high",
    summary: "detailed",
    mode: "pro",
    context: "all_turns",
  });
  assert.equal(request.body["instructions"], undefined);
  assert.equal(request.body["tools"], undefined);
  assert.deepEqual((request.body["input"] as Record<string, unknown>[])[0], {
    type: "additional_tools",
    role: "developer",
    tools: [],
  });
  assert.equal(request.headers["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(
    (request.body["client_metadata"] as Record<string, unknown>)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ],
    undefined,
  );

  const messages = assistantMessages(result.session);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.provider, CODEX_PROVIDER);
  assert.equal(messages[0]?.api, "openai-codex-responses");
  assert.equal(messages[0]?.usage.cost.total, 0.0004);
  const requestDiagnostic = messages[0]?.diagnostics?.find(
    (diagnostic) => diagnostic.type === "codex_transport_request",
  );
  const requestDetails = requestDiagnostic?.details as Record<string, unknown> | undefined;
  const cacheDetails = requestDetails?.["cache"] as Record<string, unknown> | undefined;
  assert.equal(requestDetails?.["selectedTransport"], "sse");
  assert.equal(requestDetails?.["accountId"], "acct_test");
  assert.equal(requestDetails?.["responseId"], "resp_text");
  assert.equal(typeof requestDetails?.["sessionId"], "string");
  assert.equal(typeof requestDetails?.["promptCacheKey"], "string");
  assert.equal(typeof requestDetails?.["turnId"], "string");
  assert.equal(cacheDetails?.["envelope"], "responses_lite");
  assert.equal(cacheDetails?.["staticInputItems"], 2);
  assert.deepEqual(requestDetails?.["usage"], {
    inputTokens: 10,
    cachedTokens: 0,
    cacheWriteTokens: 0,
  });

  const sessionFile = result.session.sessionFile;
  assert.ok(sessionFile);
  const persisted = await readFile(sessionFile, "utf8");
  assert.match(persisted, /"type":"codex_transport_request"/);
  assert.match(persisted, /acct_test|resp_text/);
  assert.doesNotMatch(persisted, /refresh_test/);
});
