import type { UpdateChunk } from "./apply-patch-matcher-contracts.ts";
import {
  findSequence,
  lineEndingAtBoundary,
  lineEndingForLine,
  withLineEnding,
  withoutCarriageReturn,
} from "./apply-patch-matcher-line-matching.ts";

export function deriveStrictContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: Array<{ index: number; oldLength: number; newLines: string[] }> = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context) {
      const contextIndex = findSequence(lines, [chunk.context], cursor, false);
      if (contextIndex === undefined) {
        throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
      }
      cursor = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      replacements.push({
        index: insertionIndex,
        oldLength: 0,
        newLines: strictReplacementLines(lines, insertionIndex, 0, chunk, chunk.newLines),
      });
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = findSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (found === undefined && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = findSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (found === undefined) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push({
      index: found,
      oldLength: oldLines.length,
      newLines: strictReplacementLines(lines, found, oldLines.length, chunk, newLines),
    });
    cursor = found + oldLines.length;
  }

  replacements.sort((left, right) => left.index - right.index);
  for (const replacement of replacements.toReversed()) {
    lines.splice(replacement.index, replacement.oldLength, ...replacement.newLines);
  }
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

export function strictReplacementLines(
  sourceLines: readonly string[],
  startLine: number,
  oldLength: number,
  chunk: UpdateChunk,
  newLines: readonly string[],
): string[] {
  const roleAware: string[] = [];
  let sourceOffset = 0;
  for (const line of chunk.lines) {
    if (line.kind === "delete") {
      sourceOffset += 1;
      continue;
    }
    const lineEnding =
      line.kind === "context"
        ? lineEndingForLine(sourceLines, startLine + sourceOffset)
        : lineEndingAtBoundary(sourceLines, startLine + sourceOffset);
    roleAware.push(withLineEnding(line.text, lineEnding));
    if (line.kind === "context") sourceOffset += 1;
  }
  if (
    roleAware.length === newLines.length &&
    roleAware.every((line, index) => withoutCarriageReturn(line) === newLines[index])
  ) {
    return roleAware;
  }

  return newLines.map((line, index) => {
    const lineEnding =
      oldLength === 0
        ? lineEndingAtBoundary(sourceLines, startLine)
        : lineEndingForLine(sourceLines, startLine + Math.min(index, oldLength - 1));
    return withLineEnding(line, lineEnding);
  });
}
