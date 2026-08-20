import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { codexCacheKey } from "../extensions/openai-codex-compat/codex-cache-key.ts";
import registerCodexThreadLineage, {
  CODEX_THREAD_MARKER_DATA_SCHEMA,
  CODEX_THREAD_MARKER_ENTRY_TYPE,
  resolveCodexThreadIdentity,
  type CodexThreadLineageApi,
  type CodexThreadLineageContext,
  type CodexThreadMarkerData,
} from "../extensions/openai-codex-compat/codex-thread-lineage.ts";

type CustomSessionEntry = Extract<SessionEntry, { type: "custom" }>;
type ThreadMarkerEntry = Omit<CustomSessionEntry, "data"> & {
  data: CodexThreadMarkerData;
};

type TestEvent = {
  message?: {
    content?: unknown;
    role?: string;
    timestamp?: number;
  };
  newLeafId?: string | null;
  oldLeafId?: string | null;
  reason?: string;
  type?: string;
};

type TestHandler = (event: TestEvent) => Promise<void> | void;

function entry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" = "assistant",
): SessionEntry {
  if (role === "user") {
    return {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: id }],
        timestamp: Date.now(),
      },
    };
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: id }],
      timestamp: Date.now(),
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
    },
  } satisfies SessionEntry;
}

function marker(
  id: string,
  parentId: string | null,
  threadId: string,
  forkedFromThreadId: string,
): ThreadMarkerEntry {
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
  };
}

function createHarness(initialEntries: SessionEntry[], initialLeafId: string | null) {
  const handlers = new Map<string, TestHandler[]>();
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
  } satisfies CodexThreadLineageContext;
  const pi: CodexThreadLineageApi = {
    onMessageEnd(handler) {
      const registered = handlers.get("message_end") ?? [];
      registered.push((event) => {
        const role = event.message?.role;
        if (role === undefined) throw new Error("message_end test event has no role.");
        return handler({ message: { role } }, context);
      });
      handlers.set("message_end", registered);
    },
    onSessionShutdown(handler) {
      const registered = handlers.get("session_shutdown") ?? [];
      registered.push(() => handler(context));
      handlers.set("session_shutdown", registered);
    },
    onSessionStart(handler) {
      const registered = handlers.get("session_start") ?? [];
      registered.push(() => handler(context));
      handlers.set("session_start", registered);
    },
    onSessionTree(handler) {
      const eventName = "session_tree";
      const registered = handlers.get(eventName) ?? [];
      registered.push(() => handler(context));
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
      } satisfies SessionEntry);
      leafId = id;
    },
  };

  registerCodexThreadLineage(pi);
  const emit = async (eventName: string, event: TestEvent) => {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event);
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

test("validates complete thread markers while allowing additional metadata", () => {
  const valid = {
    version: 1,
    sessionId: "session-1",
    threadId: "thread-1",
    forkedFromThreadId: "thread-0",
    branchParentEntryId: null,
    futureMetadata: true,
  };
  assert.equal(Value.Check(CODEX_THREAD_MARKER_DATA_SCHEMA, valid), true);

  for (const malformed of [
    { ...valid, version: 2 },
    { ...valid, sessionId: "" },
    { ...valid, threadId: "" },
    { ...valid, forkedFromThreadId: "" },
    { ...valid, branchParentEntryId: 42 },
  ]) {
    assert.equal(Value.Check(CODEX_THREAD_MARKER_DATA_SCHEMA, malformed), false);
  }
});

test("writes no marker during navigation and makes the finalized user its child", async () => {
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
  assert.ok(
    storedMarker?.type === "custom" &&
      Value.Check(CODEX_THREAD_MARKER_DATA_SCHEMA, storedMarker.data),
  );
  assert.equal(storedMarker.data.forkedFromThreadId, codexCacheKey("session-1"));

  harness.appendUser("new-user");
  assert.equal(harness.entries.at(-1)?.parentId, storedMarker?.id);
  assert.notEqual(
    resolveCodexThreadIdentity("session-1", harness.branch()).threadId,
    codexCacheKey("session-1"),
  );
});

test("does not mark a linear continuation from an existing leaf", async () => {
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

test("drops unsummarized navigation with Pi's ephemeral leaf on shutdown", async () => {
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

test("forks from the nearest existing branch thread when editing its first user", async () => {
  const root = entry("root", null);
  const initialThreadId = codexCacheKey("session-1");
  assert.ok(initialThreadId);
  const firstMarker = marker("marker-a", "root", "thread-a", initialThreadId);
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
  assert.ok(
    secondMarker?.type === "custom" &&
      Value.Check(CODEX_THREAD_MARKER_DATA_SCHEMA, secondMarker.data),
  );
  assert.equal(secondMarker.data.forkedFromThreadId, "thread-a");
});

test("restores an unmarked summarized branch without transient tree state", async () => {
  const root = entry("root", null);
  const old = entry("old", "root", "user");
  const summary = {
    type: "branch_summary",
    id: "summary",
    parentId: "root",
    timestamp: new Date().toISOString(),
    fromId: "root",
    summary: "alternate",
  } satisfies SessionEntry;
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

test("fails closed on malformed or misplaced active thread markers", () => {
  const root = entry("root", null);
  const malformed = {
    type: "custom",
    id: "bad",
    parentId: "root",
    timestamp: new Date().toISOString(),
    customType: CODEX_THREAD_MARKER_ENTRY_TYPE,
    data: { version: 1 },
  } satisfies SessionEntry;
  assert.throws(
    () => resolveCodexThreadIdentity("session-1", [root, malformed]),
    /invalid OpenAI Codex thread marker/,
  );

  const misplaced = marker("misplaced", "root", "thread", "root-thread");
  misplaced.data = {
    ...misplaced.data,
    branchParentEntryId: "different",
  };
  assert.throws(
    () => resolveCodexThreadIdentity("session-1", [root, misplaced]),
    /misplaced OpenAI Codex thread marker/,
  );
});

test("ignores copied thread markers from a different Pi session", () => {
  const root = entry("root", null);
  const copiedMarker = marker("copied", "root", "old-thread", "old-root");
  copiedMarker.data = {
    ...copiedMarker.data,
    sessionId: "old-session",
  };
  const user = entry("user", "copied", "user");

  assert.deepEqual(resolveCodexThreadIdentity("new-session", [root, copiedMarker, user]), {
    threadId: "new-session",
  });
});
