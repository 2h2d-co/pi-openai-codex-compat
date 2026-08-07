import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { codexCacheKey } from "../extensions/openai-codex-compat/codex-cache-key.ts";
import registerCodexThreadLineage, {
  CODEX_THREAD_MARKER_ENTRY_TYPE,
  resolveCodexThreadIdentity,
  type CodexThreadMarkerData,
} from "../extensions/openai-codex-compat/codex-thread-lineage.ts";

function entry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" = "assistant",
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text: id }],
      timestamp: Date.now(),
      ...(role === "assistant"
        ? {
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
          }
        : {}),
    },
  } as SessionEntry;
}

function marker(
  id: string,
  parentId: string | null,
  threadId: string,
  forkedFromThreadId: string,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: CODEX_THREAD_MARKER_ENTRY_TYPE,
    data: {
      version: 1,
      sessionId: "session-1",
      threadId,
      forkedFromThreadId,
      branchParentEntryId: parentId,
    } satisfies CodexThreadMarkerData,
  } as SessionEntry;
}

function createHarness(initialEntries: SessionEntry[], initialLeafId: string | null) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const entries = [...initialEntries];
  let leafId = initialLeafId;

  const branch = (): SessionEntry[] => {
    const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
    const result: SessionEntry[] = [];
    let current = leafId ? byId.get(leafId) : undefined;
    while (current) {
      result.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result.reverse();
  };

  const manager = {
    getSessionId: () => "session-1",
    getEntries: () => [...entries],
    getBranch: branch,
    getLeafId: () => leafId,
  };
  const context = {
    sessionManager: manager,
  } as unknown as ExtensionContext;
  const pi = {
    on(eventName: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      const registered = handlers.get(eventName) ?? [];
      registered.push(handler);
      handlers.set(eventName, registered);
    },
    appendEntry(customType: string, data: CodexThreadMarkerData) {
      const id = `marker-${String(entries.length)}`;
      entries.push({
        type: "custom",
        id,
        parentId: leafId,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } as SessionEntry);
      leafId = id;
    },
  } as unknown as ExtensionAPI;

  registerCodexThreadLineage(pi);
  const emit = async (eventName: string, event: unknown) => {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event, context);
    }
  };
  const appendUser = (id: string) => {
    entries.push(entry(id, leafId, "user"));
    leafId = id;
  };
  return {
    emit,
    entries,
    branch,
    appendUser,
    setLeaf(id: string | null) {
      leafId = id;
    },
  };
}

void test("writes no marker during navigation and makes the finalized user its child", async () => {
  const parent = entry("parent", null);
  const oldUser = entry("old-user", "parent", "user");
  const oldAnswer = entry("old-answer", "old-user");
  const harness = createHarness([parent, oldUser, oldAnswer], "old-answer");

  harness.setLeaf("parent");
  await harness.emit("session_tree", {
    type: "session_tree",
    newLeafId: "parent",
    oldLeafId: "old-answer",
  });
  assert.equal(harness.entries.length, 3);

  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "new", timestamp: Date.now() },
  });
  const storedMarker = harness.entries.at(-1);
  assert.equal(storedMarker?.type, "custom");
  assert.equal(storedMarker?.parentId, "parent");
  assert.equal(
    storedMarker?.type === "custom"
      ? (storedMarker.data as CodexThreadMarkerData).forkedFromThreadId
      : undefined,
    codexCacheKey("session-1"),
  );

  harness.appendUser("new-user");
  assert.equal(harness.entries.at(-1)?.parentId, storedMarker?.id);
  assert.notEqual(
    resolveCodexThreadIdentity("session-1", harness.branch()).threadId,
    codexCacheKey("session-1"),
  );
});

void test("does not mark a linear continuation from an existing leaf", async () => {
  const root = entry("root", null, "user");
  const leaf = entry("leaf", "root");
  const harness = createHarness([root, leaf], "leaf");

  await harness.emit("session_tree", {
    type: "session_tree",
    newLeafId: "leaf",
    oldLeafId: "root",
  });
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "continue", timestamp: Date.now() },
  });

  assert.equal(harness.entries.length, 2);
});

void test("drops unsummarized navigation with Pi's ephemeral leaf on shutdown", async () => {
  const parent = entry("parent", null);
  const oldUser = entry("old-user", "parent", "user");
  const oldAnswer = entry("old-answer", "old-user");
  const harness = createHarness([parent, oldUser, oldAnswer], "old-answer");

  harness.setLeaf("parent");
  await harness.emit("session_tree", {
    type: "session_tree",
    newLeafId: "parent",
    oldLeafId: "old-answer",
  });
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

  harness.setLeaf("old-answer");
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "continue restored leaf", timestamp: Date.now() },
  });

  assert.equal(harness.entries.length, 3);
});

void test("forks from the nearest existing branch thread when editing its first user", async () => {
  const root = entry("root", null);
  const firstMarker = marker("marker-a", "root", "thread-a", codexCacheKey("session-1")!);
  const firstUser = entry("first-user", "marker-a", "user");
  const harness = createHarness([root, firstMarker, firstUser], "first-user");

  harness.setLeaf("marker-a");
  await harness.emit("session_tree", {
    type: "session_tree",
    newLeafId: "marker-a",
    oldLeafId: "first-user",
  });
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "edited", timestamp: Date.now() },
  });

  const secondMarker = harness.entries.at(-1);
  assert.equal(secondMarker?.parentId, "marker-a");
  assert.equal(
    secondMarker?.type === "custom"
      ? (secondMarker.data as CodexThreadMarkerData).forkedFromThreadId
      : undefined,
    "thread-a",
  );
});

void test("restores an unmarked summarized branch without transient tree state", async () => {
  const root = entry("root", null);
  const old = entry("old", "root", "user");
  const summary = {
    type: "branch_summary",
    id: "summary",
    parentId: "root",
    timestamp: new Date().toISOString(),
    fromId: "root",
    summary: "alternate",
  } as SessionEntry;
  const harness = createHarness([root, old, summary], "summary");

  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  await harness.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "resume branch", timestamp: Date.now() },
  });

  const storedMarker = harness.entries.at(-1);
  assert.equal(storedMarker?.type, "custom");
  assert.equal(storedMarker?.parentId, "summary");
});

void test("fails closed on malformed or misplaced active thread markers", () => {
  const root = entry("root", null);
  const malformed = {
    type: "custom",
    id: "bad",
    parentId: "root",
    timestamp: new Date().toISOString(),
    customType: CODEX_THREAD_MARKER_ENTRY_TYPE,
    data: { version: 1 },
  } as SessionEntry;
  assert.throws(
    () => resolveCodexThreadIdentity("session-1", [root, malformed]),
    /invalid OpenAI Codex thread marker/,
  );

  const misplaced = marker("misplaced", "root", "thread", "root-thread") as Extract<
    SessionEntry,
    { type: "custom" }
  >;
  misplaced.data = {
    ...(misplaced.data as CodexThreadMarkerData),
    branchParentEntryId: "different",
  };
  assert.throws(
    () => resolveCodexThreadIdentity("session-1", [root, misplaced]),
    /misplaced OpenAI Codex thread marker/,
  );
});

void test("ignores copied thread markers from a different Pi session", () => {
  const root = entry("root", null);
  const copiedMarker = marker("copied", "root", "old-thread", "old-root") as Extract<
    SessionEntry,
    { type: "custom" }
  >;
  copiedMarker.data = {
    ...(copiedMarker.data as CodexThreadMarkerData),
    sessionId: "old-session",
  };
  const user = entry("user", "copied", "user");

  assert.deepEqual(resolveCodexThreadIdentity("new-session", [root, copiedMarker, user]), {
    threadId: "new-session",
  });
});
