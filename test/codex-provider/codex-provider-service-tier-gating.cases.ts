import { requireJsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { CodexModelCatalog } from "../../extensions/openai-codex-compat/codex-model-catalog.ts";
import type { SpeedServiceTier } from "../../extensions/openai-codex-compat/service-tier.ts";
import { catalogServer } from "../support/model-catalog.ts";
import {
  assert,
  test,
  MANUAL_COMPACTION_METADATA,
  codexModel,
  userEntry,
  textEvents,
  compactionEvents,
  accessToken,
  createHarness,
  type AssistantMessage,
  type JsonRecord,
} from "./codex-provider-harness.ts";

// A Pro $200 catalog: Ultrafast only on GPT-6.2 Sol, and Fast on every model it lists.
const PRO_200_CATALOG = {
  "gpt-6.2-sol": ["priority", "ultrafast"],
  "gpt-6.2-astra": ["priority"],
  "gpt-6-luna": ["priority"],
  "gpt-daybreak-blue-latest": [],
};
// Pro $500 adds Ultrafast on GPT-6.2 Astra, GPT-6 Astra, and GPT-6.1 Sol.
const PRO_500_CATALOG = {
  ...PRO_200_CATALOG,
  "gpt-6.2-astra": ["priority", "ultrafast"],
};
// 10 input tokens at $1 and 5 output tokens at $2 per million cost $0.00002 at Standard.
const STANDARD_TURN_COST = 0.00002;
// Ultrafast costs 3 times Standard for GPT-6.2 through February 28, 2027, Pacific time.
const BEFORE_GPT_6_2_LIST_PRICE = Date.parse("2026-11-23T12:00:00Z");

function gatedHarness(models: Record<string, readonly string[]>) {
  const server = catalogServer(models);
  const catalog = new CodexModelCatalog({ fetch: server.fetch, file: () => undefined });
  const user = userEntry("user-1", "hello");
  const harness = createHarness([user], undefined, undefined, undefined, catalog);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* textEvents("ok");
  };
  const turn = (modelId: string, serviceTier: SpeedServiceTier | undefined) =>
    harness.runtime
      .stream(
        codexModel(modelId),
        { messages: [user.message] },
        { apiKey: accessToken(), sessionId: "session-1", transport: "sse", serviceTier },
      )
      .result();
  return { server, catalog, harness, requests, turn };
}

function assertCost(message: AssistantMessage, multiplier: number): void {
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.ok(Math.abs(message.usage.cost.total - STANDARD_TURN_COST * multiplier) < 1e-12);
}

test("sends Ultrafast only on models whose catalog entry lists it, and prices the rest at Standard", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: BEFORE_GPT_6_2_LIST_PRICE });
  const { server, harness, requests, turn } = gatedHarness(PRO_200_CATALOG);

  assertCost(await turn("gpt-6.2-sol", "ultrafast"), 3);
  assert.equal(requests[0]?.["service_tier"], "ultrafast");

  assertCost(await turn("gpt-6.2-astra", "ultrafast"), 1);
  assert.equal(Object.hasOwn(requests[1] ?? {}, "service_tier"), false);
  assert.deepEqual(harness.notices, [
    "Your ChatGPT plan does not include Ultrafast for gpt-6.2-astra, so its requests run at Standard speed.",
  ]);

  // The notice appears once per model, and Fast stays available where the catalog lists it.
  await turn("gpt-6.2-astra", "ultrafast");
  assertCost(await turn("gpt-6.2-astra", "priority"), 2);
  assert.equal(requests[3]?.["service_tier"], "priority");
  assert.equal(harness.notices.length, 1);

  // A model whose catalog entry lists no tier gets no Fast either, as in the Codex CLI.
  await turn("gpt-daybreak-blue-latest", "priority");
  assert.equal(Object.hasOwn(requests[4] ?? {}, "service_tier"), false);
  assert.match(harness.notices[1] ?? "", /does not include Fast for gpt-daybreak-blue-latest/);

  // One catalog request served every turn of the account.
  assert.equal(server.requests.length, 1);
});

test("sends Ultrafast on every model a Pro $500 catalog lists it for", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: BEFORE_GPT_6_2_LIST_PRICE });
  const { harness, requests, turn } = gatedHarness(PRO_500_CATALOG);

  assertCost(await turn("gpt-6.2-astra", "ultrafast"), 3);
  assert.equal(requests[0]?.["service_tier"], "ultrafast");
  assert.deepEqual(harness.notices, []);
});

test("without a catalog, keeps Fast and runs Ultrafast at Standard until the catalog loads", async () => {
  const { server, harness, requests, turn } = gatedHarness(PRO_200_CATALOG);
  server.failure = 503;

  await turn("gpt-6.2-sol", "ultrafast");
  await turn("gpt-6.2-sol", "priority");
  assert.equal(Object.hasOwn(requests[0] ?? {}, "service_tier"), false);
  assert.equal(requests[1]?.["service_tier"], "priority");
  assert.deepEqual(harness.notices, [
    "The OpenAI Codex model catalog could not be loaded (HTTP 503), so gpt-6.2-sol runs at Standard speed instead of Ultrafast until it loads.",
  ]);
  // A failed load is not retried by every request.
  assert.equal(server.requests.length, 1);
});

test("Standard requests do not wait for the catalog", async () => {
  const { server, requests, turn } = gatedHarness(PRO_200_CATALOG);

  await turn("gpt-6.2-sol", undefined);
  assert.equal(Object.hasOwn(requests[0] ?? {}, "service_tier"), false);
  assert.equal(server.requests.length, 0);
});

test("gates the tier of native compaction requests and prices them at the tier sent", async () => {
  const { harness } = gatedHarness(PRO_200_CATALOG);
  const requests: JsonRecord[] = [];
  harness.runtime.transport.request = async function* (_model, body) {
    requests.push(structuredClone(requireJsonRecord(body)));
    yield* compactionEvents();
  };

  const result = await harness.runtime.compact({
    model: codexModel("gpt-6.2-astra"),
    requestOptions: { apiKey: accessToken(), sessionId: "session-1", transport: "sse" },
    history: [],
    instructions: "Compact",
    grammarToolInputProperties: new Map(),
    template: {},
    serviceTier: "ultrafast",
    compactionMetadata: MANUAL_COMPACTION_METADATA,
    compactionDecision: { reason: "manual", willRetry: false },
  });

  assert.equal(Object.hasOwn(requests[0] ?? {}, "service_tier"), false);
  // 100 input tokens at $1 and 10 output tokens at $2 per million cost $0.00012 at Standard.
  assert.ok(Math.abs((result.usage?.cost.total ?? 0) - 0.00012) < 1e-12);
});

test("refreshes the catalog after a response reports a new catalog ETag", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: BEFORE_GPT_6_2_LIST_PRICE });
  const { server, harness, requests, turn } = gatedHarness(PRO_200_CATALOG);
  let reportEtag: ((etag: string) => void) | undefined;
  harness.runtime.transport.request = async function* (_model, body, options) {
    requests.push(structuredClone(requireJsonRecord(body)));
    reportEtag = options.onModelsEtag;
    yield* textEvents("ok");
  };

  await turn("gpt-6.2-astra", "ultrafast");
  assert.equal(Object.hasOwn(requests[0] ?? {}, "service_tier"), false);

  // The plan now includes Ultrafast on Astra, and the next response reports the new ETag.
  server.models = PRO_500_CATALOG;
  server.etag = '"catalog-2"';
  assert.ok(reportEtag);
  reportEtag('"catalog-2"');
  // A changed ETag means the catalog changed, so the next request waits for the new one.
  await turn("gpt-6.2-astra", "ultrafast");
  assert.equal(server.requests.length, 2);
  assert.equal(requests[1]?.["service_tier"], "ultrafast");
});
