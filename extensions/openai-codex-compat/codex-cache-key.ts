import { createHash } from "node:crypto";

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function codexCacheKey(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined;
  if (Array.from(sessionId).length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return sessionId;
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}
