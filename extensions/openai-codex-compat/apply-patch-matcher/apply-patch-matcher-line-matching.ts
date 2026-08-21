import { extname } from "node:path";
import type { GrammarName } from "@2h2d/tree-sitter-wasms";
import { MATCH_MODES, type MatchMode } from "./apply-patch-matcher-contracts.ts";

export const GRAMMAR_BY_FENCE_INFO = new Map<string, GrammarName>([
  ["js", "javascript"],
  ["javascript", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["tsx", "tsx"],
  ["py", "python"],
  ["python", "python"],
  ["go", "go"],
  ["java", "java"],
  ["scala", "scala"],
]);

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("apply_patch was cancelled.");
}

export function isRustWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export function rustTrimStart(value: string): string {
  let index = 0;
  while (index < value.length && isRustWhitespace(value.charCodeAt(index))) index += 1;
  return value.slice(index);
}

export function rustTrimEnd(value: string): string {
  let index = value.length;
  while (index > 0 && isRustWhitespace(value.charCodeAt(index - 1))) index -= 1;
  return value.slice(0, index);
}

export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}

export function normalizeFuzzyText(value: string): string {
  const replacements = new Map(
    Object.entries({
      "\u2010": "-",
      "\u2011": "-",
      "\u2012": "-",
      "\u2013": "-",
      "\u2014": "-",
      "\u2015": "-",
      "\u2212": "-",
      "\u2018": "'",
      "\u2019": "'",
      "\u201a": "'",
      "\u201b": "'",
      "\u201c": '"',
      "\u201d": '"',
      "\u201e": '"',
      "\u201f": '"',
      "\u00a0": " ",
      "\u2002": " ",
      "\u2003": " ",
      "\u2004": " ",
      "\u2005": " ",
      "\u2006": " ",
      "\u2007": " ",
      "\u2008": " ",
      "\u2009": " ",
      "\u200a": " ",
      "\u202f": " ",
      "\u205f": " ",
      "\u3000": " ",
    } as const),
  );
  return Array.from(rustTrim(value))
    .map((character) => replacements.get(character) ?? character)
    .join("");
}

export function linesMatch(actual: string, expected: string, mode: MatchMode): boolean {
  switch (mode) {
    case "exact":
      return actual === expected;
    case "trim-end":
      return rustTrimEnd(actual) === rustTrimEnd(expected);
    case "trim":
      return rustTrim(actual) === rustTrim(expected);
    case "unicode":
      return normalizeFuzzyText(actual) === normalizeFuzzyText(expected);
  }
}

export function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
  mode: MatchMode,
): boolean {
  if (index + pattern.length > lines.length) return false;
  return pattern.every((expected, offset) => {
    const actual = lines[index + offset];
    return actual !== undefined && linesMatch(actual, expected, mode);
  });
}

export function findSequences(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number[] {
  if (pattern.length === 0) return [start];
  if (pattern.length > lines.length) return [];
  const last = lines.length - pattern.length;
  const searchStart = endOfFile ? last : start;
  for (const mode of MATCH_MODES) {
    const matches: number[] = [];
    for (let index = searchStart; index <= last; index++) {
      if (sequenceMatches(lines, pattern, index, mode)) matches.push(index);
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

export function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  return findSequences(lines, pattern, start, endOfFile)[0];
}

export function isMarkdownPath(path: string): boolean {
  return [".md", ".markdown"].includes(extname(path).toLowerCase());
}

export function markdownTableCells(line: string): string[] | undefined {
  const trimmed = rustTrim(line);
  if (
    !trimmed.startsWith("|") ||
    !trimmed.endsWith("|") ||
    trimmed.includes("\\|") ||
    trimmed.includes("`")
  ) {
    return undefined;
  }
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => rustTrim(cell));
  return cells.length >= 2 ? cells : undefined;
}

export function markdownTableLinesMatch(actual: string, expected: string): boolean {
  const actualCells = markdownTableCells(actual);
  const expectedCells = markdownTableCells(expected);
  return (
    actualCells !== undefined &&
    expectedCells !== undefined &&
    actualCells.length === expectedCells.length &&
    actualCells.every((cell, index) => cell === expectedCells[index])
  );
}

export function withoutCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

export function markdownTolerantLineIsSafe(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return (
    !/[\t ]{2}$|\\$/u.test(withoutCarriageReturn(actual)) &&
    !/[\t ]{2}$|\\$/u.test(withoutCarriageReturn(expected))
  );
}

export function findTolerantSequences(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
  path: string,
): number[] {
  const ordinary = findSequences(lines, pattern, start, endOfFile).filter(
    (index) =>
      !isMarkdownPath(path) ||
      pattern.every((expected, offset) => {
        const actual = lines[index + offset];
        return actual !== undefined && markdownTolerantLineIsSafe(actual, expected);
      }),
  );
  if (ordinary.length > 0 || !isMarkdownPath(path) || pattern.length === 0) return ordinary;
  if (!pattern.every((line) => markdownTableCells(line) !== undefined)) return [];

  const last = lines.length - pattern.length;
  const searchStart = endOfFile ? last : start;
  const fencedLines = markdownFencedLines(lines);
  const matches: number[] = [];
  for (let index = searchStart; index <= last; index++) {
    if (
      !pattern.some((_, offset) => fencedLines.has(index + offset)) &&
      pattern.every((expected, offset) => {
        const actual = lines[index + offset];
        return actual !== undefined && markdownTableLinesMatch(actual, expected);
      })
    ) {
      matches.push(index);
    }
  }
  return matches;
}

export function withLineEnding(line: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" && !line.endsWith("\r") ? `${line}\r` : line;
}

export function lineEndingForLine(sourceLines: readonly string[], line: number): "\n" | "\r\n" {
  return sourceLines[line]?.endsWith("\r") ? "\r\n" : "\n";
}

export function lineEndingAtBoundary(sourceLines: readonly string[], line: number): "\n" | "\r\n" {
  const adjacent = sourceLines[line - 1] ?? sourceLines[line];
  return adjacent?.endsWith("\r") ? "\r\n" : "\n";
}

export function replacementLines(
  lines: readonly string[],
  lineEnding: "\n" | "\r\n",
  trailingNewline = true,
): Buffer {
  return lines.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(`${lines.join(lineEnding)}${trailingNewline ? lineEnding : ""}`, "utf8");
}

export interface FenceOpening {
  marker: "`" | "~";
  length: number;
  grammar?: GrammarName;
}

export function fenceOpening(line: string): FenceOpening | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*([A-Za-z0-9_+-]+)?[^\r\n]*$/u);
  if (!match) return undefined;
  const delimiter = match[1];
  if (!delimiter) return undefined;
  const marker = delimiter[0];
  if (marker !== "`" && marker !== "~") return undefined;
  const grammar = match[2] ? GRAMMAR_BY_FENCE_INFO.get(match[2].toLowerCase()) : undefined;
  const opening: FenceOpening = {
    marker,
    length: delimiter.length,
  };
  if (grammar) opening.grammar = grammar;
  return opening;
}

export function fenceClosing(line: string, opening: FenceOpening): boolean {
  const marker = opening.marker === "`" ? "`" : "~";
  const match = line.match(new RegExp(`^ {0,3}(${marker}{${opening.length},})[\\t ]*$`, "u"));
  return match !== null;
}

export function markdownFencedLines(sourceLines: readonly string[]): Set<number> {
  const fenced = new Set<number>();
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index];
    if (sourceLine === undefined) continue;
    const opening = fenceOpening(sourceLine);
    if (!opening) continue;
    fenced.add(index);
    index += 1;
    while (index < sourceLines.length) {
      const fencedLine = sourceLines[index];
      if (fencedLine === undefined) break;
      fenced.add(index);
      if (fenceClosing(fencedLine, opening)) break;
      index += 1;
    }
  }
  return fenced;
}
