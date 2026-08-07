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

export type CodexThreadIdentity = {
  threadId: string;
  forkedFromThreadId?: string;
};

type PendingTreeFork = {
  expectedLeafId: string | null;
};

function markerData(entry: SessionEntry, sessionId: string): CodexThreadMarkerData | undefined {
  if (entry.type !== "custom" || entry.customType !== CODEX_THREAD_MARKER_ENTRY_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("The active Pi branch contains an invalid OpenAI Codex thread marker.");
  }
  const candidate = data as Record<string, unknown>;
  if (
    candidate["version"] !== 1 ||
    typeof candidate["sessionId"] !== "string" ||
    candidate["sessionId"].length === 0 ||
    typeof candidate["threadId"] !== "string" ||
    candidate["threadId"].length === 0 ||
    typeof candidate["forkedFromThreadId"] !== "string" ||
    candidate["forkedFromThreadId"].length === 0 ||
    (candidate["branchParentEntryId"] !== null &&
      typeof candidate["branchParentEntryId"] !== "string")
  ) {
    throw new Error("The active Pi branch contains an invalid OpenAI Codex thread marker.");
  }
  if (candidate["sessionId"] !== sessionId) return undefined;
  if (entry.parentId !== candidate["branchParentEntryId"]) {
    throw new Error("The active Pi branch contains a misplaced OpenAI Codex thread marker.");
  }
  return candidate as CodexThreadMarkerData;
}

function latestMarkerIndex(sessionId: string, branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (markerData(branch[index]!, sessionId)) return index;
  }
  return -1;
}

export function resolveCodexThreadIdentity(
  sessionId: string,
  branch: readonly SessionEntry[],
): CodexThreadIdentity {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const marker = markerData(branch[index]!, sessionId);
    if (marker) {
      return {
        threadId: marker.threadId,
        forkedFromThreadId: marker.forkedFromThreadId,
      };
    }
  }
  return { threadId: codexCacheKey(sessionId)! };
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
    const entry = branch[index]!;
    if (firstChildByParent.get(entry.parentId) !== entry.id) return true;
  }

  const leafId = branch.at(-1)?.id ?? null;
  return entries.some((entry) => entry.parentId === leafId);
}

function armPendingFork(pending: Map<string, PendingTreeFork>, ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const entries = ctx.sessionManager.getEntries() as SessionEntry[];
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

export default function registerCodexThreadLineage(pi: ExtensionAPI): void {
  const pending = new Map<string, PendingTreeFork>();

  pi.on("session_start", (_event, ctx) => {
    armPendingFork(pending, ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    armPendingFork(pending, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const candidate = pending.get(sessionId);
    if (!candidate) return;
    pending.delete(sessionId);

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    if (!pendingLeafIsActive(candidate, branch)) return;

    const parent = resolveCodexThreadIdentity(sessionId, branch);
    const branchParentEntryId = ctx.sessionManager.getLeafId();
    // Pi invokes message_end handlers immediately before persisting the
    // finalized user message. Advancing the leaf here makes this context-free
    // marker the user's parent without writing anything during /tree itself.
    pi.appendEntry<CodexThreadMarkerData>(CODEX_THREAD_MARKER_ENTRY_TYPE, {
      version: 1,
      sessionId,
      threadId: uuidv7(),
      forkedFromThreadId: parent.threadId,
      branchParentEntryId,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pending.delete(ctx.sessionManager.getSessionId());
  });
}
