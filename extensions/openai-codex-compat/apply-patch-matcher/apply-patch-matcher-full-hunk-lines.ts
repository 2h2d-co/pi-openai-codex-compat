import {
  MATCH_MODES,
  type MatchMode,
  type UpdateChunk,
  type UpdateHunkLine,
} from "./apply-patch-matcher-contracts.ts";
import { findSequences, linesMatch } from "./apply-patch-matcher-line-matching.ts";

// This module constructs proof data only. The production mutation path remains
// strict-only until candidate completeness and output-equivalence gates are complete.

export type FullHunkAnchorWitness = {
  patchText: string;
  sourceLine: number;
  mode: MatchMode;
};

export type FullHunkOldLineWitness = {
  patchLine: number;
  sourceLine: number;
  kind: "context" | "delete";
  patchText: string;
  mode: MatchMode;
};

export type FullHunkLineEdit = {
  sourceStartLine: number;
  sourceEndLine: number;
  newLines: string[];
};

export type FullHunkLineWitness = {
  chunkIndex: number;
  chunkCount: number;
  orderStartLine: number;
  orderEndLine: number;
  anchor?: FullHunkAnchorWitness;
  oldLines: FullHunkOldLineWitness[];
  explicitEndOfFile: boolean;
};

export type FullHunkLineCandidate = {
  witness: FullHunkLineWitness;
  edits: FullHunkLineEdit[];
};

export type FullHunkLineChunkCandidates =
  | {
      kind: "inert";
      chunkIndex: number;
      chunkCount: number;
    }
  | {
      kind: "witnessed";
      chunkIndex: number;
      chunkCount: number;
      candidates: FullHunkLineCandidate[];
    };

type AnchorMatch = {
  sourceLine: number;
  mode: MatchMode;
};

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateChunkLineRoles(chunk: UpdateChunk): void {
  const oldLines = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
  const newLines = chunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
  if (!arraysEqual(chunk.oldLines, oldLines) || !arraysEqual(chunk.newLines, newLines)) {
    throw new Error("Patch chunk line roles disagree with its old or new line sequence.");
  }
}

function sourceLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function matchMode(actual: string, expected: string): MatchMode {
  const mode = MATCH_MODES.find((candidate) => linesMatch(actual, expected, candidate));
  if (!mode) throw new Error("A matched line has no matching mode.");
  return mode;
}

function anchorMatches(
  chunk: UpdateChunk,
  lines: readonly string[],
): Array<AnchorMatch | undefined> {
  if (chunk.context === undefined) return [undefined];
  const context = chunk.context;
  return findSequences(lines, [context], 0, false).map((sourceLine) => {
    const actual = lines[sourceLine];
    if (actual === undefined) throw new Error("Anchor line is outside the source.");
    return {
      sourceLine,
      mode: matchMode(actual, context),
    };
  });
}

function oldLineWitnesses(
  chunk: UpdateChunk,
  lines: readonly string[],
  sourceStartLine: number,
): FullHunkOldLineWitness[] {
  const witnesses: FullHunkOldLineWitness[] = [];
  let sourceLine = sourceStartLine;
  for (const [patchLine, line] of chunk.lines.entries()) {
    if (line.kind === "add") continue;
    const actual = lines[sourceLine];
    if (actual === undefined) throw new Error("Old-hunk witness line is outside the source.");
    witnesses.push({
      patchLine,
      sourceLine,
      kind: line.kind,
      patchText: line.text,
      mode: matchMode(actual, line.text),
    });
    sourceLine += 1;
  }
  return witnesses;
}

function lineEdits(chunk: UpdateChunk, sourceStartLine: number): FullHunkLineEdit[] {
  const edits: FullHunkLineEdit[] = [];
  let patchLine = 0;
  let sourceLine = sourceStartLine;

  while (patchLine < chunk.lines.length) {
    const line = chunk.lines[patchLine];
    if (line === undefined) throw new Error("Patch line is outside the chunk.");
    if (line.kind === "context") {
      patchLine += 1;
      sourceLine += 1;
      continue;
    }

    const sourceStartLine = sourceLine;
    const newLines: string[] = [];
    while (patchLine < chunk.lines.length) {
      const editLine: UpdateHunkLine | undefined = chunk.lines[patchLine];
      if (editLine === undefined) throw new Error("Patch line is outside the chunk.");
      if (editLine.kind === "context") break;
      if (editLine.kind === "delete") sourceLine += 1;
      else newLines.push(editLine.text);
      patchLine += 1;
    }
    edits.push({
      sourceStartLine,
      sourceEndLine: sourceLine,
      newLines,
    });
  }

  return edits;
}

function fullOldSideCandidates(
  chunk: UpdateChunk,
  chunkIndex: number,
  chunkCount: number,
  lines: readonly string[],
  anchors: ReadonlyArray<AnchorMatch | undefined>,
): FullHunkLineCandidate[] {
  const candidates: FullHunkLineCandidate[] = [];
  const starts = findSequences(lines, chunk.oldLines, 0, chunk.endOfFile);
  for (const anchor of anchors) {
    const minimumStart = anchor ? anchor.sourceLine + 1 : 0;
    for (const oldStartLine of starts.filter((start) => start >= minimumStart)) {
      const oldEndLine = oldStartLine + chunk.oldLines.length;
      const witness: FullHunkLineWitness = {
        chunkIndex,
        chunkCount,
        orderStartLine: anchor?.sourceLine ?? oldStartLine,
        orderEndLine: oldEndLine,
        oldLines: oldLineWitnesses(chunk, lines, oldStartLine),
        explicitEndOfFile: chunk.endOfFile,
      };
      if (anchor) {
        witness.anchor = {
          patchText: chunk.context ?? "",
          sourceLine: anchor.sourceLine,
          mode: anchor.mode,
        };
      }
      candidates.push({
        witness,
        edits: lineEdits(chunk, oldStartLine),
      });
    }
  }
  return candidates;
}

function boundaryCandidates(
  chunk: UpdateChunk,
  chunkIndex: number,
  chunkCount: number,
  lines: readonly string[],
  anchors: ReadonlyArray<AnchorMatch | undefined>,
): FullHunkLineCandidate[] {
  const candidates: FullHunkLineCandidate[] = [];
  for (const anchor of anchors) {
    const boundary = chunk.endOfFile ? lines.length : anchor ? anchor.sourceLine + 1 : undefined;
    if (boundary === undefined) continue;
    const witness: FullHunkLineWitness = {
      chunkIndex,
      chunkCount,
      orderStartLine: anchor?.sourceLine ?? boundary,
      orderEndLine: boundary,
      oldLines: [],
      explicitEndOfFile: chunk.endOfFile,
    };
    if (anchor) {
      witness.anchor = {
        patchText: chunk.context ?? "",
        sourceLine: anchor.sourceLine,
        mode: anchor.mode,
      };
    }
    candidates.push({
      witness,
      edits: lineEdits(chunk, boundary),
    });
  }
  return candidates;
}

function chunkCandidates(
  chunk: UpdateChunk,
  chunkIndex: number,
  chunkCount: number,
  lines: readonly string[],
): FullHunkLineChunkCandidates {
  validateChunkLineRoles(chunk);
  const index = chunkIndex + 1;
  const hasEvidence = chunk.context !== undefined || chunk.oldLines.length > 0 || chunk.endOfFile;
  const hasEdits = chunk.lines.some((line) => line.kind !== "context");
  if (!hasEvidence && !hasEdits) {
    return {
      kind: "inert",
      chunkIndex: index,
      chunkCount,
    };
  }

  const anchors = anchorMatches(chunk, lines);
  const candidates =
    chunk.oldLines.length > 0
      ? fullOldSideCandidates(chunk, index, chunkCount, lines, anchors)
      : boundaryCandidates(chunk, index, chunkCount, lines, anchors);
  return {
    kind: "witnessed",
    chunkIndex: index,
    chunkCount,
    candidates,
  };
}

export function fullHunkLineCandidateSets(
  content: string,
  chunks: readonly UpdateChunk[],
): FullHunkLineChunkCandidates[] {
  const lines = sourceLines(content);
  return chunks.map((chunk, index) => chunkCandidates(chunk, index, chunks.length, lines));
}

function follows(previous: FullHunkLineCandidate, next: FullHunkLineCandidate): boolean {
  return next.witness.orderStartLine >= previous.witness.orderEndLine;
}

export function orderedFullHunkLineCandidateSets(
  chunks: readonly FullHunkLineChunkCandidates[],
): FullHunkLineChunkCandidates[] | undefined {
  const witnessed = chunks.filter(
    (chunk): chunk is Extract<FullHunkLineChunkCandidates, { kind: "witnessed" }> =>
      chunk.kind === "witnessed",
  );
  if (witnessed.some((chunk) => chunk.candidates.length === 0)) return undefined;
  if (witnessed.length === 0) return [...chunks];

  const forward: FullHunkLineCandidate[][] = [];
  for (const [index, chunk] of witnessed.entries()) {
    const previous = forward[index - 1];
    const reachable =
      previous === undefined
        ? [...chunk.candidates]
        : chunk.candidates.filter((candidate) =>
            previous.some((priorCandidate) => follows(priorCandidate, candidate)),
          );
    if (reachable.length === 0) return undefined;
    forward.push(reachable);
  }

  const ordered = new Map<number, FullHunkLineCandidate[]>();
  let following = forward.at(-1) ?? [];
  for (let index = witnessed.length - 1; index >= 0; index -= 1) {
    const chunk = witnessed[index];
    const reachable = forward[index];
    if (chunk === undefined || reachable === undefined) {
      throw new Error("Witnessed chunk index is outside the candidate sets.");
    }
    const retained =
      index === witnessed.length - 1
        ? following
        : reachable.filter((candidate) =>
            following.some((nextCandidate) => follows(candidate, nextCandidate)),
          );
    if (retained.length === 0) return undefined;
    ordered.set(chunk.chunkIndex, retained);
    following = retained;
  }

  return chunks.map((chunk) =>
    chunk.kind === "inert"
      ? chunk
      : {
          ...chunk,
          candidates: ordered.get(chunk.chunkIndex) ?? [],
        },
  );
}
