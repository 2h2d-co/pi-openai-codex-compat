import { uuidv7 } from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "./codex-protocol.ts";

export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
export const CODEX_INSTALLATION_ID_METADATA_KEY = "x-codex-installation-id";
export const CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

export type CodexRequestKind = "turn" | "prewarm" | "compaction";

export type CodexCompactionMetadata = {
  trigger: "manual" | "auto";
  reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
  implementation: "responses" | "responses_compaction_v2" | "responses_compact";
  phase: "standalone_turn" | "pre_turn" | "mid_turn";
  strategy: "memento" | "prefix_compaction";
};

export type CodexMetadataRequest =
  | { kind: "turn" | "prewarm" }
  | { kind: "compaction"; compaction: CodexCompactionMetadata };

export type CodexMetadataIdentity = {
  installationId: string;
  threadId?: string;
  forkedFromThreadId?: string;
  windowNumber?: number;
  turnStartedAtUnixMs?: number;
  threadSource?: string;
  sandbox?: string;
};

const EPHEMERAL_METADATA_IDENTITY: CodexMetadataIdentity = { installationId: uuidv7() };

type CodexClientMetadata = {
  [CODEX_INSTALLATION_ID_METADATA_KEY]: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  [CODEX_WINDOW_ID_HEADER]: string;
  [CODEX_TURN_METADATA_HEADER]: string;
};

export function responsesCompactionV2Metadata(
  trigger: CodexCompactionMetadata["trigger"],
  reason: CodexCompactionMetadata["reason"],
  phase: CodexCompactionMetadata["phase"],
): CodexCompactionMetadata {
  return {
    trigger,
    reason,
    implementation: "responses_compaction_v2",
    phase,
    strategy: "memento",
  };
}

function windowId(sessionId: string, identity: CodexMetadataIdentity): string {
  return `${identity.threadId ?? sessionId}:${identity.windowNumber ?? 0}`;
}

function turnMetadata(
  sessionId: string,
  turnId: string,
  request: CodexMetadataRequest,
  identity: CodexMetadataIdentity,
): string {
  const threadId = identity.threadId ?? sessionId;
  return JSON.stringify({
    installation_id: identity.installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId(sessionId, identity),
    request_kind: request.kind,
    ...(identity.forkedFromThreadId ? { forked_from_thread_id: identity.forkedFromThreadId } : {}),
    ...(identity.threadSource ? { thread_source: identity.threadSource } : {}),
    ...(identity.sandbox ? { sandbox: identity.sandbox } : {}),
    ...(identity.turnStartedAtUnixMs === undefined
      ? {}
      : { turn_started_at_unix_ms: identity.turnStartedAtUnixMs }),
    ...(request.kind === "compaction" ? { compaction: request.compaction } : {}),
  });
}

export function codexClientMetadata(
  sessionId: string | undefined,
  request: CodexMetadataRequest,
  turnId = uuidv7(),
  identity: CodexMetadataIdentity = EPHEMERAL_METADATA_IDENTITY,
): CodexClientMetadata | undefined {
  if (!sessionId) return undefined;
  const threadId = identity.threadId ?? sessionId;
  return {
    [CODEX_INSTALLATION_ID_METADATA_KEY]: identity.installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    [CODEX_WINDOW_ID_HEADER]: windowId(sessionId, identity),
    [CODEX_TURN_METADATA_HEADER]: turnMetadata(sessionId, turnId, request, identity),
  };
}

export function withCodexRequestMetadata(
  payload: JsonRecord,
  sessionId: string | undefined,
  request: CodexMetadataRequest,
  turnId?: string,
  identity: CodexMetadataIdentity = EPHEMERAL_METADATA_IDENTITY,
): JsonRecord {
  const metadata = codexClientMetadata(sessionId, request, turnId, identity);
  if (!metadata) {
    const result = structuredClone(payload);
    delete result["client_metadata"];
    return result;
  }
  const existing = isObject(payload["client_metadata"]) ? payload["client_metadata"] : {};
  return {
    ...payload,
    client_metadata: {
      ...existing,
      ...metadata,
    },
  };
}

export function applyCodexMetadataHeaders(headers: Headers, payload: JsonRecord): void {
  const metadata = payload["client_metadata"];
  if (!isObject(metadata)) return;

  if (typeof metadata["thread_id"] === "string") {
    headers.set("thread-id", metadata["thread_id"]);
  }
  if (typeof metadata[CODEX_WINDOW_ID_HEADER] === "string") {
    headers.set(CODEX_WINDOW_ID_HEADER, metadata[CODEX_WINDOW_ID_HEADER]);
  }
  if (typeof metadata[CODEX_TURN_METADATA_HEADER] === "string") {
    headers.set(CODEX_TURN_METADATA_HEADER, metadata[CODEX_TURN_METADATA_HEADER]);
  }
}
