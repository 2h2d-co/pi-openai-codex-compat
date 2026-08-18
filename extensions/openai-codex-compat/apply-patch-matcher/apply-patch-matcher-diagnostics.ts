import type {
  EditCandidate,
  EditGroup,
  FormatterMatchCandidateRange,
  FormatterMatchFailureDetails,
} from "./apply-patch-matcher-contracts.ts";

export const MAX_CANDIDATES_PER_GROUP = 64;

export const MAX_COMPLETE_MAPPINGS = 256;

export class FormatterMatchError extends Error {
  readonly details: FormatterMatchFailureDetails;

  constructor(message: string, details: FormatterMatchFailureDetails, cause?: unknown) {
    super(message, { cause });
    this.details = details;
  }
}

export class FormatterMatchAmbiguityError extends FormatterMatchError {}

export class OverlappingFormatterEditsError extends Error {}

export function candidateRange(candidate: EditCandidate): FormatterMatchCandidateRange {
  return {
    startLine: candidate.startLine + 1,
    endLine: Math.max(candidate.startLine + 1, candidate.endLine),
  };
}

export function candidateRanges(
  candidates: readonly EditCandidate[],
): FormatterMatchCandidateRange[] {
  return candidates.slice(0, 3).map(candidateRange);
}

export function lineRangeLabel(range: FormatterMatchCandidateRange): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}-${range.endLine}`;
}

export function rangeList(ranges: readonly FormatterMatchCandidateRange[]): string {
  return ranges.map(lineRangeLabel).join(", ");
}

export function formatFormatterMatchFailure(details: FormatterMatchFailureDetails): string {
  const group =
    details.groupIndex === undefined
      ? ""
      : `edit group ${details.groupIndex} of ${details.groupCount}`;
  const chunk =
    details.chunkIndex === undefined
      ? ""
      : ` (chunk ${details.chunkIndex} of ${details.chunkCount})`;
  switch (details.reason) {
    case "no-candidate": {
      const replacement =
        details.replacementCandidateCount && details.replacementCandidates?.length
          ? ` The requested replacement already appears at ${rangeList(details.replacementCandidates)}.`
          : "";
      return `No formatter-tolerant candidate for ${group}${chunk} in ${details.path}.${replacement}`;
    }
    case "no-ordered-mapping": {
      const current = rangeList(details.candidates);
      const previous = rangeList(details.previousCandidates ?? []);
      const relation = details.reverseOrdered
        ? `${current} precedes edit group ${details.previousGroupIndex}, matched at ${previous}`
        : details.overlapping
          ? `${current} overlaps edit group ${details.previousGroupIndex}, matched at ${previous}`
          : `no candidate at ${current} can follow edit group ${details.previousGroupIndex}, matched at ${previous}`;
      return `No ordered formatter-tolerant mapping for ${group}${chunk} in ${details.path}: ${relation}. The hunks may be in reverse source order or overlap.`;
    }
    case "too-many-candidates":
      return `Formatter-tolerant match is ambiguous for ${group}${chunk} in ${details.path}: ${details.candidateCount} eligible locations exceed the ${MAX_CANDIDATES_PER_GROUP}-candidate limit.`;
    case "ambiguous-output":
      return `Formatter-tolerant match is ambiguous in ${details.path}: candidate mappings produce different files.`;
    case "mapping-limit":
      return `Formatter-tolerant match is ambiguous in ${details.path}: more than ${MAX_COMPLETE_MAPPINGS} candidate mappings require evaluation.`;
    case "overlapping-edits":
      return `Formatter-tolerant candidate edits overlap in ${details.path}.`;
  }
}

export function oldExcerpt(group: EditGroup): string | undefined {
  if (group.oldLines.length === 0) return undefined;
  const lines = group.oldLines.slice(0, 3);
  let excerpt = lines.join("\n");
  if (group.oldLines.length > lines.length) excerpt = `${excerpt}\n…`;
  return excerpt.length > 240 ? `${excerpt.slice(0, 239)}…` : excerpt;
}

export function enforceCandidateLimit(
  candidates: EditCandidate[],
  path: string,
  group: EditGroup,
  groupIndex: number,
  groupCount: number,
): EditCandidate[] {
  if (candidates.length > MAX_CANDIDATES_PER_GROUP) {
    const details: FormatterMatchFailureDetails = {
      reason: "too-many-candidates",
      path,
      groupCount,
      groupIndex: groupIndex + 1,
      chunkCount: group.chunkCount,
      chunkIndex: group.chunkIndex,
      candidateCount: candidates.length,
      candidates: candidateRanges(candidates),
    };
    throw new FormatterMatchAmbiguityError(formatFormatterMatchFailure(details), details);
  }
  return candidates;
}
