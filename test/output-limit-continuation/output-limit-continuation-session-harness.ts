import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { hasObjectType } from "../../extensions/openai-codex-compat/value-contracts.ts";
import { requireBuiltinModelsModule } from "../support/pi-fixtures.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { CONFIG_FILE } from "../../extensions/openai-codex-compat/config.ts";
import {
  CODEX_API,
  CODEX_PROVIDER,
  MODEL_ID,
  codexCredential,
  extensionPath,
  rootDir,
  type JsonRecord,
} from "./output-limit-continuation-contracts-and-builders.ts";

export function sse(events: JsonRecord[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function incompleteEvents(): JsonRecord[] {
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

export function exhaustedOutputLimitEvents(attempt: number): JsonRecord[] {
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

export function compactionEvents(): JsonRecord[] {
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

export function contextOverflowEvents(): JsonRecord[] {
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

export function textEvents(text: string): JsonRecord[] {
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

export function followUpEvents(text: string): JsonRecord[] {
  const events = textEvents(text);
  const terminal = events.at(-1);
  assert.ok(terminal && hasObjectType(terminal["response"]) && terminal["response"] !== null);
  requireJsonRecord(terminal["response"])["end_turn"] = false;
  return events;
}

export async function startCodexServer(
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
    const body = requireJsonRecord(JSON.parse(rawBody));
    requests.push(body);

    const input = Array.isArray(body["input"]) ? requireJsonRecords(body["input"]) : [];
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
  assert.ok(address && hasObjectType(address));
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

export async function pointBuiltInCodexAt(baseUrl: string, t: TestContext): Promise<void> {
  type GetCodexModels = () => Model<typeof CODEX_API>[];
  const modelSources: GetCodexModels[] = [() => getBuiltinModels(CODEX_PROVIDER)];
  const nestedPiAiPath = resolve(
    rootDir,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
  );

  try {
    const nestedPiAi = requireBuiltinModelsModule(await import(pathToFileURL(nestedPiAiPath).href));
    const getNestedModels = nestedPiAi.getBuiltinModels?.bind(nestedPiAi);
    if (getNestedModels) {
      modelSources.push(() => getNestedModels(CODEX_PROVIDER));
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

export async function createTestSession(
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
  const sessionOptions: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    model,
    thinkingLevel: "low",
  };
  if (!options?.tools) sessionOptions.noTools = "all";
  const result = await createAgentSession(sessionOptions);
  t.after(() => result.session.dispose());
  await result.session.bindExtensions({});
  return { cwd, session: result.session };
}
