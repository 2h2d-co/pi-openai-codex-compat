import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  normalizeContext,
  renderSystemMessageUpdate,
  type Message,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { CodexProviderRuntime } from "../extensions/openai-codex-compat/codex-provider.ts";
import {
  checkpointData,
  providerHistory,
} from "../extensions/openai-codex-compat/compaction-checkpoint.ts";
import {
  requireJsonRecord,
  requireJsonRecords,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import {
  NATIVE_RESPONSE_ENTRY_TYPE,
  nativeResponseData,
} from "../extensions/openai-codex-compat/native-history.ts";
import type { ResponsesOutputMessageItem } from "../extensions/openai-codex-compat/responses-item-schema.ts";
import {
  accessToken,
  assistantEntry,
  codexModel,
  compactionEvents,
  createHarness,
  DEFAULT_CONFIG,
  REPORT_TOOL,
  SAMPLE_GRAMMAR_TOOL,
  textEvents,
  type JsonRecord,
} from "./codex-provider/codex-provider-harness.ts";

const initial: SystemMessage = {
  role: "system",
  content: "",
  sections: { rules: "old rules", cwd: "/old" },
  toolsAdded: [REPORT_TOOL],
  timestamp: 0,
};
const update: SystemMessage = {
  role: "system",
  content: "",
  sections: { rules: "current rules", cwd: null },
  toolsAdded: [SAMPLE_GRAMMAR_TOOL],
  timestamp: 3,
};

function entries(messages: Message[]): SessionEntry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    timestamp: new Date(index).toISOString(),
    message,
  }));
}

test("derives instructions, inline prompt updates, and tool placement from Pi transcripts", async () => {
  for (const modelId of ["gpt-test", "gpt-5.6-sol"]) {
    for (const supportsMidConvoSystemMessages of [false, true]) {
      for (const change of ["addition", "removal", "redefinition", "forced"] as const) {
        const messages: Message[] = [
          initial,
          { role: "user", content: "first request", timestamp: 1 },
          assistantEntry("assistant", "user", "first reply").message,
          update,
          { role: "user", content: "next request", timestamp: 4 },
        ];
        if (change === "removal") {
          messages.push({
            role: "system",
            content: "",
            toolsRemoved: [{ name: REPORT_TOOL.name }],
            timestamp: 5,
          });
        } else if (change === "redefinition") {
          messages.push({
            role: "system",
            content: "",
            toolsAdded: [{ ...REPORT_TOOL, description: "New report" }],
            timestamp: 5,
          });
        }
        const context = normalizeContext({
          messages:
            change === "forced"
              ? [
                  {
                    role: "system",
                    content: "forced current prompt",
                    toolsAdded: getCurrentTools(messages),
                    timestamp: 0,
                  },
                  ...messages.filter((message) => message.role !== "system"),
                ]
              : messages,
        });
        const original = structuredClone(context);
        const harness = createHarness(entries(messages), {
          ...DEFAULT_CONFIG,
          responsesLite: true,
        });
        const model = {
          ...codexModel(modelId),
          compat: {
            supportsAdditionalTools: true,
            supportsOpenAIGrammarTools: true,
            supportsMidConvoSystemMessages,
          },
        };
        let ordinary: JsonRecord | undefined;
        let wire: JsonRecord | undefined;
        harness.runtime.transport.request = async function* (_model, body) {
          wire = structuredClone(requireJsonRecord(body));
          yield* textEvents("done");
        };
        const result = await harness.runtime
          .streamSimple(model, context, {
            apiKey: accessToken(),
            sessionId: "session-1",
            transport: "sse",
            onPayload(body) {
              ordinary = structuredClone(requireJsonRecord(body));
            },
          })
          .result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.ok(ordinary);
        assert.ok(wire);
        const history = requireJsonRecords(ordinary.input);
        const inlineUpdates = history.filter((item) => item.role === "developer");
        const leading = getInitialSystemMessage(context.messages);
        assert.ok(leading);
        if (supportsMidConvoSystemMessages) {
          // The leading system message is the prompt (a forced prompt projects
          // it whole); later system messages on the branch become inline
          // developer items exactly as Pi AI renders them.
          assert.equal(
            ordinary.instructions,
            change === "forced" ? "forced current prompt" : getSystemMessageText(leading),
          );
          assert.deepEqual(
            inlineUpdates.map((item) => item.content),
            messages
              .slice(1)
              .filter((message) => message.role === "system")
              .map((message) => renderSystemMessageUpdate(message))
              .filter((text) => text.length > 0),
          );
          assert.match(JSON.stringify(inlineUpdates), /current rules/);
          assert.doesNotMatch(JSON.stringify(inlineUpdates), /old rules|\/old/);
        } else {
          // Without mid-conversation support every system message collapses
          // into the leading prompt.
          assert.equal(ordinary.instructions, getCurrentSystemPrompt(context.messages));
          assert.deepEqual(inlineUpdates, []);
        }
        assert.doesNotMatch(JSON.stringify(history), /forced current prompt/);
        const declarations = requireJsonRecords(ordinary.tools);
        assert.equal(
          history.some(
            (item) =>
              item.type === "additional_tools" ||
              item.type === "tool_search_call" ||
              item.type === "tool_search_output",
          ),
          false,
        );
        assert.deepEqual(
          declarations.map((tool) => tool.name),
          getCurrentTools(context.messages).map((tool) => tool.name),
        );
        if (change === "redefinition") assert.equal(declarations[0]?.["description"], "New report");
        if (modelId === "gpt-5.6-sol") {
          assert.equal(wire.instructions, undefined);
          assert.deepEqual(requireJsonRecords(wire.input)[1]?.content, [
            { type: "input_text", text: ordinary.instructions },
          ]);
        } else {
          assert.equal(wire.instructions, ordinary.instructions);
        }
        assert.deepEqual(context, original);
      }
    }
  }
});

test("matches Pi 0.86 reasoning Off defaults and null mappings", async () => {
  for (const off of [undefined, "minimal", null] as const) {
    for (const reasoningEffort of [undefined, "none"] as const) {
      const harness = createHarness([]);
      const model = {
        ...codexModel(),
        ...(off === undefined ? {} : { thinkingLevelMap: { off } }),
      };
      let request: JsonRecord | undefined;
      harness.runtime.transport.request = async function* (_model, body) {
        request = requireJsonRecord(body);
        yield* textEvents("done");
      };
      const result = await harness.runtime
        .stream(model, normalizeContext({ messages: [] }), {
          apiKey: accessToken(),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
        .result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.ok(request);
      assert.deepEqual(
        request["reasoning"],
        off === null
          ? undefined
          : {
              effort: off ?? "none",
              ...(reasoningEffort === undefined ? {} : { summary: "auto" }),
            },
      );
    }
  }
});

test("declares current tools before percentage compaction and retains prompt updates with the unsampled user input", async () => {
  for (const supportsMidConvoSystemMessages of [false, true]) {
    const messages: Message[] = [
      initial,
      { role: "user", content: "old request", timestamp: 1 },
      assistantEntry("assistant", "user", "old reply").message,
      update,
      { role: "user", content: "unsampled request", timestamp: 4 },
    ];
    const harness = createHarness(entries(messages), {
      ...DEFAULT_CONFIG,
      autoCompactAtPercent: 80,
    });
    const requests: JsonRecord[] = [];
    harness.runtime.transport.request = async function* (_model, body) {
      requests.push(structuredClone(requireJsonRecord(body)));
      if (requests.length === 1) yield* compactionEvents();
      else yield* textEvents("continued");
    };
    const result = await harness.runtime
      .streamSimple(
        {
          ...codexModel(),
          compat: {
            supportsAdditionalTools: true,
            supportsOpenAIGrammarTools: true,
            supportsMidConvoSystemMessages,
          },
        },
        normalizeContext({ messages }),
        {
          apiKey: accessToken(),
          sessionId: "session-1",
          transport: "sse",
        },
      )
      .result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests.length, 2);
    const promptUpdate = renderSystemMessageUpdate(update);
    for (const request of requests) {
      assert.equal(
        request.instructions,
        supportsMidConvoSystemMessages ? "old rules\n\n/old" : "current rules",
      );
      assert.deepEqual(
        requireJsonRecords(request.tools).map((tool) => tool.name),
        [REPORT_TOOL.name, SAMPLE_GRAMMAR_TOOL.name],
      );
      const input = requireJsonRecords(request.input);
      assert.equal(
        input.some((item) => item.type === "additional_tools"),
        false,
      );
      // The prompt update precedes the compaction trigger and survives the
      // checkpoint's retained-context selection.
      assert.deepEqual(
        input.filter((item) => item.role === "developer").map((item) => item.content),
        supportsMidConvoSystemMessages ? [promptUpdate] : [],
      );
    }
    assert.doesNotMatch(JSON.stringify(requests[0]?.input), /unsampled request/);
    assert.match(JSON.stringify(requests[1]?.input), /unsampled request/);
    assert.match(JSON.stringify(requests[1]?.input), /opaque-state/);
  }
});

test("declares the complete current tool set on every request after a checkpoint in the same process", async () => {
  for (const leadingDeclaration of [true, false]) {
    for (const laterChange of ["none", "addition", "removal"] as const) {
      const messages: Message[] = [
        ...(leadingDeclaration ? [initial] : []),
        { role: "user", content: "old request", timestamp: 1 },
        assistantEntry("assistant", "user", "old reply").message,
        update,
        { role: "user", content: "compacted request", timestamp: 4 },
      ];
      const harness = createHarness(entries(messages), {
        ...DEFAULT_CONFIG,
        autoCompactAtPercent: 80,
      });
      const model = {
        ...codexModel(),
        compat: {
          supportsAdditionalTools: true,
          supportsToolSearch: true,
          supportsOpenAIGrammarTools: true,
        },
      };
      const requests: JsonRecord[] = [];
      harness.runtime.transport.request = async function* (_model, body) {
        requests.push(structuredClone(requireJsonRecord(body)));
        if (requests.length === 1) yield* compactionEvents();
        else yield* textEvents("done");
      };
      const options = { apiKey: accessToken(), sessionId: "session-1", transport: "sse" as const };
      const reply = await harness.runtime
        .streamSimple(model, normalizeContext({ messages }), options)
        .result();
      assert.equal(reply.stopReason, "stop", reply.errorMessage);
      assert.equal(requests.length, 2);

      // Pi persists the reply, any tool change, and the next prompt, but a
      // provider-boundary checkpoint does not rebuild its in-memory transcript.
      const extra = { ...REPORT_TOOL, name: "extra" };
      const change: Message | undefined =
        laterChange === "addition"
          ? { role: "system", content: "", toolsAdded: [extra], timestamp: 5 }
          : laterChange === "removal"
            ? {
                role: "system",
                content: "",
                toolsRemoved: [{ name: SAMPLE_GRAMMAR_TOOL.name }],
                timestamp: 5,
              }
            : undefined;
      const next: Message = { role: "user", content: "next request", timestamp: 6 };
      const branch = harness.branch();
      const appended: Message[] = [reply, ...(change ? [change] : []), next];
      for (const [index, message] of appended.entries()) {
        branch.push({
          type: "message",
          id: `tail-${String(index)}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date(5 + index).toISOString(),
          message,
        });
      }
      harness.runtime.captureScope({
        ...harness.extensionContext,
        getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
      });
      const stale = normalizeContext({ messages: [...messages, ...appended] });
      const result = await harness.runtime.streamSimple(model, stale, options).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(requests.length, 3);
      const request = requests[2];
      assert.ok(request);
      assert.deepEqual(
        requireJsonRecords(request.tools).map((tool) => tool.name),
        getCurrentTools(stale.messages).map((tool) => tool.name),
      );
      const input = requireJsonRecords(request.input);
      assert.equal(
        input.some(
          (item) =>
            item.type === "additional_tools" ||
            item.type === "tool_search_call" ||
            item.type === "tool_search_output",
        ),
        false,
      );
      assert.match(JSON.stringify(input), /opaque-state/);
      assert.match(JSON.stringify(input), /next request/);
      assert.doesNotMatch(JSON.stringify(input), /old reply/);
    }
  }
});

test("restores checkpoint system snapshots and post-checkpoint tool changes after resume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-transcript-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage(initial);
  const firstUser = manager.appendMessage({
    role: "user",
    content: "before compaction",
    timestamp: 1,
  });
  manager.appendMessage(assistantEntry("assistant", firstUser, "old reply").message);
  manager.appendMessage(update);
  const model = {
    ...codexModel(),
    compat: { supportsAdditionalTools: true, supportsOpenAIGrammarTools: true },
  };
  const checkpoint = checkpointData(
    model.id,
    providerHistory({
      branch: manager.getBranch(),
      wireModel: model,
    }),
    { type: "compaction", encrypted_content: "saved-state" },
  );
  const checkpointId = manager.appendCompaction(
    "hidden marker",
    firstUser,
    1_000,
    checkpoint,
    true,
  );
  const checkpointEntry = manager.getEntry(checkpointId);
  assert.ok(checkpointEntry?.type === "compaction" && checkpointEntry.systemMessage);
  assert.equal(getCurrentSystemPrompt([checkpointEntry.systemMessage]), "current rules");
  assert.deepEqual(
    getCurrentTools([checkpointEntry.systemMessage]).map((tool) => tool.name),
    [REPORT_TOOL.name, SAMPLE_GRAMMAR_TOOL.name],
  );
  const tailSystem: SystemMessage = {
    role: "system",
    content: "",
    toolsAdded: [{ ...REPORT_TOOL, name: "extra" }],
    timestamp: 5,
  };
  const addition = providerHistory({
    branch: [
      ...manager.getBranch(),
      {
        type: "message",
        id: "tail-update",
        parentId: checkpointId,
        timestamp: new Date(5).toISOString(),
        message: tailSystem,
      },
    ],
    wireModel: model,
  });
  assert.equal(
    addition.some((item) => item.type === "additional_tools"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(addition), /"extra"/);
  const redeclaration = providerHistory({
    branch: [
      ...manager.getBranch(),
      {
        type: "message",
        id: "tail-update",
        parentId: checkpointId,
        timestamp: new Date(5).toISOString(),
        message: { ...tailSystem, toolsAdded: [REPORT_TOOL] },
      },
    ],
    wireModel: model,
  });
  assert.equal(
    redeclaration.some((item) => item.type === "additional_tools"),
    false,
  );
  manager.appendMessage({
    role: "system",
    content: "",
    sections: { rules: "resumed rules" },
    toolsRemoved: [{ name: REPORT_TOOL.name }],
    timestamp: 5,
  });
  manager.appendMessage({ role: "user", content: "after compaction", timestamp: 6 });
  const file = manager.getSessionFile();
  assert.ok(file);
  const resumed = SessionManager.open(file);
  const runtime = new CodexProviderRuntime(
    {
      getAllTools: () => [],
      appendEntry: (type, data) => {
        resumed.appendCustomEntry(type, data);
      },
    },
    () => DEFAULT_CONFIG,
    "test-installation",
  );
  runtime.captureScope({
    cwd: directory,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: resumed,
    getContextUsage: () => undefined,
    ui: { notify() {} },
  });
  let request: JsonRecord | undefined;
  runtime.transport.request = async function* (_model, body) {
    request = requireJsonRecord(body);
    yield* textEvents("done");
  };
  for (const supportsMidConvoSystemMessages of [false, true]) {
    const result = await runtime
      .streamSimple(
        { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages } },
        normalizeContext({
          messages: convertToLlm(resumed.buildSessionContext().messages),
        }),
        { apiKey: accessToken(), sessionId: resumed.getSessionId(), transport: "sse" },
      )
      .result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.ok(request);
    // Pi's rebuilt transcript leads with the checkpoint snapshot. A model that
    // accepts mid-conversation system messages receives the post-checkpoint
    // update inline; any other model receives it collapsed into `instructions`.
    assert.equal(
      request.instructions,
      supportsMidConvoSystemMessages ? "current rules" : "resumed rules",
    );
    assert.deepEqual(
      requireJsonRecords(request.tools).map((tool) => tool.name),
      [SAMPLE_GRAMMAR_TOOL.name],
    );
    const input = requireJsonRecords(request.input);
    assert.match(JSON.stringify(input), /saved-state|after compaction/);
    assert.deepEqual(
      input.filter((item) => item.role === "developer").map((item) => item.content),
      supportsMidConvoSystemMessages
        ? ['Updated system prompt section "rules":\n\nresumed rules']
        : [],
    );
    assert.doesNotMatch(
      JSON.stringify(input),
      /old rules|current rules|hidden marker|additional_tools/,
    );
  }
});

/**
 * Build the branch Pi 0.87 leaves behind when it selects the latest attempt for
 * overflow or length recovery. Earlier edits model unrelated context work: a
 * large tool output replaced by a placeholder, an omitted first reply, and a
 * chained edit whose latest replacement wins. Pi then omits the selected
 * attempt and its tool results through `context_edit` entries before it runs
 * `session_before_compact`.
 */
function recoveryBranch(attempt: "length" | "error"): {
  branch: SessionEntry[];
  failedResponseId: string;
} {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage(initial);
  const firstUser = manager.appendMessage({ role: "user", content: "first task", timestamp: 1 });
  const firstReply = manager.appendMessage(
    assistantEntry("first-reply", firstUser, "first reply").message,
  );
  const toolUser = manager.appendMessage({ role: "user", content: "tool task", timestamp: 2 });
  manager.appendMessage({
    ...assistantEntry("tool-reply", toolUser, "calling").message,
    content: [
      { type: "text", text: "calling" },
      { type: "toolCall", id: "call-1", name: REPORT_TOOL.name, arguments: { value: "one" } },
    ],
    stopReason: "toolUse",
  });
  const largeOutput = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: REPORT_TOOL.name,
    content: [{ type: "text", text: "LARGE-OUTPUT-ONE" }],
    isError: false,
    timestamp: 3,
  });
  // Unrelated earlier edits: the first reply is omitted entirely and the large
  // output shrinks twice (the latest replacement wins).
  manager.appendContextEdit(firstReply, null);
  manager.appendContextEdit(largeOutput, { content: "first placeholder" });
  manager.appendContextEdit(largeOutput, { content: "[output elided]" });
  const secondUser = manager.appendMessage({ role: "user", content: "second task", timestamp: 4 });
  const truncated = manager.appendMessage({
    ...assistantEntry("truncated", secondUser, "committed progress").message,
    content: [
      { type: "text", text: "committed progress" },
      { type: "toolCall", id: "call-2", name: REPORT_TOOL.name, arguments: { value: "two" } },
    ],
    stopReason: "length",
  });
  const partialResult = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-2",
    toolName: REPORT_TOOL.name,
    content: [{ type: "text", text: "partial result" }],
    isError: false,
    timestamp: 5,
  });
  let failedResponseId = "";
  if (attempt === "length") {
    manager.appendContextEdit(truncated, null);
    manager.appendContextEdit(partialResult, null);
  } else {
    const failed = manager.appendMessage({
      ...assistantEntry("failed", partialResult, "").message,
      content: [],
      stopReason: "error",
      errorMessage: "context_length_exceeded",
    });
    failedResponseId = "resp_failed";
    manager.appendContextEdit(failed, null);
  }
  return { branch: manager.getBranch(), failedResponseId };
}

test("honours Pi 0.87 context edits and recovers only the omitted latest attempt", () => {
  const model = codexModel();
  const { branch } = recoveryBranch("length");

  const ordinary = JSON.stringify(providerHistory({ branch, wireModel: model }));
  assert.match(ordinary, /first task/);
  assert.match(ordinary, /\[output elided\]/);
  assert.doesNotMatch(ordinary, /LARGE-OUTPUT-ONE|first placeholder|"text":"first reply"/);
  assert.match(ordinary, /second task/);
  assert.doesNotMatch(ordinary, /committed progress|partial result/);

  const recovery = providerHistory({ branch, wireModel: model, recoverLatestOverflowPrefix: true });
  const serialized = JSON.stringify(recovery);
  // Unrelated earlier omissions and replacements stay in force.
  assert.match(serialized, /first task/);
  assert.match(serialized, /\[output elided\]/);
  assert.doesNotMatch(serialized, /LARGE-OUTPUT-ONE|first placeholder|"text":"first reply"/);
  // The truncated boundary and its tool results are committed progress.
  assert.match(serialized, /second task/);
  assert.match(serialized, /committed progress/);
  assert.match(serialized, /partial result/);
  assert.deepEqual(
    recovery.map((item) => ("role" in item ? item.role : item.type)),
    [
      "user",
      "user",
      "assistant",
      "function_call",
      "function_call_output",
      "user",
      "assistant",
      "function_call",
      "function_call_output",
    ],
  );
});

test("recovers only the native prefix of a failed attempt and keeps earlier edits", () => {
  const model = codexModel();
  const { branch, failedResponseId } = recoveryBranch("error");
  const committed: ResponsesOutputMessageItem = {
    type: "message",
    id: "msg_committed",
    role: "assistant",
    content: [{ type: "output_text", text: "native committed prefix" }],
  };
  branch.push({
    type: "custom",
    id: "native-failed",
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    customType: NATIVE_RESPONSE_ENTRY_TYPE,
    data: nativeResponseData(
      model.id,
      failedResponseId,
      [committed],
      [
        { itemCount: 1, terminalType: "response.incomplete", terminalReason: "max_output_tokens" },
        {
          itemCount: 0,
          terminalType: "response.failed",
          terminalReason: "context_length_exceeded",
        },
      ],
    ),
  });

  const recovery = providerHistory({ branch, wireModel: model, recoverLatestOverflowPrefix: true });
  const serialized = JSON.stringify(recovery);
  assert.match(serialized, /\[output elided\]/);
  assert.doesNotMatch(serialized, /LARGE-OUTPUT-ONE|"text":"first reply"|context_length_exceeded/);
  // The truncated attempt before the failed retry was never omitted, so it stays.
  assert.match(serialized, /committed progress/);
  assert.match(serialized, /partial result/);
  assert.deepEqual(recovery.at(-1), committed);
});

test("applies edits in a checkpoint tail and recovers only the omitted attempt after it", () => {
  const model = codexModel();
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage(initial);
  const before = manager.appendMessage({
    role: "user",
    content: "before checkpoint",
    timestamp: 1,
  });
  manager.appendMessage(assistantEntry("before-reply", before, "old reply").message);
  const checkpoint = checkpointData(
    model.id,
    [{ type: "message", role: "user", content: [{ type: "input_text", text: "saved-state" }] }],
    { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" },
  );
  manager.appendCompaction("checkpoint", before, 1, checkpoint, true);
  const tailUser = manager.appendMessage({ role: "user", content: "tail task", timestamp: 2 });
  const tailReply = manager.appendMessage(
    assistantEntry("tail-reply", tailUser, "tail reply").message,
  );
  manager.appendContextEdit(tailReply, { content: "edited tail reply" });
  const nextUser = manager.appendMessage({ role: "user", content: "next task", timestamp: 3 });
  const truncated = manager.appendMessage({
    ...assistantEntry("tail-truncated", nextUser, "tail progress").message,
    stopReason: "length",
  });
  manager.appendContextEdit(truncated, null);
  const branch = manager.getBranch();

  const ordinary = JSON.stringify(providerHistory({ branch, wireModel: model }));
  assert.match(ordinary, /saved-state/);
  assert.match(ordinary, /edited tail reply/);
  assert.doesNotMatch(ordinary, /old reply|"text":"tail reply"|tail progress/);

  const recovery = JSON.stringify(
    providerHistory({ branch, wireModel: model, recoverLatestOverflowPrefix: true }),
  );
  assert.match(recovery, /saved-state/);
  assert.match(recovery, /edited tail reply/);
  assert.match(recovery, /tail progress/);
  assert.doesNotMatch(recovery, /old reply|"text":"tail reply"/);
});

test("recovery without a Pi omission of the latest attempt changes nothing", () => {
  const model = codexModel();
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage(initial);
  const user = manager.appendMessage({ role: "user", content: "only task", timestamp: 1 });
  const reply = manager.appendMessage(assistantEntry("reply", user, "only reply").message);
  manager.appendContextEdit(reply, { content: "replaced reply" });
  const branch = manager.getBranch();
  assert.deepEqual(
    providerHistory({ branch, wireModel: model, recoverLatestOverflowPrefix: true }),
    providerHistory({ branch, wireModel: model }),
  );
  assert.match(JSON.stringify(providerHistory({ branch, wireModel: model })), /replaced reply/);
});

test("a tool-result omission alone does not identify an omitted recovery attempt", () => {
  const manager = SessionManager.inMemory("/tmp");
  const model = codexModel();
  manager.appendMessage(initial);
  const user = manager.appendMessage({ role: "user", content: "tool task", timestamp: 1 });
  manager.appendMessage({
    ...assistantEntry("tool-reply", user, "").message,
    content: [
      { type: "toolCall", id: "call-only", name: REPORT_TOOL.name, arguments: { value: "one" } },
    ],
    stopReason: "toolUse",
  });
  const result = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-only",
    toolName: REPORT_TOOL.name,
    content: [{ type: "text", text: "OMITTED_TOOL_RESULT" }],
    isError: false,
    timestamp: 2,
  });
  manager.appendContextEdit(result, null);
  const branch = manager.getBranch();
  const ordinary = providerHistory({ branch, wireModel: model });
  const recovery = providerHistory({ branch, wireModel: model, recoverLatestOverflowPrefix: true });
  assert.deepEqual(recovery, ordinary);
  assert.doesNotMatch(JSON.stringify(recovery), /OMITTED_TOOL_RESULT/);
});
