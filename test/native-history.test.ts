import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  checkpointData,
  providerHistory,
} from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import { assistantEntry, codexModel } from "./codex-provider/codex-provider-harness.ts";
import {
  nativeCommittedPrefixBeforeOverflow,
  nativeResponseData,
  nativeResponseOverrides,
  NATIVE_RESPONSE_ENTRY_TYPE,
  parseNativeResponse,
} from "../extensions/openai-codex-compat/native-history.ts";
import type {
  ResponsesFunctionCallItem,
  ResponsesOutputMessageItem,
} from "../extensions/openai-codex-compat/responses-item-schema.ts";

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
  assert.equal(
    parseNativeResponse({
      kind: NATIVE_RESPONSE_ENTRY_TYPE,
      version: 1,
      modelId: "gpt-test",
      responseId: "resp-unknown",
      items: [{ type: "future_item", payload: "opaque" }],
    }),
    undefined,
  );

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

for (const checkpoint of [false, true]) {
  for (const recovery of [false, true]) {
    for (const replacement of [null, { content: "EDITED_NATIVE" }]) {
      test(`native overrides respect ${replacement ? "replacement" : "omission"} with checkpoint=${checkpoint}, recovery=${recovery}`, () => {
        const manager = SessionManager.inMemory("/tmp");
        const model = codexModel();
        if (checkpoint) {
          manager.appendCompaction(
            "synthetic checkpoint",
            null,
            1,
            checkpointData(model.id, [], {
              type: "compaction",
              encrypted_content: "synthetic",
            }),
            true,
          );
        }
        const user = manager.appendMessage({
          role: "user",
          content: "synthetic request",
          timestamp: 1,
        });
        const responseId = "synthetic-response";
        manager.appendCustomEntry(
          NATIVE_RESPONSE_ENTRY_TYPE,
          nativeResponseData(model.id, responseId, [
            {
              type: "message",
              id: "synthetic-native-item",
              role: "assistant",
              content: [{ type: "output_text", text: "ORIGINAL_NATIVE" }],
            },
          ]),
        );
        const reply = manager.appendMessage({
          ...assistantEntry("reply", user, "CANONICAL_REPLY").message,
          responseId,
        });
        assert.match(
          JSON.stringify(providerHistory({ branch: manager.getBranch(), wireModel: model })),
          /ORIGINAL_NATIVE/,
        );
        manager.appendContextEdit(reply, replacement);
        const failed = manager.appendMessage({
          ...assistantEntry("failed", reply, "").message,
          content: [],
          stopReason: "error",
          errorMessage: "context_length_exceeded",
        });
        manager.appendContextEdit(failed, null);
        const history = JSON.stringify(
          providerHistory({
            branch: manager.getBranch(),
            wireModel: model,
            recoverLatestOverflowPrefix: recovery,
          }),
        );
        assert.doesNotMatch(history, /ORIGINAL_NATIVE|CANONICAL_REPLY/);
        if (replacement) assert.match(history, /EDITED_NATIVE/);
        else assert.doesNotMatch(history, /EDITED_NATIVE/);
      });
    }
  }
}

test("recovers only done prefixes without unresolved tool calls before overflow", () => {
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
  const committed: ResponsesOutputMessageItem = {
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

  const unresolvedCall: ResponsesFunctionCallItem = {
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
