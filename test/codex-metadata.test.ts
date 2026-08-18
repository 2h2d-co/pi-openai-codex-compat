import { requireJsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import { hasObjectType, requireString } from "../extensions/openai-codex-compat/value-contracts.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodexMetadataHeaders,
  CODEX_INSTALLATION_ID_METADATA_KEY,
  CODEX_TURN_METADATA_HEADER,
  CODEX_WINDOW_ID_HEADER,
  responsesCompactionV2Metadata,
  withCodexRequestMetadata,
} from "../extensions/openai-codex-compat/codex-metadata.ts";

test("adds Codex session, thread, turn, and request-kind metadata", () => {
  const installationId = "11111111-1111-4111-8111-111111111111";
  const payload = withCodexRequestMetadata(
    { input: [], client_metadata: { retained: "value" } },
    "session-1",
    { kind: "turn" },
    "turn-1",
    {
      installationId,
      windowNumber: 2,
      turnStartedAtUnixMs: 123,
      threadSource: "user",
      sandbox: "none",
    },
  );
  const candidate = payload["client_metadata"];
  assert.ok(candidate && hasObjectType(candidate) && !Array.isArray(candidate));
  const metadata = requireJsonRecord(candidate);
  assert.equal(metadata["retained"], "value");
  assert.equal(metadata["session_id"], "session-1");
  assert.equal(metadata["thread_id"], "session-1");
  assert.equal(metadata["turn_id"], "turn-1");
  assert.equal(metadata[CODEX_INSTALLATION_ID_METADATA_KEY], installationId);
  assert.equal(metadata[CODEX_WINDOW_ID_HEADER], "session-1:2");

  const turn = requireJsonRecord(
    JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
  );
  assert.equal(turn["installation_id"], installationId);
  assert.equal(turn["session_id"], "session-1");
  assert.equal(turn["thread_id"], "session-1");
  assert.equal(turn["turn_id"], metadata["turn_id"]);
  assert.equal(turn["window_id"], "session-1:2");
  assert.equal(turn["request_kind"], "turn");
  assert.equal(turn["thread_source"], "user");
  assert.equal(turn["sandbox"], "none");
  assert.equal(turn["turn_started_at_unix_ms"], 123);

  const headers = new Headers();
  applyCodexMetadataHeaders(headers, payload);
  assert.equal(headers.get("thread-id"), "session-1");
  assert.equal(headers.get(CODEX_WINDOW_ID_HEADER), "session-1:2");
  assert.equal(headers.get(CODEX_TURN_METADATA_HEADER), metadata[CODEX_TURN_METADATA_HEADER]);
});

test("adds the official nested metadata to compaction requests only", () => {
  const compaction = responsesCompactionV2Metadata("auto", "context_limit", "mid_turn");
  const payload = withCodexRequestMetadata(
    { input: [] },
    "session-1",
    { kind: "compaction", compaction },
    "turn-1",
    { installationId: "11111111-1111-4111-8111-111111111111" },
  );
  const metadata = requireJsonRecord(payload["client_metadata"]);
  const turn = requireJsonRecord(
    JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
  );
  assert.equal(turn["request_kind"], "compaction");
  assert.deepEqual(turn["compaction"], {
    trigger: "auto",
    reason: "context_limit",
    implementation: "responses_compaction_v2",
    phase: "mid_turn",
    strategy: "memento",
  });

  const ordinary = withCodexRequestMetadata(
    { input: [] },
    "session-1",
    { kind: "turn" },
    "turn-2",
    { installationId: "11111111-1111-4111-8111-111111111111" },
  );
  const ordinaryMetadata = requireJsonRecord(ordinary["client_metadata"]);
  const ordinaryTurn = requireJsonRecord(
    JSON.parse(
      requireString(ordinaryMetadata[CODEX_TURN_METADATA_HEADER], "ordinary turn metadata"),
    ),
  );
  assert.equal(ordinaryTurn["compaction"], undefined);
});

test("projects branch thread and fork lineage without changing session identity", () => {
  const payload = withCodexRequestMetadata({ input: [] }, "session-1", { kind: "turn" }, "turn-1", {
    installationId: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-2",
    forkedFromThreadId: "thread-1",
    windowNumber: 3,
  });
  const metadata = requireJsonRecord(payload["client_metadata"]);
  assert.equal(metadata["session_id"], "session-1");
  assert.equal(metadata["thread_id"], "thread-2");
  assert.equal(metadata[CODEX_WINDOW_ID_HEADER], "thread-2:3");
  const turn = requireJsonRecord(
    JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
  );
  assert.equal(turn["session_id"], "session-1");
  assert.equal(turn["thread_id"], "thread-2");
  assert.equal(turn["forked_from_thread_id"], "thread-1");
  assert.equal(turn["window_id"], "thread-2:3");
});

test("omits Codex metadata without session affinity", () => {
  assert.deepEqual(
    withCodexRequestMetadata({ input: [], client_metadata: { stale: true } }, undefined, {
      kind: "turn",
    }),
    { input: [] },
  );
});

test("omits a prewarm start timestamp when the startup turn has not begun", () => {
  const payload = withCodexRequestMetadata({ input: [] }, "session-1", { kind: "prewarm" }, "", {
    installationId: "11111111-1111-4111-8111-111111111111",
    threadSource: "user",
    sandbox: "none",
  });
  const metadata = requireJsonRecord(payload["client_metadata"]);
  assert.equal(metadata["turn_id"], "");
  const turn = requireJsonRecord(
    JSON.parse(requireString(metadata[CODEX_TURN_METADATA_HEADER], "turn metadata")),
  );
  assert.equal(turn["turn_id"], "");
  assert.equal(turn["request_kind"], "prewarm");
  assert.equal(turn["turn_started_at_unix_ms"], undefined);
});
