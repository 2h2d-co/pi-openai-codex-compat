import type { UpdateChunk } from "./apply-patch-matcher/apply-patch-matcher-contracts.ts";
import { throwIfAborted } from "./apply-patch-matcher/apply-patch-matcher-line-matching.ts";
import { deriveStrictContent } from "./apply-patch-matcher/apply-patch-matcher-strict-content.ts";

export type {
  FormatterMatchCandidateRange,
  FormatterMatchFailureDetails,
  FormatterMatchFailureReason,
  UpdateChunk,
  UpdateHunkLine,
} from "./apply-patch-matcher/apply-patch-matcher-contracts.ts";
export {
  FormatterMatchAmbiguityError,
  FormatterMatchError,
  formatFormatterMatchFailure,
} from "./apply-patch-matcher/apply-patch-matcher-diagnostics.ts";
export { setApplyPatchStructuralRuntimeForTesting } from "./apply-patch-matcher/apply-patch-matcher-structural-runtime.ts";

export async function deriveNewContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  return deriveStrictContent(content, chunks, path);
}
