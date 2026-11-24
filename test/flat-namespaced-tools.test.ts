import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  BeforeProviderRequestEvent,
  BeforeProviderRequestEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { isObject, type JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { withoutCodexNamespacedTools } from "../extensions/openai-codex-compat/namespaced-tools.ts";
import registerCodexRequestOptions from "../extensions/openai-codex-compat/request-options.ts";

type RequestHook = ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>;

function requestHook(): RequestHook {
  let hook: RequestHook | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- This guarded broad third-party API boundary lets the focused hook test fail immediately on every unimplemented member.
  const pi: ExtensionAPI = Object.assign(Object.create(null), {
    on(event: string, handler: RequestHook) {
      if (event === "before_provider_request") hook = handler;
      return () => {};
    },
  });
  registerCodexRequestOptions(pi, () => DEFAULT_CONFIG);
  if (!hook) throw new Error("The request hook was not registered.");
  return hook;
}

function requestContext(model: Model<Api>): ExtensionContext {
  // oxlint-disable-next-line typescript/no-unsafe-return -- This guarded broad third-party context boundary lets the focused hook test fail immediately on every unimplemented member.
  return Object.assign(Object.create(null), { model, modelRegistry: { find: () => model } });
}

function declaredToolNames(payload: JsonRecord): unknown[] {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const input = Array.isArray(payload.input) ? payload.input : [];
  const additional = input.flatMap((item) =>
    isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)
      ? item.tools
      : [],
  );
  return [...tools, ...additional].map((tool) => (isObject(tool) ? tool.name : undefined));
}

const fixtureToken = `fixture.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
).toString("base64url")}.fixture`;

for (const modelId of ["gpt-6-luna", "gpt-6.2-sol"]) {
  test(`removes dotted tool names from a ${modelId} request that Pi's own Codex provider built`, async () => {
    const provider = builtinProviders().find((candidate) => candidate.id === "openai-codex");
    assert.ok(provider, "Pi supplies the openai-codex provider");
    const model = provider.getModels().find((candidate) => candidate.id === modelId);
    assert.ok(model, `Pi supplies ${modelId}`);
    const hook = requestHook();
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fixture network stop");
    };
    let built: JsonRecord | undefined;
    let sent: JsonRecord | undefined;
    try {
      const response = await provider
        .streamSimple(
          model,
          normalizeContext({
            messages: [
              {
                role: "system",
                content: "Fixture",
                timestamp: 0,
                toolsAdded: [tool("read"), tool("web.run"), tool("image_gen.imagegen")],
              },
              { role: "user", content: "fixture", timestamp: 1 },
            ],
          }),
          {
            apiKey: fixtureToken,
            sessionId: "fixture-flat-tools",
            transport: "sse",
            onPayload: async (payload: unknown) => {
              assert.ok(isObject(payload));
              built = payload;
              const changed = await hook(
                { type: "before_provider_request", payload },
                requestContext(model),
              );
              sent = isObject(changed) ? changed : payload;
              return sent;
            },
          },
        )
        .result();
      assert.equal(response.stopReason, "error");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(built && sent);
    // Control: without the hook these names reach the backend, which refuses the request.
    assert.deepEqual(declaredToolNames(built), ["read", "web.run", "image_gen.imagegen"]);
    assert.deepEqual(declaredToolNames(sent), ["read"]);
  });
}

test("removes dotted tool names from top-level tools and from additional_tools items", () => {
  assert.deepEqual(
    withoutCodexNamespacedTools({
      tools: [
        { type: "function", name: "read" },
        { type: "function", name: "web.run" },
        { type: "function", function: { name: "image_gen.imagegen" } },
      ],
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "function", name: "image_gen.imagegen" },
            { type: "function", name: "bash" },
          ],
        },
        { role: "user", content: "fixture" },
      ],
    }),
    {
      tools: [{ type: "function", name: "read" }],
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "function", name: "bash" }],
        },
        { role: "user", content: "fixture" },
      ],
    },
  );
});

test("drops an additional_tools item left without a tool", () => {
  assert.deepEqual(
    withoutCodexNamespacedTools({
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "function", name: "web.run" }],
        },
        { role: "user", content: "fixture" },
      ],
    }),
    { input: [{ role: "user", content: "fixture" }] },
  );
});

test("keeps the namespaces this extension's transport declares", () => {
  const payload = {
    tools: [{ type: "namespace", name: "web", tools: [{ type: "function", name: "run" }] }],
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen" }],
          },
        ],
      },
    ],
  };
  assert.equal(withoutCodexNamespacedTools(payload), undefined);
});

test("removes dotted tool names from another provider's request and leaves the rest alone", () => {
  const hook = requestHook();
  const model = builtinProviders()
    .find((candidate) => candidate.id === "openai")
    ?.getModels()
    .find((candidate) => candidate.api === "openai-responses");
  assert.ok(model, "Pi supplies an openai-responses model");
  const ctx = requestContext(model);
  assert.deepEqual(
    hook(
      {
        type: "before_provider_request",
        payload: {
          tools: [
            { type: "function", name: "read" },
            { type: "function", name: "web.run" },
          ],
        },
      },
      ctx,
    ),
    { tools: [{ type: "function", name: "read" }] },
  );
  assert.equal(
    hook(
      { type: "before_provider_request", payload: { tools: [{ type: "function", name: "read" }] } },
      ctx,
    ),
    undefined,
  );
});
