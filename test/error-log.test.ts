import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, errorLog, redact } from "./support/error-log.ts";

test("failed responses are summarized without provider error text", () => {
  const summary = describeFailure({
    role: "assistant",
    stopReason: "error",
    errorMessage: '529 {"type":"overloaded_error","message":"Overloaded","echo":"SECRET-PROMPT"}',
  });
  assert.deepEqual(JSON.parse(summary), {
    stopReason: "error",
    httpStatus: "529",
    categories: ["overloaded"],
  });
  assert.doesNotMatch(summary, /SECRET-PROMPT/);
});

test("credential-like values are removed and long text is bounded", () => {
  const text = redact(
    `failed: Bearer abc.def sk-${"a".repeat(20)} eyJhbGci.eyJzdWIi.c2ln ${"Z".repeat(48)} /tmp/a/b.ts`,
  );
  assert.equal(text, "failed: [redacted] [redacted] [redacted] [redacted] /tmp/a/b.ts");
  assert.equal(redact("x".repeat(5) + " ".repeat(2000)).length, 1001);
});

test("the live-test error log reports every error and warning it receives", (t) => {
  const reported: string[] = [];
  t.mock.method(t, "diagnostic", (message: string) => {
    reported.push(message);
  });
  const log = errorLog(t);
  log.notice("Compaction stopped: request failed (HTTP 529).", "error");
  log.notice("Summarized the full history.", "warning");
  log.notice("Settings saved.", "info");
  log.rpcEvent({
    type: "extension_ui_request",
    method: "notify",
    message: "Native compaction failed.",
    notifyType: "error",
  });
  log.rpcEvent({ type: "extension_error", event: "session_before_compact", error: "Boom" });
  log.rpcEvent({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "500 SECRET" },
  });
  log.rpcEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  log.printRun("Extension error (/ext.ts): Bad state\n500 SECRET provider body\n", [
    { role: "user", content: "Hi" },
    { role: "assistant", stopReason: "length", errorMessage: "SECRET" },
  ]);
  assert.deepEqual(reported, [
    "Extension error: Compaction stopped: request failed (HTTP 529).",
    "Extension warning: Summarized the full history.",
    "Extension error: Native compaction failed.",
    "Extension error in session_before_compact: Boom",
    'Failed response: {"stopReason":"error","httpStatus":"500","categories":[]}',
    "Extension error (/ext.ts): Bad state",
    'Failed response: {"stopReason":"length","categories":[]}',
  ]);
});
