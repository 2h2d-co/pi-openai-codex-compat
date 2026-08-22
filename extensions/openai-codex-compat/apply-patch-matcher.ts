import type { UpdateChunk } from "./apply-patch-matcher/apply-patch-matcher-contracts.ts";
import { throwIfAborted } from "./apply-patch-matcher/apply-patch-matcher-line-matching.ts";
import { deriveStrictContent } from "./apply-patch-matcher/apply-patch-matcher-strict-content.ts";

export type {
  UpdateChunk,
  UpdateHunkLine,
} from "./apply-patch-matcher/apply-patch-matcher-contracts.ts";

export function deriveNewContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
  signal?: AbortSignal,
): string {
  throwIfAborted(signal);
  return deriveStrictContent(content, chunks, path);
}
