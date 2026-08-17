import type {
  ByteEdit,
  EditCandidate,
  EditGroup,
  FormatterMatchFailureDetails,
  StructuralDocument,
  UpdateChunk,
} from "./apply-patch-matcher-contracts.ts";
import {
  MAX_COMPLETE_MAPPINGS,
  FormatterMatchAmbiguityError,
  FormatterMatchError,
  OverlappingFormatterEditsError,
  candidateRanges,
  enforceCandidateLimit,
  formatFormatterMatchFailure,
  oldExcerpt,
} from "./apply-patch-matcher-diagnostics.ts";
import {
  MATCH_MODES,
  findTolerantSequences,
  isMarkdownPath,
  lineEndingAtBoundary,
  lineEndingForLine,
  linesMatch,
  markdownTableLinesMatch,
  replacementLines,
  throwIfAborted,
} from "./apply-patch-matcher-line-matching.ts";
import {
  fenceGrammar,
  grammarForPath,
  lineBounds,
  parseFragment,
  relativeShape,
  structuralDocuments,
  tokenSignatureMatches,
} from "./apply-patch-matcher-structural-runtime.ts";

export function editGroups(chunks: readonly UpdateChunk[]): EditGroup[] {
  const groups: EditGroup[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const chunkGroups: EditGroup[] = [];
    for (let index = 0; index < chunk.lines.length;) {
      if (chunk.lines[index]!.kind === "context") {
        index += 1;
        continue;
      }
      const start = index;
      while (index < chunk.lines.length && chunk.lines[index]!.kind !== "context") index += 1;
      const segment = chunk.lines.slice(start, index);
      let beforeStart = start;
      while (beforeStart > 0 && chunk.lines[beforeStart - 1]!.kind === "context") {
        beforeStart -= 1;
      }
      let afterEnd = index;
      while (afterEnd < chunk.lines.length && chunk.lines[afterEnd]!.kind === "context") {
        afterEnd += 1;
      }
      chunkGroups.push({
        chunk,
        chunkIndex: chunkIndex + 1,
        chunkCount: chunks.length,
        oldLines: segment.filter((line) => line.kind === "delete").map((line) => line.text),
        newLines: segment.filter((line) => line.kind === "add").map((line) => line.text),
        beforeContext: chunk.lines.slice(beforeStart, start).map((line) => line.text),
        afterContext: chunk.lines.slice(index, afterEnd).map((line) => line.text),
        endsChunk: false,
      });
    }
    const finalGroup = chunkGroups.at(-1);
    if (finalGroup) finalGroup.endsChunk = true;
    groups.push(...chunkGroups);
  }
  return groups;
}

export function normalizedSource(content: string): {
  source: string;
  lines: string[];
  lineStarts: number[];
} {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const source = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const lineStarts = [0];
  let offset = 0;
  for (const line of lines) {
    offset += Buffer.byteLength(line, "utf8") + 1;
    lineStarts.push(offset);
  }
  return { source, lines, lineStarts };
}

export function lineForByte(lineStarts: readonly number[], byte: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= byte) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function contextMatches(actual: string, expected: string, path: string): boolean {
  return (
    MATCH_MODES.some((mode) => linesMatch(actual, expected, mode)) ||
    (isMarkdownPath(path) && markdownTableLinesMatch(actual, expected))
  );
}

export function anchorLines(
  group: EditGroup,
  sourceLines: readonly string[],
  path: string,
): number[] {
  if (!group.chunk.context) return [];
  return sourceLines.flatMap((line, index) =>
    contextMatches(line, group.chunk.context!, path) ? [index] : [],
  );
}

export function candidateFollowsAnchor(
  group: EditGroup,
  sourceLines: readonly string[],
  startLine: number,
  path: string,
): boolean {
  const anchors = anchorLines(group, sourceLines, path);
  return anchors.length === 0 || anchors.some((line) => line < startLine);
}

export function candidateSatisfiesEndOfFile(
  group: EditGroup,
  sourceLineCount: number,
  endLine: number,
): boolean {
  return (
    !group.chunk.endOfFile ||
    !group.endsChunk ||
    endLine + group.afterContext.length === sourceLineCount
  );
}

export function lineCandidates(
  group: EditGroup,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  path: string,
): EditCandidate[] {
  const starts = findTolerantSequences(sourceLines, group.oldLines, 0, false, path);
  const ordinary = starts
    .map((startLine) => {
      const endLine = startLine + group.oldLines.length;
      const start = lineStarts[startLine]!;
      const end = lineStarts[endLine]!;
      const replacement = replacementLines(
        group.newLines,
        lineEndingForLine(sourceLines, startLine),
      );
      return {
        start,
        end,
        startLine,
        endLine,
        edits: [{ start, end, replacement }],
      };
    })
    .filter(
      (candidate) =>
        candidateFollowsAnchor(group, sourceLines, candidate.startLine, path) &&
        candidateSatisfiesEndOfFile(group, sourceLines.length, candidate.endLine),
    );
  return ordinary;
}

export function insertionCandidates(
  group: EditGroup,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  path: string,
): EditCandidate[] {
  const boundaries = new Set<number>();
  const nearestBefore = group.beforeContext.at(-1);
  if (nearestBefore !== undefined) {
    const expected = nearestBefore;
    const matches = findTolerantSequences(sourceLines, [expected], 0, false, path);
    for (const match of matches) boundaries.add(match + 1);
  }
  const nearestAfter = group.afterContext[0];
  if (nearestAfter !== undefined) {
    const expected = nearestAfter;
    const matches = findTolerantSequences(sourceLines, [expected], 0, false, path);
    for (const match of matches) boundaries.add(match);
  }
  if (group.chunk.context) {
    for (const match of findTolerantSequences(sourceLines, [group.chunk.context], 0, false, path)) {
      boundaries.add(match + 1);
    }
  }
  if (
    group.chunk.endOfFile &&
    group.endsChunk &&
    group.beforeContext.length === 0 &&
    group.afterContext.length === 0
  ) {
    boundaries.add(sourceLines.length);
  }

  return [...boundaries]
    .filter(
      (line) =>
        candidateFollowsAnchor(group, sourceLines, line, path) &&
        candidateSatisfiesEndOfFile(group, sourceLines.length, line),
    )
    .map((line) => {
      const byte = lineStarts[line]!;
      const replacement = replacementLines(group.newLines, lineEndingAtBoundary(sourceLines, line));
      return {
        start: byte,
        end: byte,
        startLine: line,
        endLine: line,
        edits: [{ start: byte, end: byte, replacement }],
      };
    });
}

export function deduplicateCandidates(candidates: readonly EditCandidate[]): EditCandidate[] {
  const unique = new Map<string, EditCandidate>();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      candidate.start,
      candidate.end,
      candidate.edits.map((edit) => [edit.start, edit.end, edit.replacement.toString("base64")]),
    ]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

export async function tokenCandidates(
  group: EditGroup,
  document: StructuralDocument,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  path: string,
  signal?: AbortSignal,
): Promise<EditCandidate[]> {
  throwIfAborted(signal);
  const oldTokens = await parseFragment(document.grammar, group.oldLines.join("\n"));
  if (!oldTokens || oldTokens.length < 2 || oldTokens.length > document.tokens.length) return [];
  const expectedShape = relativeShape(oldTokens);
  const sourceBytes = Buffer.from(source, "utf8");
  const candidates: EditCandidate[] = [];

  for (let index = 0; index <= document.tokens.length - oldTokens.length; index++) {
    throwIfAborted(signal);
    const window = document.tokens.slice(index, index + oldTokens.length);
    if (!tokenSignatureMatches(window, oldTokens) || relativeShape(window) !== expectedShape) {
      continue;
    }
    const first = window[0]!;
    const last = window.at(-1)!;
    const bounds = lineBounds(sourceBytes, first.start, last.end);
    if (!bounds.fullLines) continue;
    const lineEnding: "\n" | "\r\n" =
      bounds.lineEnd > bounds.lineStart && sourceBytes[bounds.lineEnd - 1] === 0x0d ? "\r\n" : "\n";
    const start = bounds.lineStart;
    const end = bounds.afterLine;
    const edits: ByteEdit[] = [
      {
        start,
        end,
        replacement: replacementLines(group.newLines, lineEnding, end > bounds.lineEnd),
      },
    ];
    const startLine = lineForByte(lineStarts, first.start);
    const endLine = Math.min(sourceLines.length, lineForByte(lineStarts, last.end - 1) + 1);
    const candidate = {
      start,
      end,
      startLine,
      endLine,
      edits,
    };
    if (
      candidateFollowsAnchor(group, sourceLines, candidate.startLine, path) &&
      candidateSatisfiesEndOfFile(group, sourceLines.length, candidate.endLine)
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function applyEdits(source: Buffer, edits: readonly ByteEdit[]): Buffer {
  const ordered = edits
    .map((edit, index) => ({ ...edit, index }))
    .sort((left, right) => left.start - right.start || left.index - right.index);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new OverlappingFormatterEditsError("formatter-tolerant edits overlap");
    }
  }
  let result = source;
  for (const edit of ordered.toReversed()) {
    result = Buffer.concat([
      result.subarray(0, edit.start),
      edit.replacement,
      result.subarray(edit.end),
    ]);
  }
  return result;
}

export function distinctMappedOutputs(
  source: string,
  candidateSets: readonly EditCandidate[][],
  signal?: AbortSignal,
): { outputs: Map<string, Buffer>; exhaustive: boolean } {
  const outputs = new Map<string, Buffer>();
  const sourceBytes = Buffer.from(source, "utf8");
  let mappings = 0;
  let exhaustive = true;

  const visit = (groupIndex: number, previousEnd: number, edits: ByteEdit[]): void => {
    throwIfAborted(signal);
    if (outputs.size > 1) return;
    if (mappings >= MAX_COMPLETE_MAPPINGS) {
      exhaustive = false;
      return;
    }
    if (groupIndex === candidateSets.length) {
      mappings += 1;
      const output = applyEdits(sourceBytes, edits);
      outputs.set(output.toString("base64"), output);
      return;
    }
    for (const candidate of candidateSets[groupIndex]!) {
      if (candidate.start < previousEnd) continue;
      visit(groupIndex + 1, candidate.end, [...edits, ...candidate.edits]);
    }
  };

  visit(0, 0, []);
  return { outputs, exhaustive };
}

export function candidateFollows(
  candidate: EditCandidate,
  previousCandidates: readonly EditCandidate[],
): boolean {
  return previousCandidates.some((previous) => candidate.start >= previous.end);
}

export function noOrderedMappingDetails(
  path: string,
  groups: readonly EditGroup[],
  candidateSets: readonly EditCandidate[][],
): FormatterMatchError {
  let reachable = [...candidateSets[0]!];
  for (let groupIndex = 1; groupIndex < candidateSets.length; groupIndex++) {
    const groupCandidates = candidateSets[groupIndex]!;
    const nextReachable = groupCandidates.filter((candidate) =>
      candidateFollows(candidate, reachable),
    );
    if (nextReachable.length > 0) {
      reachable = nextReachable;
      continue;
    }
    const reverseOrdered = groupCandidates.some((candidate) =>
      reachable.some((previous) => candidate.end <= previous.start),
    );
    const overlapping = groupCandidates.some((candidate) =>
      reachable.some(
        (previous) => candidate.start < previous.end && candidate.end > previous.start,
      ),
    );
    const excerpt = oldExcerpt(groups[groupIndex]!);
    const details: FormatterMatchFailureDetails = {
      reason: "no-ordered-mapping",
      path,
      groupCount: groups.length,
      groupIndex: groupIndex + 1,
      chunkCount: groups[groupIndex]!.chunkCount,
      chunkIndex: groups[groupIndex]!.chunkIndex,
      candidateCount: groupCandidates.length,
      candidates: candidateRanges(groupCandidates),
      previousGroupIndex: groupIndex,
      previousCandidates: candidateRanges(reachable),
      ...(reverseOrdered ? { reverseOrdered: true } : {}),
      ...(overlapping ? { overlapping: true } : {}),
      ...(excerpt ? { oldExcerpt: excerpt } : {}),
    };
    return new FormatterMatchError(formatFormatterMatchFailure(details), details);
  }
  const details: FormatterMatchFailureDetails = {
    reason: "no-ordered-mapping",
    path,
    groupCount: groups.length,
    candidateCount: 0,
    candidates: [],
  };
  return new FormatterMatchError(formatFormatterMatchFailure(details), details);
}

export async function formatterCandidates(
  group: EditGroup,
  normalized: ReturnType<typeof normalizedSource>,
  path: string,
  documentCache: Map<string, Promise<StructuralDocument[]>>,
  signal?: AbortSignal,
): Promise<EditCandidate[]> {
  const lineLevelCandidates =
    group.oldLines.length === 0
      ? insertionCandidates(group, normalized.lines, normalized.lineStarts, path)
      : lineCandidates(group, normalized.lines, normalized.lineStarts, path);
  if (group.oldLines.length === 0) return lineLevelCandidates;

  const grammar = grammarForPath(path) ?? (isMarkdownPath(path) ? fenceGrammar(group) : undefined);
  if (!grammar) return lineLevelCandidates;
  const cacheKey = `${isMarkdownPath(path) ? "embedded:" : "file:"}${grammar}`;
  let documentsPromise = documentCache.get(cacheKey);
  if (!documentsPromise) {
    documentsPromise = structuralDocuments(
      path,
      group,
      normalized.source,
      normalized.lines,
      normalized.lineStarts,
      signal,
    );
    documentCache.set(cacheKey, documentsPromise);
  }
  const documents = await documentsPromise;
  const structuralCandidates = (
    await Promise.all(
      documents.map((document) =>
        tokenCandidates(
          group,
          document,
          normalized.source,
          normalized.lines,
          normalized.lineStarts,
          path,
          signal,
        ),
      ),
    )
  ).flat();
  return deduplicateCandidates([...lineLevelCandidates, ...structuralCandidates]);
}

export async function requestedReplacementCandidates(
  group: EditGroup,
  normalized: ReturnType<typeof normalizedSource>,
  path: string,
  documentCache: Map<string, Promise<StructuralDocument[]>>,
  signal?: AbortSignal,
): Promise<EditCandidate[]> {
  if (group.oldLines.length === 0 || group.newLines.length === 0) return [];
  return formatterCandidates(
    {
      ...group,
      oldLines: group.newLines,
      newLines: group.newLines,
    },
    normalized,
    path,
    documentCache,
    signal,
  );
}

export async function deriveFormatterTolerantContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const groups = editGroups(chunks);
  if (groups.length === 0) return undefined;
  const normalized = normalizedSource(content);
  const documentCache = new Map<string, Promise<StructuralDocument[]>>();
  const candidates: EditCandidate[][] = [];

  for (const [groupIndex, group] of groups.entries()) {
    throwIfAborted(signal);
    const groupCandidates = await formatterCandidates(
      group,
      normalized,
      path,
      documentCache,
      signal,
    );
    const eligible = enforceCandidateLimit(groupCandidates, path, group, groupIndex, groups.length);
    if (eligible.length === 0) {
      const replacements = await requestedReplacementCandidates(
        group,
        normalized,
        path,
        documentCache,
        signal,
      );
      const excerpt = oldExcerpt(group);
      const details: FormatterMatchFailureDetails = {
        reason: "no-candidate",
        path,
        groupCount: groups.length,
        groupIndex: groupIndex + 1,
        chunkCount: group.chunkCount,
        chunkIndex: group.chunkIndex,
        candidateCount: 0,
        candidates: [],
        ...(replacements.length > 0
          ? {
              replacementCandidateCount: replacements.length,
              replacementCandidates: candidateRanges(replacements),
            }
          : {}),
        ...(excerpt ? { oldExcerpt: excerpt } : {}),
      };
      throw new FormatterMatchError(formatFormatterMatchFailure(details), details);
    }
    candidates.push(eligible);
  }

  let outputs: Map<string, Buffer>;
  let exhaustive: boolean;
  try {
    ({ outputs, exhaustive } = distinctMappedOutputs(normalized.source, candidates, signal));
  } catch (error) {
    if (!(error instanceof OverlappingFormatterEditsError)) throw error;
    const details: FormatterMatchFailureDetails = {
      reason: "overlapping-edits",
      path,
      groupCount: groups.length,
      candidateCount: candidates.reduce((count, group) => count + group.length, 0),
      candidates: candidateRanges(candidates.flat()),
      overlapping: true,
    };
    throw new FormatterMatchAmbiguityError(formatFormatterMatchFailure(details), details);
  }
  if (outputs.size === 0) throw noOrderedMappingDetails(path, groups, candidates);
  if (outputs.size > 1) {
    const details: FormatterMatchFailureDetails = {
      reason: "ambiguous-output",
      path,
      groupCount: groups.length,
      candidateCount: candidates.reduce((count, group) => count + group.length, 0),
      candidates: candidateRanges(candidates.flat()),
    };
    throw new FormatterMatchAmbiguityError(formatFormatterMatchFailure(details), details);
  }
  if (!exhaustive) {
    const details: FormatterMatchFailureDetails = {
      reason: "mapping-limit",
      path,
      groupCount: groups.length,
      candidateCount: candidates.reduce((count, group) => count + group.length, 0),
      candidates: candidateRanges(candidates.flat()),
    };
    throw new FormatterMatchAmbiguityError(formatFormatterMatchFailure(details), details);
  }
  return outputs.values().next().value!.toString("utf8");
}
