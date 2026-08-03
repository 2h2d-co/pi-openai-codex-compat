import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  CodexTransport,
  requestCodexJson,
  resolveCodexApiUrl,
} from "../extensions/openai-codex-compat/codex-transport.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

function codexModel(): Model<any> {
  return {
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
  } as Model<any>;
}

function accessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

void test("posts authenticated JSON requests to sibling Codex endpoints", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await requestCodexJson(
    codexModel(),
    "alpha/search",
    { id: "session-1" },
    {
      apiKey: accessToken(),
      headers: { "x-provider": "provider" },
      extraHeaders: { "x-codex-turn-metadata": "turn" },
      fetch: async (input, init) => {
        requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requestInit = init;
        return new Response(JSON.stringify({ output: "result" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(
    resolveCodexApiUrl("https://chatgpt.com/backend-api/codex/responses", "/images/edits"),
    "https://chatgpt.com/backend-api/codex/images/edits",
  );
  assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/alpha/search");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${accessToken()}`);
  assert.equal(headers.get("chatgpt-account-id"), "account-1");
  assert.equal(headers.get("x-provider"), "provider");
  assert.equal(headers.get("x-codex-turn-metadata"), "turn");
  const requestBody = requestInit?.body;
  if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
  assert.deepEqual(JSON.parse(requestBody), { id: "session-1" });
  assert.deepEqual(result, { output: "result" });
});

void test("reports WebSocket close details and preserves preceding errors", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  let failureMode: "close" | "error-then-close" = "close";

  class FailingWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(): void {
      queueMicrotask(() => {
        if (failureMode === "error-then-close") {
          this.emit("error", { message: "underlying socket failure" });
        }
        this.readyState = 3;
        this.emit("close", { code: 1_006, reason: "connection lost", wasClean: false });
      });
    }

    close(): void {
      this.readyState = 3;
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FailingWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const transport = new CodexTransport();
  const options = {
    apiKey: accessToken(),
    transport: "websocket" as const,
  };
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
        // Consume the stream so its transport error is observed.
      }
    },
    {
      name: "WebSocketCloseError",
      message: "WebSocket closed (code 1006, reason: connection lost, wasClean: false)",
    },
  );

  failureMode = "error-then-close";
  await assert.rejects(
    async () => {
      for await (const _event of transport.request(codexModel(), { input: [] }, options)) {
        // Consume the stream so its transport error is observed.
      }
    },
    { message: "underlying socket failure" },
  );
});

void test("reuses one WebSocket for compaction and continuation requests", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const sent: JsonRecord[] = [];
  let connections = 0;

  class FakeWebSocket {
    readyState = 1;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor() {
      connections += 1;
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
      const request = JSON.parse(data) as JsonRecord;
      sent.push(request);
      const compacting =
        Array.isArray(request.input) &&
        request.input.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            (item as JsonRecord).type === "compaction_trigger",
        );
      const events: JsonRecord[] = compacting
        ? [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_compact",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
            },
          ]
        : [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_done",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
            },
          ];
      queueMicrotask(() => {
        for (const event of events) {
          this.emit("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
      this.emit("close", { code: 1_000, wasClean: true });
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  });

  const transport = new CodexTransport();
  const options = {
    apiKey: accessToken(),
    sessionId: "session-1",
    transport: "websocket-cached" as const,
  };
  const userItem = { role: "user", content: [{ type: "input_text", text: "hello" }] };
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };

  const firstEvents: JsonRecord[] = [];
  for await (const event of transport.request(codexModel(), { input: [userItem] }, options)) {
    firstEvents.push(event);
  }
  const compactEvents: JsonRecord[] = [];
  for await (const event of transport.request(
    codexModel(),
    { input: [userItem, messageItem, { type: "compaction_trigger" }] },
    options,
  )) {
    compactEvents.push(event);
  }
  const continuationEvents: JsonRecord[] = [];
  for await (const event of transport.request(
    codexModel(),
    { input: [{ type: "compaction", encrypted_content: "opaque" }] },
    options,
  )) {
    continuationEvents.push(event);
  }

  assert.equal(connections, 1);
  assert.equal(sent.length, 3);
  assert.equal(firstEvents.at(-1)?.type, "response.completed");
  assert.equal(sent[1]?.previous_response_id, "resp_done");
  assert.deepEqual(sent[1]?.input, [{ type: "compaction_trigger" }]);
  assert.equal(sent[2]?.previous_response_id, undefined);
  assert.deepEqual(sent[2]?.input, [{ type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(compactEvents.at(-1)?.type, "response.completed");
  assert.equal(continuationEvents.at(-1)?.type, "response.completed");
  transport.close("session-1");
});
