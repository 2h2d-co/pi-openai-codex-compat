import { isObject } from "./codex-protocol.ts";
import { isString } from "./value-contracts.ts";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { codexCacheKey } from "./codex-cache-key.ts";

export const CODEX_THREAD_MARKER_ENTRY_TYPE = "openai-codex-compat-thread";

export type CodexThreadMarkerData = {
  version: 1;
  sessionId: string;
  threadId: string;
  forkedFromThreadId: string;
  branchParentEntryId: string | null;
};

export type CodexThreadLineageContext = {
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getEntries" | "getLeafId" | "getSessionId"
  >;
};

export type CodexThreadLineageMessageHandler = (
  event: {
    message: {
      role: string;
    };
  },
  ctx: CodexThreadLineageContext,
) => Promise<void> | void;

export type CodexThreadLineageLifecycleHandler = (
  ctx: CodexThreadLineageContext,
) => Promise<void> | void;

export type CodexThreadLineageApi = {
  appendEntry(customType: string, data: CodexThreadMarkerData): void;
  onMessageEnd(handler: CodexThreadLineageMessageHandler): void;
  onSessionShutdown(handler: CodexThreadLineageLifecycleHandler): void;
  onSessionStart(handler: CodexThreadLineageLifecycleHandler): void;
  onSessionTree(handler: CodexThreadLineageLifecycleHandler): void;
};

export function codexThreadLineageApi(pi: ExtensionAPI): CodexThreadLineageApi {
  return {
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    onMessageEnd: (handler) =>
      pi.on("message_end", (event, ctx) => handler({ message: { role: event.message.role } }, ctx)),
    onSessionShutdown: (handler) => pi.on("session_shutdown", (_event, ctx) => handler(ctx)),
    onSessionStart: (handler) => pi.on("session_start", (_event, ctx) => handler(ctx)),
    onSessionTree: (handler) => pi.on("session_tree", (_event, ctx) => handler(ctx)),
  };
}

export type CodexThreadIdentity = {
  threadId: string;
  forkedFromThreadId?: string;
};

type PendingTreeFork = {
  expectedLeafId: string | null;
};

export function isCodexThreadMarkerData(value: unknown): value is CodexThreadMarkerData {
  if (!isObject(value)) return false;
  return (
    value["version"] === 1 &&
    isString(value["sessionId"]) &&
    value["sessionId"].length > 0 &&
    isString(value["threadId"]) &&
    value["threadId"].length > 0 &&
    isString(value["forkedFromThreadId"]) &&
    value["forkedFromThreadId"].length > 0 &&
    (value["branchParentEntryId"] === null || isString(value["branchParentEntryId"]))
  );
}

function markerData(entry: SessionEntry, sessionId: string): CodexThreadMarkerData | undefined {
  if (entry.type !== "custom" || entry.customType !== CODEX_THREAD_MARKER_ENTRY_TYPE) {
    return undefined;
  }
  if (!isCodexThreadMarkerData(entry.data)) {
    throw new Error("The active Pi branch contains an invalid OpenAI Codex thread marker.");
  }
  const candidate = entry.data;
  if (candidate["sessionId"] !== sessionId) return undefined;
  if (entry.parentId !== candidate["branchParentEntryId"]) {
    throw new Error("The active Pi branch contains a misplaced OpenAI Codex thread marker.");
  }
  return candidate;
}

function latestMarkerIndex(sessionId: string, branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry !== undefined && markerData(entry, sessionId)) {
      return index;
    }
  }
  return -1;
}

export function resolveCodexThreadIdentity(
  sessionId: string,
  branch: readonly SessionEntry[],
): CodexThreadIdentity {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === undefined) continue;
    const marker = markerData(entry, sessionId);
    if (marker) {
      return {
        threadId: marker.threadId,
        forkedFromThreadId: marker.forkedFromThreadId,
      };
    }
  }
  const threadId = codexCacheKey(sessionId);
  if (threadId === undefined) throw new Error("The session has no Codex cache key.");
  return { threadId };
}

function shouldForkOnNextAppend(
  sessionId: string,
  branch: readonly SessionEntry[],
  entries: readonly SessionEntry[],
): boolean {
  // Pi does not persist an explicit branch-start flag. Its append order is
  // stable, so the first child inherits its thread and later children are
  // forks unless the active path already contains a marker for that fork.
  const firstChildByParent = new Map<string | null, string>();
  for (const entry of entries) {
    if (!firstChildByParent.has(entry.parentId)) {
      firstChildByParent.set(entry.parentId, entry.id);
    }
  }

  const markerIndex = latestMarkerIndex(sessionId, branch);
  for (let index = markerIndex + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined) continue;
    if (firstChildByParent.get(entry.parentId) !== entry.id) return true;
  }

  const leafId = branch.at(-1)?.id ?? null;
  return entries.some((entry) => entry.parentId === leafId);
}

function armPendingFork(
  pending: Map<string, PendingTreeFork>,
  ctx: CodexThreadLineageContext,
): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch();
  const entries = ctx.sessionManager.getEntries();
  if (!shouldForkOnNextAppend(sessionId, branch, entries)) {
    pending.delete(sessionId);
    return;
  }
  pending.set(sessionId, { expectedLeafId: ctx.sessionManager.getLeafId() });
}

function pendingLeafIsActive(pending: PendingTreeFork, branch: readonly SessionEntry[]): boolean {
  return (
    pending.expectedLeafId === null || branch.some((entry) => entry.id === pending.expectedLeafId)
  );
}

export default function registerCodexThreadLineage(pi: CodexThreadLineageApi): void {
  const pending = new Map<string, PendingTreeFork>();

  pi.onSessionStart((ctx) => {
    armPendingFork(pending, ctx);
  });

  pi.onSessionTree((ctx) => {
    armPendingFork(pending, ctx);
  });

  pi.onMessageEnd((event, ctx) => {
    if (event.message.role !== "user") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const candidate = pending.get(sessionId);
    if (!candidate) return;
    pending.delete(sessionId);

    const branch = ctx.sessionManager.getBranch();
    if (!pendingLeafIsActive(candidate, branch)) return;

    const parent = resolveCodexThreadIdentity(sessionId, branch);
    const branchParentEntryId = ctx.sessionManager.getLeafId();
    // Pi invokes message_end handlers immediately before persisting the
    // finalized user message. Advancing the leaf here makes this context-free
    // marker the user's parent without writing anything during /tree itself.
    pi.appendEntry(CODEX_THREAD_MARKER_ENTRY_TYPE, {
      version: 1,
      sessionId,
      threadId: uuidv7(),
      forkedFromThreadId: parent.threadId,
      branchParentEntryId,
    });
  });

  pi.onSessionShutdown((ctx) => {
    pending.delete(ctx.sessionManager.getSessionId());
  });
}
