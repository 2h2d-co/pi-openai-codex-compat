import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
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

test("derives complete instructions and tool placement from normalized Pi transcripts", async () => {
  for (const modelId of ["gpt-test", "gpt-5.6-sol"]) {
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
      const harness = createHarness(entries(messages), { ...DEFAULT_CONFIG, responsesLite: true });
      const model = {
        ...codexModel(modelId),
        compat: { supportsAdditionalTools: true, supportsOpenAIGrammarTools: true },
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
      assert.equal(ordinary.instructions, getCurrentSystemPrompt(context.messages));
      assert.doesNotMatch(
        JSON.stringify(ordinary.input),
        /old rules|current rules|\/old|forced current prompt/,
      );
      const declarations = requireJsonRecords(ordinary.tools);
      const history = requireJsonRecords(ordinary.input);
      assert.equal(
        history.filter((item) => item.type === "additional_tools").length,
        change === "addition" ? 1 : 0,
      );
      assert.deepEqual(
        declarations.map((tool) => tool.name),
        change === "addition"
          ? [REPORT_TOOL.name]
          : getCurrentTools(context.messages).map((tool) => tool.name),
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

test("rebases tools before percentage compaction and retains the unsampled user input", async () => {
  const messages: Message[] = [
    initial,
    { role: "user", content: "old request", timestamp: 1 },
    assistantEntry("assistant", "user", "old reply").message,
    update,
    { role: "user", content: "unsampled request", timestamp: 4 },
  ];
  const harness = createHarness(entries(messages), { ...DEFAULT_CONFIG, autoCompactAtPercent: 80 });
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
        compat: { supportsAdditionalTools: true, supportsOpenAIGrammarTools: true },
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
  for (const request of requests) {
    assert.equal(request.instructions, "current rules");
    assert.deepEqual(
      requireJsonRecords(request.tools).map((tool) => tool.name),
      [REPORT_TOOL.name, SAMPLE_GRAMMAR_TOOL.name],
    );
    assert.equal(
      requireJsonRecords(request.input).some((item) => item.type === "additional_tools"),
      false,
    );
  }
  assert.doesNotMatch(JSON.stringify(requests[0]?.input), /unsampled request/);
  assert.match(JSON.stringify(requests[1]?.input), /unsampled request/);
  assert.match(JSON.stringify(requests[1]?.input), /opaque-state/);
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
      allTools: [],
      anchorsToolAdditions: false,
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
    allTools: [],
  });
  assert.equal(addition.at(-1)?.type, "additional_tools");
  assert.equal(requireJsonRecords(requireJsonRecord(addition.at(-1))["tools"])[0]?.name, "extra");
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
    allTools: [],
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
  const result = await runtime
    .streamSimple(
      model,
      normalizeContext({
        messages: convertToLlm(resumed.buildSessionContext().messages),
      }),
      { apiKey: accessToken(), sessionId: resumed.getSessionId(), transport: "sse" },
    )
    .result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(request);
  assert.equal(request.instructions, "resumed rules");
  assert.deepEqual(
    requireJsonRecords(request.tools).map((tool) => tool.name),
    [SAMPLE_GRAMMAR_TOOL.name],
  );
  assert.match(JSON.stringify(request.input), /saved-state|after compaction/);
  assert.doesNotMatch(
    JSON.stringify(request.input),
    /old rules|current rules|resumed rules|hidden marker|additional_tools/,
  );
});
