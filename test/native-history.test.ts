import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  nativeCommittedPrefixBeforeOverflow,
  nativeResponseData,
  nativeResponseOverrides,
  NATIVE_RESPONSE_ENTRY_TYPE,
  parseNativeResponse,
} from "../extensions/openai-codex-compat/native-history.ts";

test("persists native response overrides on the active session branch", () => {
  const data = nativeResponseData("gpt-test", "resp_1", [
    { type: "web_search_call", id: "ws_1", status: "completed" },
  ]);
  const branch = [
    {
      type: "custom",
      id: "native-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data,
    },
  ] satisfies SessionEntry[];

  assert.deepEqual(parseNativeResponse(data), data);
  assert.deepEqual(nativeResponseOverrides(branch, "gpt-test").get("resp_1"), data.items);
  assert.equal(nativeResponseOverrides(branch, "other-model").size, 0);
});

test("fails closed on corrupt native response entries", () => {
  const branch = [
    {
      type: "custom",
      id: "native-corrupt",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data: { kind: NATIVE_RESPONSE_ENTRY_TYPE, version: 1 },
    },
  ] satisfies SessionEntry[];

  assert.throws(() => nativeResponseOverrides(branch, "gpt-test"), /corrupt/);
});

test("recovers only done prefixes with linked tool outputs before overflow", () => {
  const attempts = [
    {
      itemCount: 1,
      terminalType: "response.incomplete" as const,
      terminalReason: "max_output_tokens",
    },
    {
      itemCount: 0,
      terminalType: "response.failed" as const,
      terminalReason: "context_length_exceeded",
    },
  ];
  const committed = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "progress" }],
  };
  const safeBranch = [
    {
      type: "custom",
      id: "native-safe",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data: nativeResponseData("gpt-test", "resp_safe", [committed], attempts),
    },
  ] satisfies SessionEntry[];

  assert.deepEqual(nativeCommittedPrefixBeforeOverflow(safeBranch, "gpt-test", "resp_safe"), [
    committed,
  ]);

  const unresolvedCall = {
    type: "function_call",
    id: "call_item",
    call_id: "call_1",
    name: "read",
    arguments: "{}",
  };
  const unsafeBranch = [
    {
      type: "custom",
      id: "native-unsafe",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data: nativeResponseData("gpt-test", "resp_unsafe", [unresolvedCall], attempts),
    },
  ] satisfies SessionEntry[];
  assert.equal(
    nativeCommittedPrefixBeforeOverflow(unsafeBranch, "gpt-test", "resp_unsafe"),
    undefined,
  );

  const legacyBranch = [
    {
      type: "custom",
      id: "native-legacy",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data: {
        kind: NATIVE_RESPONSE_ENTRY_TYPE,
        version: 1,
        modelId: "gpt-test",
        responseId: "resp_legacy",
        items: [committed],
      },
    },
  ] satisfies SessionEntry[];
  assert.equal(
    nativeCommittedPrefixBeforeOverflow(legacyBranch, "gpt-test", "resp_legacy"),
    undefined,
  );
});
