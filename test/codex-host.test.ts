import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(rootDir, "extensions/index.ts");

function accessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

function sseResponse(events: readonly JsonRecord[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function assistantMessages(branch: ReturnType<SessionManager["getBranch"]>): AssistantMessage[] {
  return branch.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
  );
}

void test("Pi executes only done calls from mixed partial Codex batches", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-codex-host-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, CONFIG_FILE),
    JSON.stringify({
      applyPatch: false,
      fastMode: false,
      imageGeneration: false,
      responsesLite: false,
      webRun: false,
      webSearch: "disabled",
    }),
  );

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const previousFetch = globalThis.fetch;
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const requests: JsonRecord[] = [];
  globalThis.fetch = async (_input, init) => {
    const requestBody = init?.body;
    const compressed = new Headers(init?.headers).get("content-encoding") === "zstd";
    const requestText =
      typeof requestBody === "string"
        ? requestBody
        : requestBody instanceof Uint8Array
          ? compressed
            ? zstdDecompressSync(requestBody).toString("utf8")
            : new TextDecoder().decode(requestBody)
          : undefined;
    if (!requestText) throw new Error("Codex request body was not JSON text");
    requests.push(JSON.parse(requestText) as JsonRecord);
    if (requests.length === 1) {
      const completeCall = {
        type: "function_call",
        id: "fc_complete",
        call_id: "call_complete",
        name: "report",
        status: "incomplete",
        arguments: '{"value":"complete"}',
      };
      return sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...completeCall, arguments: "" },
        },
        { type: "response.output_item.done", output_index: 0, item: completeCall },
        {
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
        },
        {
          type: "response.incomplete",
          response: {
            id: "response-mixed",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "function_call",
                id: "fc_terminal_only",
                call_id: "call_terminal_only",
                name: "report",
                status: "completed",
                arguments: '{"value":"terminal"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]);
    }
    return sseResponse([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "message-finished",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "finished", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "response-finished",
          status: "completed",
          usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17 },
        },
      },
    ]);
  };

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    "openai-codex",
    async () =>
      ({
        type: "oauth",
        access: accessToken(),
        refresh: "unused-refresh-token",
        expires: Date.now() + 60 * 60 * 1_000,
      }) satisfies Credential,
  );
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("openai-codex", "gpt-5.6-luna");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    retry: { enabled: false, provider: { timeoutMs: 30_000, maxRetries: 0 } },
    compaction: { enabled: false },
  });
  const reports: string[] = [];
  const report = defineTool({
    name: "report",
    label: "Report",
    description: "Report a value.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, params) {
      reports.push(params.value);
      return {
        content: [{ type: "text", text: "completed" }],
        details: {},
      };
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    systemPromptOverride: () => "Use the report tool.",
    appendSystemPromptOverride: () => [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    model,
    noTools: "builtin",
    customTools: [report],
  });
  await created.session.bindExtensions({});
  t.after(() => created.session.dispose());

  await created.session.prompt("Inspect both values.", { expandPromptTemplates: false });

  assert.deepEqual(reports, ["complete"]);
  assert.equal(requests.length, 2);
  const secondInput = requests[1]?.input as JsonRecord[];
  assert.equal(secondInput.filter((item) => item.type === "function_call").length, 1);
  assert.equal(secondInput.filter((item) => item.type === "function_call_output").length, 1);
  assert.match(JSON.stringify(secondInput), /call_complete|completed/);
  assert.doesNotMatch(JSON.stringify(secondInput), /call_partial|call_terminal_only/);
  const assistants = assistantMessages(created.session.sessionManager.getBranch());
  assert.deepEqual(
    assistants.map((message) => message.stopReason),
    ["toolUse", "stop"],
  );
  assert.equal(assistants[0]?.content.filter((block) => block.type === "toolCall").length, 1);
});
