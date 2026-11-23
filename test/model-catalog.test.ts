import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CODEX_MODEL_CATALOG_CLIENT_VERSION,
  CODEX_MODEL_CATALOG_TTL_MS,
  CodexModelCatalog,
  loadSelectedModelCatalog,
  parseCatalogModels,
} from "../extensions/openai-codex-compat/codex-model-catalog.ts";
import {
  captureModelsEtagEvent,
  captureModelsEtagHeader,
} from "../extensions/openai-codex-compat/codex-transport/codex-transport-request-headers.ts";
import { requireJsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import { codexModel } from "./codex-provider/codex-provider-harness.ts";
import { speedNote } from "../extensions/openai-codex-compat/settings-pane.ts";
import { catalogServer, codexToken } from "./support/model-catalog.ts";

const BASE_URL = "https://chatgpt.com/backend-api";
const PRO_200 = { "gpt-6.2-sol": ["priority", "ultrafast"], "gpt-6.2-astra": ["priority"] };
const PRO_500 = {
  "gpt-6.2-sol": ["priority", "ultrafast"],
  "gpt-6.2-astra": ["priority", "ultrafast"],
};

function account(accountId: string) {
  return { accountId, apiKey: codexToken(accountId), baseUrl: BASE_URL };
}

function clock(start = Date.parse("2026-11-23T12:00:00Z")) {
  const state = { now: start };
  return { now: () => state.now, advance: (ms: number) => (state.now += ms) };
}

async function catalogFile(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-model-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "agent", "openai-codex-compat-model-catalog.json");
}

test("requests the account's catalog with the Codex client version and reads each model's tiers", async () => {
  const server = catalogServer(PRO_200);
  const catalog = new CodexModelCatalog({ fetch: server.fetch, file: () => undefined });

  await catalog.load(account("account-1"));

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.ok(request);
  assert.equal(request.url.origin + request.url.pathname, `${BASE_URL}/codex/models`);
  assert.equal(request.url.searchParams.get("client_version"), CODEX_MODEL_CATALOG_CLIENT_VERSION);
  assert.equal(request.headers.get("authorization"), `Bearer ${codexToken("account-1")}`);
  assert.equal(request.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(request.headers.get("originator"), "pi");
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );
  assert.deepEqual(catalog.currentServiceTiers("gpt-6.2-astra"), new Set(["priority"]));
  // A model the catalog leaves out, such as one that needs a newer client, has unknown tiers.
  assert.equal(catalog.serviceTiers("account-1", "gpt-7-sol"), undefined);
  assert.equal(catalog.serviceTiers("account-2", "gpt-6.2-sol"), undefined);
});

test("shares one request between concurrent loads and reuses a fresh catalog", async () => {
  const server = catalogServer(PRO_200);
  const time = clock();
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });

  await Promise.all([catalog.load(account("account-1")), catalog.load(account("account-1"))]);
  time.advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 1);
});

test("answers from a stale catalog while a newer one loads", async () => {
  const server = catalogServer(PRO_200);
  const time = clock();
  let loads = 0;
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });
  catalog.subscribe(() => loads++);
  await catalog.load(account("account-1"));

  server.models = PRO_500;
  time.advance(CODEX_MODEL_CATALOG_TTL_MS);
  await catalog.load(account("account-1"));
  // The load returned before the refresh, so the old tiers still answer.
  assert.deepEqual(catalog.serviceTiers("account-1", "gpt-6.2-astra"), new Set(["priority"]));
  await catalog.load(account("account-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.requests.length, 2);
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-astra"),
    new Set(["priority", "ultrafast"]),
  );
  assert.equal(loads, 2);
});

test("a matching response ETag keeps the catalog fresh, and a new one refreshes it", async () => {
  const server = catalogServer(PRO_200, '"catalog-1"');
  const time = clock();
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });
  await catalog.load(account("account-1"));

  time.advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
  catalog.noteModelsEtag("account-1", '"catalog-1"');
  time.advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 1);

  catalog.noteModelsEtag("account-1", '"catalog-2"');
  await catalog.load(account("account-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.requests.length, 2);
  // The refreshed catalog carries the server's ETag, so the same ETag needs no further refresh.
  server.etag = '"catalog-1"';
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 2);
});

test("reports why an account has no catalog and retries a failed load after 30 seconds", async () => {
  const server = catalogServer(PRO_200);
  const time = clock();
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });

  for (const [failure, reason] of [
    [401, "HTTP 401"],
    ["network", "network error"],
  ] as const) {
    server.failure = failure;
    time.advance(30_000);
    await catalog.load(account("account-1"));
    assert.equal(catalog.failure("account-1"), reason);
    assert.equal(catalog.serviceTiers("account-1", "gpt-6.2-sol"), undefined);
  }
  const attempts = server.requests.length;
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, attempts);

  server.failure = undefined;
  time.advance(30_000);
  await catalog.load(account("account-1"));
  assert.equal(catalog.failure("account-1"), undefined);
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );

  // A failed refresh keeps the catalog the account already has.
  server.failure = 503;
  time.advance(CODEX_MODEL_CATALOG_TTL_MS);
  await catalog.load(account("account-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalog.failure("account-1"), undefined);
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );
});

test("rejects a response without a model list", async () => {
  const catalog = new CodexModelCatalog({
    fetch: async () => new Response(JSON.stringify({ data: [] })),
    file: () => undefined,
  });
  await catalog.load(account("account-1"));
  assert.equal(catalog.failure("account-1"), "invalid catalog response");
  assert.throws(() => parseCatalogModels("not a catalog"), /invalid catalog response/);
  assert.deepEqual(
    parseCatalogModels({
      models: [
        { slug: "gpt-6.2-sol", service_tiers: [{ id: "ultrafast" }, { name: "no id" }, "fast"] },
        { slug: "", service_tiers: [{ id: "priority" }] },
        { service_tiers: [{ id: "priority" }] },
        { slug: "gpt-6-luna" },
      ],
    }),
    new Map([
      ["gpt-6.2-sol", new Set(["ultrafast"])],
      ["gpt-6-luna", new Set()],
    ]),
  );
});

test("stops waiting for the catalog when the request is aborted", async () => {
  const catalog = new CodexModelCatalog({
    fetch: () => new Promise<Response>(() => {}),
    file: () => undefined,
  });
  const controller = new AbortController();
  const load = catalog.load(account("account-1"), controller.signal);
  controller.abort();
  await load;
  assert.equal(catalog.serviceTiers("account-1", "gpt-6.2-sol"), undefined);
});

test("keeps separate catalogs per account and follows the account that loaded last", async () => {
  const servers = { "account-200": catalogServer(PRO_200), "account-500": catalogServer(PRO_500) };
  const catalog = new CodexModelCatalog({
    fetch: (input, init) => {
      const accountId = new Headers(init?.headers).get("chatgpt-account-id");
      return accountId === "account-500"
        ? servers["account-500"].fetch(input, init)
        : servers["account-200"].fetch(input, init);
    },
    file: () => undefined,
  });

  await catalog.load(account("account-200"));
  assert.deepEqual(catalog.currentServiceTiers("gpt-6.2-astra"), new Set(["priority"]));
  await catalog.load(account("account-500"));
  assert.deepEqual(catalog.currentServiceTiers("gpt-6.2-astra"), new Set(PRO_500["gpt-6.2-astra"]));
  assert.deepEqual(catalog.serviceTiers("account-200", "gpt-6.2-astra"), new Set(["priority"]));
});

test("keeps catalogs across processes without writing account ids", async (t) => {
  const file = await catalogFile(t);
  const server = catalogServer(PRO_200);
  const time = clock();
  await new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file }).load(
    account("account-secret-id"),
  );
  const saved = await readFile(file, "utf8");
  assert.doesNotMatch(saved, /account-secret-id/);
  assert.match(saved, /"gpt-6\.2-sol"/);

  // A new process answers from the saved catalog without a request.
  const restarted = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await restarted.load(account("account-secret-id"));
  assert.equal(server.requests.length, 1);
  assert.deepEqual(
    restarted.serviceTiers("account-secret-id", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );

  // When the catalog cannot be loaded, a saved catalog of any age still answers.
  server.failure = "network";
  time.advance(24 * 60 * 60_000);
  const offline = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await offline.load(account("account-secret-id"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    offline.serviceTiers("account-secret-id", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );
});

test("refreshes a saved catalog requested for another client version, and ignores a broken file", async (t) => {
  const file = await catalogFile(t);
  const server = catalogServer(PRO_500);
  const time = clock();
  await new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file }).load(
    account("account-1"),
  );
  const saved = requireJsonRecord(JSON.parse(await readFile(file, "utf8")));
  for (const entry of Object.values(requireJsonRecord(saved["accounts"]))) {
    requireJsonRecord(entry)["clientVersion"] = "0.149.1";
  }
  await writeFile(file, JSON.stringify(saved));

  const upgraded = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await upgraded.load(account("account-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.requests.length, 2);

  await writeFile(file, "{ not json");
  const broken = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await broken.load(account("account-1"));
  assert.equal(server.requests.length, 3);
  assert.deepEqual(
    broken.serviceTiers("account-1", "gpt-6.2-astra"),
    new Set(PRO_500["gpt-6.2-astra"]),
  );
});

test("loads the catalog of the selected OpenAI Codex model's account", async () => {
  const server = catalogServer(PRO_200);
  const catalog = new CodexModelCatalog({ fetch: server.fetch, file: () => undefined });
  const codex = codexModel("gpt-6.2-sol");
  const context = (model: Model<Api>, apiKey: string | undefined) => ({
    model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () =>
        apiKey === undefined ? { ok: true as const } : { ok: true as const, apiKey },
    },
  });

  await loadSelectedModelCatalog(catalog, context({ ...codex, provider: "anthropic" }, "key"));
  await loadSelectedModelCatalog(catalog, context(codex, undefined));
  await loadSelectedModelCatalog(catalog, context(codex, "not-a-token"));
  assert.equal(server.requests.length, 0);

  await loadSelectedModelCatalog(catalog, context(codex, codexToken("account-1")));
  assert.equal(server.requests.length, 1);
  assert.deepEqual(catalog.currentServiceTiers("gpt-6.2-sol"), new Set(PRO_200["gpt-6.2-sol"]));
});

test("reads the catalog ETag from SSE headers and WebSocket metadata events", () => {
  const etags: string[] = [];
  const report = (etag: string) => etags.push(etag);
  captureModelsEtagHeader(new Headers({ "X-Models-Etag": '"one"' }), report);
  captureModelsEtagHeader(new Headers(), report);
  captureModelsEtagEvent(
    { type: "response.metadata", headers: { "X-Models-Etag": '"two"' } },
    report,
  );
  captureModelsEtagEvent(
    { type: "codex.response.metadata", headers: { "x-models-etag": '"three"' } },
    report,
  );
  captureModelsEtagEvent(
    { type: "response.created", headers: { "x-models-etag": '"ignored"' } },
    report,
  );
  assert.deepEqual(etags, ['"one"', '"two"', '"three"']);
});

test("the Default speed row says when the plan lacks the selected model's speed", () => {
  const ultrafast = { ...DEFAULT_CONFIG, speed: "ultrafast" } as const;
  assert.equal(
    speedNote(ultrafast, "gpt-6.2-astra", new Set(["priority"])),
    "Your plan does not include Ultrafast for gpt-6.2-astra, so it runs at Standard. ",
  );
  assert.equal(speedNote(ultrafast, "gpt-6.2-sol", new Set(["priority", "ultrafast"])), "");
  assert.equal(
    speedNote(ultrafast, "gpt-6.2-sol", undefined),
    "gpt-6.2-sol runs at Standard until the Codex model catalog shows Ultrafast for it. ",
  );
  assert.equal(speedNote({ ...DEFAULT_CONFIG, speed: "fast" }, "gpt-6.2-sol", undefined), "");
  assert.equal(
    speedNote(
      { ...ultrafast, speedByModel: { "gpt-6.2-astra": "fast" } },
      "gpt-6.2-astra",
      new Set(["priority"]),
    ),
    "gpt-6.2-astra uses its speedByModel value, fast. ",
  );
});
