import { uuidv7 } from "@earendil-works/pi-ai";
import { isObject, type JsonRecord } from "./codex-protocol.ts";

export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

export type CodexRequestKind = "turn" | "prewarm" | "compaction";

type CodexClientMetadata = {
  session_id: string;
  thread_id: string;
  turn_id: string;
  [CODEX_TURN_METADATA_HEADER]: string;
};

function turnMetadata(sessionId: string, turnId: string, requestKind: CodexRequestKind): string {
  return JSON.stringify({
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
    request_kind: requestKind,
  });
}

export function codexClientMetadata(
  sessionId: string | undefined,
  requestKind: CodexRequestKind,
): CodexClientMetadata | undefined {
  if (!sessionId) return undefined;
  const turnId = uuidv7();
  return {
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
    [CODEX_TURN_METADATA_HEADER]: turnMetadata(sessionId, turnId, requestKind),
  };
}

export function withCodexRequestMetadata(
  payload: JsonRecord,
  sessionId: string | undefined,
  requestKind: CodexRequestKind,
): JsonRecord {
  const metadata = codexClientMetadata(sessionId, requestKind);
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
  if (typeof metadata[CODEX_TURN_METADATA_HEADER] === "string") {
    headers.set(CODEX_TURN_METADATA_HEADER, metadata[CODEX_TURN_METADATA_HEADER]);
  }
}
