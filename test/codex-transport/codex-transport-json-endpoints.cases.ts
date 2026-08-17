import {
  assert,
  test,
  requestCodexJson,
  resolveCodexApiUrl,
  codexModel,
  accessToken,
} from "./codex-transport-harness.ts";

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

void test("rejects an empty Codex account ID before sending", async () => {
  let fetched = false;
  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(""),
        fetch: async () => {
          fetched = true;
          return new Response("{}");
        },
      },
    ),
    { message: "Failed to extract accountId from token" },
  );
  assert.equal(fetched, false);
});

void test("formats structured errors from sibling Codex endpoints", async () => {
  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "usage_limit_reached",
                message: "limit reached",
                plan_type: "plus",
              },
            }),
            { status: 429 },
          ),
      },
    ),
    { message: "You have hit your ChatGPT usage limit (plus plan)." },
  );
});

void test("matches Pi AI's raw and untruncated HTTP error messages", async () => {
  const longMessage = `upstream-${"x".repeat(4_100)}`;
  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: longMessage } }), { status: 400 }),
      },
    ),
    { message: longMessage },
  );

  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () => new Response("  upstream denied  ", { status: 400 }),
      },
    ),
    { message: "  upstream denied  " },
  );

  await assert.rejects(
    requestCodexJson(
      codexModel(),
      "alpha/search",
      {},
      {
        apiKey: accessToken(),
        fetch: async () => new Response("", { status: 500 }),
      },
    ),
    { message: "Request failed" },
  );
});
