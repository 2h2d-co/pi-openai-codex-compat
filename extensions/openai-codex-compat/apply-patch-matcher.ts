import type { UpdateChunk } from "./apply-patch-matcher/apply-patch-matcher-contracts.ts";
import { FormatterMatchError } from "./apply-patch-matcher/apply-patch-matcher-diagnostics.ts";
import { throwIfAborted } from "./apply-patch-matcher/apply-patch-matcher-line-matching.ts";
import { deriveStrictContent } from "./apply-patch-matcher/apply-patch-matcher-strict-content.ts";
import { deriveFormatterTolerantContent } from "./apply-patch-matcher/apply-patch-matcher-formatter-tolerant-content.ts";

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

function isContextMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Failed to find context") ||
      error.message.startsWith("Failed to find expected lines"))
  );
}

export async function deriveNewContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  try {
    return deriveStrictContent(content, chunks, path);
  } catch (error) {
    if (!isContextMismatch(error)) throw error;
    try {
      const tolerant = await deriveFormatterTolerantContent(content, chunks, path, signal);
      if (tolerant !== undefined) return tolerant;
    } catch (matcherError) {
      if (!(matcherError instanceof FormatterMatchError)) throw matcherError;
      throw new FormatterMatchError(
        `${error instanceof Error ? error.message : String(error)}\nMatcher diagnostics: ${matcherError.message}`,
        matcherError.details,
      );
    }
    throw error;
  }
}
