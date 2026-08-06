import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodexMetadataHeaders,
  CODEX_TURN_METADATA_HEADER,
  withCodexRequestMetadata,
} from "../extensions/openai-codex-compat/codex-metadata.ts";

void test("adds Codex session, thread, turn, and request-kind metadata", () => {
  const payload = withCodexRequestMetadata(
    { input: [], client_metadata: { retained: "value" } },
    "session-1",
    "turn",
  );
  const candidate = payload["client_metadata"];
  assert.ok(candidate && typeof candidate === "object" && !Array.isArray(candidate));
  const metadata = candidate as Record<string, unknown>;
  assert.equal(metadata["retained"], "value");
  assert.equal(metadata["session_id"], "session-1");
  assert.equal(metadata["thread_id"], "session-1");
  assert.equal(typeof metadata["turn_id"], "string");

  const turn = JSON.parse(String(metadata[CODEX_TURN_METADATA_HEADER])) as Record<string, unknown>;
  assert.equal(turn["session_id"], "session-1");
  assert.equal(turn["thread_id"], "session-1");
  assert.equal(turn["turn_id"], metadata["turn_id"]);
  assert.equal(turn["request_kind"], "turn");

  const headers = new Headers();
  applyCodexMetadataHeaders(headers, payload);
  assert.equal(headers.get("thread-id"), "session-1");
  assert.equal(headers.get(CODEX_TURN_METADATA_HEADER), metadata[CODEX_TURN_METADATA_HEADER]);
});

void test("omits Codex metadata without session affinity", () => {
  assert.deepEqual(
    withCodexRequestMetadata({ input: [], client_metadata: { stale: true } }, undefined, "turn"),
    { input: [] },
  );
});
