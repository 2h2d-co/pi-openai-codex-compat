import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  nativeResponseData,
  nativeResponseOverrides,
  NATIVE_RESPONSE_ENTRY_TYPE,
  parseNativeResponse,
} from "../extensions/openai-codex-compat/native-history.ts";

void test("persists native response overrides on the active session branch", () => {
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
  ] as SessionEntry[];

  assert.deepEqual(parseNativeResponse(data), data);
  assert.deepEqual(nativeResponseOverrides(branch, "gpt-test").get("resp_1"), data.items);
  assert.equal(nativeResponseOverrides(branch, "other-model").size, 0);
});

void test("fails closed on corrupt native response entries", () => {
  const branch = [
    {
      type: "custom",
      id: "native-corrupt",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: NATIVE_RESPONSE_ENTRY_TYPE,
      data: { kind: NATIVE_RESPONSE_ENTRY_TYPE, version: 1 },
    },
  ] as SessionEntry[];

  assert.throws(() => nativeResponseOverrides(branch, "gpt-test"), /corrupt/);
});
