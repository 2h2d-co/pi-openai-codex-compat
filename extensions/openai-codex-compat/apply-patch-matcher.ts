import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { wasmURL, type GrammarName } from "@2h2d/tree-sitter-wasms";
import { Language, type Node as SyntaxNode, Parser } from "web-tree-sitter";

export type UpdateHunkLine = {
  kind: "add" | "context" | "delete";
  text: string;
};

export type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  lines: UpdateHunkLine[];
  endOfFile: boolean;
};

type MatchMode = "exact" | "trim-end" | "trim" | "unicode";

type ByteEdit = {
  start: number;
  end: number;
  replacement: Buffer;
};

type EditCandidate = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  score: number;
  edits: ByteEdit[];
};

type EditGroup = {
  chunk: UpdateChunk;
  oldLines: string[];
  newLines: string[];
  beforeContext: string[];
  afterContext: string[];
};

type SyntaxPathEntry = {
  id: number;
  type: string;
};

type SyntaxToken = {
  type: string;
  text: string;
  start: number;
  end: number;
  parentType?: string;
  path: SyntaxPathEntry[];
  unsafe: boolean;
};

type StructuralDocument = {
  grammar: GrammarName;
  tokens: SyntaxToken[];
};

type WrappedFragment = {
  source: string;
  start: number;
  end: number;
};

const MATCH_MODES: readonly MatchMode[] = ["exact", "trim-end", "trim", "unicode"];
const MAX_CANDIDATES_PER_GROUP = 64;
const MAX_COMPLETE_MAPPINGS = 256;

const GRAMMAR_BY_EXTENSION = new Map<string, GrammarName>([
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".java", "java"],
  [".scala", "scala"],
  [".sc", "scala"],
  [".sbt", "scala"],
]);

const GRAMMAR_BY_FENCE_INFO = new Map<string, GrammarName>([
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

const OPTIONAL_TRAILING_COMMA_PARENTS: Partial<Record<GrammarName, ReadonlySet<string>>> = {
  javascript: new Set(["arguments", "array", "formal_parameters", "object"]),
  jsx: new Set(["arguments", "array", "formal_parameters", "object"]),
  typescript: new Set(["arguments", "array", "formal_parameters", "object"]),
  tsx: new Set(["arguments", "array", "formal_parameters", "object"]),
  python: new Set(["argument_list", "dictionary", "list", "parameters", "set"]),
  go: new Set([
    "argument_list",
    "composite_literal",
    "literal_value",
    "parameter_list",
    "type_arguments",
  ]),
  java: new Set(["annotation_argument_list", "array_initializer"]),
  scala: new Set(["arguments", "bindings", "parameters"]),
};

const languagePromises = new Map<GrammarName, Promise<Language>>();
let parserInitialization: Promise<void> | undefined;

export class FormatterMatchAmbiguityError extends Error {}

function isRustWhitespace(codePoint: number): boolean {
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

function rustTrimStart(value: string): string {
  let index = 0;
  while (index < value.length && isRustWhitespace(value.charCodeAt(index))) index += 1;
  return value.slice(index);
}

function rustTrimEnd(value: string): string {
  let index = value.length;
  while (index > 0 && isRustWhitespace(value.charCodeAt(index - 1))) index -= 1;
  return value.slice(0, index);
}

function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}

function normalizeFuzzyText(value: string): string {
  const replacements: Record<string, string> = {
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
  };
  return Array.from(rustTrim(value))
    .map((character) => replacements[character] ?? character)
    .join("");
}

function linesMatch(actual: string, expected: string, mode: MatchMode): boolean {
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

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
  mode: MatchMode,
): boolean {
  if (index + pattern.length > lines.length) return false;
  return pattern.every((expected, offset) => linesMatch(lines[index + offset]!, expected, mode));
}

function findSequences(
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

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  return findSequences(lines, pattern, start, endOfFile)[0];
}

function isMarkdownPath(path: string): boolean {
  return [".md", ".markdown"].includes(extname(path).toLowerCase());
}

function markdownTableCells(line: string): string[] | undefined {
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

function markdownTableLinesMatch(actual: string, expected: string): boolean {
  const actualCells = markdownTableCells(actual);
  const expectedCells = markdownTableCells(expected);
  return (
    actualCells !== undefined &&
    expectedCells !== undefined &&
    actualCells.length === expectedCells.length &&
    actualCells.every((cell, index) => cell === expectedCells[index])
  );
}

function markdownTolerantLineIsSafe(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return !/[\t ]{2}$|\\$/u.test(actual) && !/[\t ]{2}$|\\$/u.test(expected);
}

function findTolerantSequences(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
  path: string,
): number[] {
  const ordinary = findSequences(lines, pattern, start, endOfFile).filter(
    (index) =>
      !isMarkdownPath(path) ||
      pattern.every((expected, offset) =>
        markdownTolerantLineIsSafe(lines[index + offset]!, expected),
      ),
  );
  if (ordinary.length > 0 || !isMarkdownPath(path) || pattern.length === 0) return ordinary;
  if (!pattern.every((line) => markdownTableCells(line) !== undefined)) return [];

  const last = lines.length - pattern.length;
  const searchStart = endOfFile ? last : start;
  const matches: number[] = [];
  for (let index = searchStart; index <= last; index++) {
    if (
      pattern.every((expected, offset) => markdownTableLinesMatch(lines[index + offset]!, expected))
    ) {
      matches.push(index);
    }
  }
  return matches;
}

function isSafeMarkdownProseLine(line: string): boolean {
  const trimmed = rustTrim(line);
  return (
    trimmed.length > 0 &&
    line === rustTrimStart(line) &&
    !/^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|```|~~~|\|)/u.test(trimmed) &&
    !/^(?:={2,}|-{3,}|\*{3,}|_{3,})$/u.test(trimmed) &&
    !Array.from(trimmed).some((character) => ["`", "<", ">", "[", "]", "\\"].includes(character)) &&
    !/[\t ]{2,}/u.test(trimmed) &&
    !/[\t ]{2}$/u.test(line)
  );
}

function markdownProseKey(lines: readonly string[]): string | undefined {
  if (lines.length === 0 || !lines.every(isSafeMarkdownProseLine)) return undefined;
  return lines.map((line) => rustTrim(line)).join(" ");
}

function markdownProseRanges(lines: readonly string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length;) {
    if (!isSafeMarkdownProseLine(lines[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && isSafeMarkdownProseLine(lines[index]!)) index += 1;
    ranges.push({ start, end: index });
  }
  return ranges;
}

function trailingMarkdownProse(lines: readonly string[]): string[] {
  let start = lines.length;
  while (start > 0 && isSafeMarkdownProseLine(lines[start - 1]!)) start -= 1;
  return lines.slice(start);
}

function leadingMarkdownProse(lines: readonly string[]): string[] {
  let end = 0;
  while (end < lines.length && isSafeMarkdownProseLine(lines[end]!)) end += 1;
  return lines.slice(0, end);
}

function deriveStrictContent(
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
        newLines: [...chunk.newLines],
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
      newLines: [...newLines],
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

function editGroups(chunks: readonly UpdateChunk[]): EditGroup[] {
  const groups: EditGroup[] = [];
  for (const chunk of chunks) {
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
      groups.push({
        chunk,
        oldLines: segment.filter((line) => line.kind === "delete").map((line) => line.text),
        newLines: segment.filter((line) => line.kind === "add").map((line) => line.text),
        beforeContext: chunk.lines.slice(beforeStart, start).map((line) => line.text),
        afterContext: chunk.lines.slice(index, afterEnd).map((line) => line.text),
      });
    }
  }
  return groups;
}

function normalizedSource(content: string): {
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

function lineForByte(lineStarts: readonly number[], byte: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= byte) low = middle;
    else high = middle - 1;
  }
  return low;
}

function contextMatchScore(actual: string, expected: string, path: string): number {
  for (const [index, mode] of MATCH_MODES.entries()) {
    if (linesMatch(actual, expected, mode)) return MATCH_MODES.length - index;
  }
  if (isMarkdownPath(path) && markdownTableLinesMatch(actual, expected)) return 1;
  return 0;
}

function candidateScore(
  group: EditGroup,
  sourceLines: readonly string[],
  startLine: number,
  endLine: number,
  path: string,
): number {
  let score = 0;
  let sourceIndex = startLine - 1;
  for (const expected of group.beforeContext.toReversed()) {
    if (sourceIndex < 0) break;
    const lineScore = contextMatchScore(sourceLines[sourceIndex]!, expected, path);
    if (lineScore === 0) break;
    score += lineScore;
    sourceIndex -= 1;
  }
  sourceIndex = endLine;
  for (const expected of group.afterContext) {
    if (sourceIndex >= sourceLines.length) break;
    const lineScore = contextMatchScore(sourceLines[sourceIndex]!, expected, path);
    if (lineScore === 0) break;
    score += lineScore;
    sourceIndex += 1;
  }
  if (group.chunk.context) {
    const anchor = group.chunk.context;
    for (let index = 0; index < startLine; index++) {
      if (contextMatchScore(sourceLines[index]!, anchor, path) > 0) {
        score += 2;
        break;
      }
    }
  }
  return score;
}

function keepBestCandidates(candidates: EditCandidate[], path: string): EditCandidate[] {
  if (candidates.length === 0) return [];
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  if (best.length > MAX_CANDIDATES_PER_GROUP) {
    throw new FormatterMatchAmbiguityError(
      `Formatter-tolerant match is ambiguous in ${path}: more than ${MAX_CANDIDATES_PER_GROUP} equally ranked locations`,
    );
  }
  return best;
}

function lineCandidates(
  group: EditGroup,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  path: string,
): EditCandidate[] {
  const starts = findTolerantSequences(sourceLines, group.oldLines, 0, group.chunk.endOfFile, path);
  const ordinary = starts.map((startLine) => {
    const endLine = startLine + group.oldLines.length;
    const start = lineStarts[startLine]!;
    const end = lineStarts[endLine]!;
    const replacement =
      group.newLines.length === 0
        ? Buffer.alloc(0)
        : Buffer.from(`${group.newLines.join("\n")}\n`, "utf8");
    return {
      start,
      end,
      startLine,
      endLine,
      score: candidateScore(group, sourceLines, startLine, endLine, path),
      edits: [{ start, end, replacement }],
    };
  });
  if (ordinary.length > 0 || !isMarkdownPath(path)) return ordinary;

  const expectedKey = markdownProseKey(group.oldLines);
  if (!expectedKey) return [];
  return markdownProseRanges(sourceLines).flatMap((range) => {
    if (
      markdownProseKey(sourceLines.slice(range.start, range.end)) !== expectedKey ||
      (group.chunk.endOfFile && range.end !== sourceLines.length)
    ) {
      return [];
    }
    const start = lineStarts[range.start]!;
    const end = lineStarts[range.end]!;
    const replacement =
      group.newLines.length === 0
        ? Buffer.alloc(0)
        : Buffer.from(`${group.newLines.join("\n")}\n`, "utf8");
    return [
      {
        start,
        end,
        startLine: range.start,
        endLine: range.end,
        score: candidateScore(group, sourceLines, range.start, range.end, path),
        edits: [{ start, end, replacement }],
      },
    ];
  });
}

function insertionCandidates(
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
  if (isMarkdownPath(path)) {
    const beforeKey = markdownProseKey(trailingMarkdownProse(group.beforeContext));
    const afterKey = markdownProseKey(leadingMarkdownProse(group.afterContext));
    for (const range of markdownProseRanges(sourceLines)) {
      const key = markdownProseKey(sourceLines.slice(range.start, range.end));
      if (beforeKey && key === beforeKey) boundaries.add(range.end);
      if (afterKey && key === afterKey) boundaries.add(range.start);
    }
  }
  if (group.chunk.endOfFile) boundaries.add(sourceLines.length);

  const replacement = Buffer.from(`${group.newLines.join("\n")}\n`, "utf8");
  return [...boundaries].map((line) => {
    const byte = lineStarts[line]!;
    return {
      start: byte,
      end: byte,
      startLine: line,
      endLine: line,
      score: candidateScore(group, sourceLines, line, line, path),
      edits: [{ start: byte, end: byte, replacement }],
    };
  });
}

function parserInitializationPromise(): Promise<void> {
  return (parserInitialization ??= Parser.init());
}

async function loadLanguage(grammar: GrammarName): Promise<Language> {
  let promise = languagePromises.get(grammar);
  if (!promise) {
    promise = (async () => {
      await parserInitializationPromise();
      return Language.load(fileURLToPath(wasmURL(grammar)));
    })();
    languagePromises.set(grammar, promise);
  }
  return promise;
}

function grammarForPath(path: string): GrammarName | undefined {
  return GRAMMAR_BY_EXTENSION.get(extname(path).toLowerCase());
}

function fenceGrammar(group: EditGroup): GrammarName | undefined {
  const context = [...(group.chunk.context ? [group.chunk.context] : []), ...group.beforeContext];
  for (const line of context.toReversed()) {
    const match = rustTrim(line).match(/^(?:`{3,}|~{3,})[\t ]*([A-Za-z0-9_+-]+)/u);
    if (match) return GRAMMAR_BY_FENCE_INFO.get(match[1]!.toLowerCase());
  }
  return undefined;
}

function utf16ByteOffsets(source: string): Uint32Array {
  const offsets = new Uint32Array(source.length + 1);
  let byteOffset = 0;
  for (let index = 0; index < source.length;) {
    offsets[index] = byteOffset;
    const codePoint = source.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    if (width === 2) offsets[index + 1] = byteOffset;
    byteOffset += Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    index += width;
    offsets[index] = byteOffset;
  }
  return offsets;
}

function syntaxTokens(root: SyntaxNode, source: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const byteOffsets = utf16ByteOffsets(source);
  const visit = (node: SyntaxNode, path: SyntaxPathEntry[], unsafe: boolean): void => {
    const nextPath = [...path, { id: node.id, type: node.type }];
    const nextUnsafe = unsafe || node.isError || node.isMissing || node.type === "ERROR";
    if (node.childCount === 0) {
      if (!node.isMissing && node.endIndex > node.startIndex) {
        tokens.push({
          type: node.type,
          text: node.text,
          start: byteOffsets[node.startIndex]!,
          end: byteOffsets[node.endIndex]!,
          ...(path.at(-1)?.type ? { parentType: path.at(-1)!.type } : {}),
          path: nextPath,
          unsafe: nextUnsafe,
        });
      }
      return;
    }
    for (const child of node.children) visit(child, nextPath, nextUnsafe);
  };
  visit(root, [], false);
  return tokens;
}

function optionalTrailingComma(
  token: SyntaxToken,
  laterTokens: readonly SyntaxToken[],
  grammar: GrammarName,
): boolean {
  if (token.text !== "," || !token.parentType) return false;
  const parents = OPTIONAL_TRAILING_COMMA_PARENTS[grammar];
  if (!parents?.has(token.parentType)) return false;
  const next = laterTokens.find((candidate) => !candidate.type.includes("comment"));
  return next !== undefined && [")", "]", "}"].includes(next.text);
}

function normalizeTokens(tokens: readonly SyntaxToken[], grammar: GrammarName): SyntaxToken[] {
  return tokens.filter(
    (token, index) => !optionalTrailingComma(token, tokens.slice(index + 1), grammar),
  );
}

async function parseStructuralDocument(
  grammar: GrammarName,
  source: string,
  byteOffset = 0,
): Promise<StructuralDocument | null> {
  try {
    const language = await loadLanguage(grammar);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source);
      if (!tree) return null;
      try {
        if (tree.rootNode.hasError) return null;
        const tokens = normalizeTokens(syntaxTokens(tree.rootNode, source), grammar).map(
          (token) => ({
            ...token,
            start: token.start + byteOffset,
            end: token.end + byteOffset,
          }),
        );
        if (tokens.some((token) => token.unsafe)) return null;
        return { grammar, tokens };
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  } catch {
    return null;
  }
}

function fenceOpening(
  line: string,
): { marker: "`" | "~"; length: number; grammar?: GrammarName } | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*([A-Za-z0-9_+-]+)?[^\r\n]*$/u);
  if (!match) return undefined;
  const delimiter = match[1]!;
  const grammar = match[2] ? GRAMMAR_BY_FENCE_INFO.get(match[2].toLowerCase()) : undefined;
  return {
    marker: delimiter[0] as "`" | "~",
    length: delimiter.length,
    ...(grammar ? { grammar } : {}),
  };
}

function fenceClosing(line: string, opening: { marker: "`" | "~"; length: number }): boolean {
  const marker = opening.marker === "`" ? "`" : "~";
  const match = line.match(new RegExp(`^ {0,3}(${marker}{${opening.length},})[\\\\t ]*$`, "u"));
  return match !== null;
}

async function embeddedStructuralDocuments(
  grammar: GrammarName,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
): Promise<StructuralDocument[]> {
  const documents: StructuralDocument[] = [];
  const sourceBytes = Buffer.from(source, "utf8");
  for (let index = 0; index < sourceLines.length; index++) {
    const opening = fenceOpening(sourceLines[index]!);
    if (!opening) continue;
    const contentStart = index + 1;
    let closing = contentStart;
    while (closing < sourceLines.length && !fenceClosing(sourceLines[closing]!, opening)) {
      closing += 1;
    }
    if (closing >= sourceLines.length) break;
    if (opening.grammar === grammar) {
      const start = lineStarts[contentStart]!;
      const end = lineStarts[closing]!;
      const document = await parseStructuralDocument(
        grammar,
        sourceBytes.subarray(start, end).toString("utf8"),
        start,
      );
      if (document) documents.push(document);
    }
    index = closing;
  }
  return documents;
}

async function structuralDocuments(
  path: string,
  group: EditGroup,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
): Promise<StructuralDocument[]> {
  const grammar = grammarForPath(path);
  if (grammar) {
    const document = await parseStructuralDocument(grammar, source);
    return document ? [document] : [];
  }
  if (!isMarkdownPath(path)) return [];
  const embeddedGrammar = fenceGrammar(group);
  return embeddedGrammar
    ? embeddedStructuralDocuments(embeddedGrammar, source, sourceLines, lineStarts)
    : [];
}

function commonIndent(lines: readonly string[]): string {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[\t ]*/u)?.[0] ?? "");
  if (indents.length === 0) return "";
  let prefix = indents[0]!;
  for (const indent of indents.slice(1)) {
    while (prefix && !indent.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function dedent(value: string): string {
  const lines = value.split("\n");
  const indent = commonIndent(lines);
  return lines.map((line) => (line.trim() ? line.slice(indent.length) : "")).join("\n");
}

function indented(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function wrapped(prefix: string, fragment: string, suffix: string): WrappedFragment {
  return {
    source: `${prefix}${fragment}${suffix}`,
    start: Buffer.byteLength(prefix, "utf8"),
    end: Buffer.byteLength(`${prefix}${fragment}`, "utf8"),
  };
}

function fragmentWrappers(grammar: GrammarName, value: string): WrappedFragment[] {
  const fragment = dedent(value);
  const body = indented(fragment, "  ");
  const pythonBody = indented(fragment, "    ");
  switch (grammar) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return [
        wrapped("", fragment, "\n"),
        wrapped("function __patch__() {\n", body, "\n}\n"),
        wrapped("class __Patch__ {\n", body, "\n}\n"),
        wrapped("const __patch__ = (\n", body, "\n);\n"),
      ];
    case "python":
      return [
        wrapped("", fragment, "\n"),
        wrapped("def __patch__():\n", pythonBody, "\n"),
        wrapped("class __Patch__:\n", pythonBody, "\n"),
        wrapped("__patch__ = (\n", pythonBody, "\n)\n"),
      ];
    case "go":
      return [
        wrapped("package patch\n", fragment, "\n"),
        wrapped("package patch\nfunc __patch__() {\n", body, "\n}\n"),
        wrapped("package patch\nvar __patch__ = (\n", body, "\n)\n"),
      ];
    case "java":
      return [
        wrapped("", fragment, "\n"),
        wrapped("class __Patch__ {\n", body, "\n}\n"),
        wrapped("class __Patch__ { void __patch__() {\n", body, "\n}}\n"),
        wrapped("class __Patch__ { Object __patch__ = (\n", body, "\n); }\n"),
      ];
    case "scala":
      return [
        wrapped("", fragment, "\n"),
        wrapped("object __Patch__ {\n", body, "\n}\n"),
        wrapped("object __Patch__ { def __patch__ = {\n", body, "\n}}\n"),
        wrapped("object __Patch__ { val __patch__ = (\n", body, "\n) }\n"),
      ];
    default:
      return [];
  }
}

function fragmentCovered(fragment: WrappedFragment, tokens: readonly SyntaxToken[]): boolean {
  const bytes = Buffer.from(fragment.source, "utf8");
  const local = Buffer.from(bytes.subarray(fragment.start, fragment.end));
  for (const token of tokens) {
    const start = Math.max(token.start, fragment.start) - fragment.start;
    const end = Math.min(token.end, fragment.end) - fragment.start;
    if (start >= end) continue;
    local.fill(0x20, start, end);
  }
  return local.toString("utf8").trim().length === 0;
}

async function parseFragment(grammar: GrammarName, value: string): Promise<SyntaxToken[] | null> {
  const language = await loadLanguage(grammar);
  for (const fragment of fragmentWrappers(grammar, value)) {
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(fragment.source);
      if (!tree) continue;
      try {
        const allTokens = syntaxTokens(tree.rootNode, fragment.source);
        const tokens = allTokens.filter(
          (token) => token.start >= fragment.start && token.end <= fragment.end,
        );
        const valid =
          !tree.rootNode.hasError &&
          tokens.length > 0 &&
          tokens.every((token) => !token.unsafe) &&
          fragmentCovered(fragment, tokens);
        const normalized = valid ? normalizeTokens(tokens, grammar) : [];
        if (normalized.length > 0) return normalized;
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }
  return null;
}

function tokenSignatureMatches(
  actual: readonly SyntaxToken[],
  expected: readonly SyntaxToken[],
): boolean {
  return expected.every(
    (token, index) =>
      actual[index]?.type === token.type &&
      actual[index]?.text === token.text &&
      !actual[index]?.unsafe,
  );
}

function relativeShape(tokens: readonly SyntaxToken[]): string {
  if (tokens.length === 0) return "";
  let common = tokens[0]!.path.length;
  for (const token of tokens.slice(1)) {
    let index = 0;
    while (
      index < common &&
      index < token.path.length &&
      tokens[0]!.path[index]!.id === token.path[index]!.id
    ) {
      index += 1;
    }
    common = index;
  }
  const shapeStart = Math.max(0, common - 1);
  return tokens
    .map((token) =>
      token.path
        .slice(shapeStart)
        .map((entry) => entry.type)
        .join(">"),
    )
    .join("\u0000");
}

function lineBounds(
  source: Buffer,
  start: number,
  end: number,
): {
  lineStart: number;
  lineEnd: number;
  afterLine: number;
  indent: string;
  fullLines: boolean;
} {
  const previousNewline = source.lastIndexOf(0x0a, Math.max(0, start - 1));
  const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
  const nextNewline = source.indexOf(0x0a, end);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  const afterLine = nextNewline < 0 ? source.length : nextNewline + 1;
  const prefix = source.subarray(lineStart, start).toString("utf8");
  const suffix = source.subarray(end, lineEnd).toString("utf8");
  return {
    lineStart,
    lineEnd,
    afterLine,
    indent: /^[\t ]*$/u.test(prefix) ? prefix : "",
    fullLines: /^[\t ]*$/u.test(prefix) && /^[\t ]*$/u.test(suffix),
  };
}

function formattedReplacement(value: string, indent: string, trailingNewline: boolean): Buffer {
  if (!value) return Buffer.alloc(0);
  const normalized = dedent(value)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  return Buffer.from(`${normalized}${trailingNewline ? "\n" : ""}`, "utf8");
}

async function tokenCandidates(
  group: EditGroup,
  document: StructuralDocument,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  path: string,
): Promise<EditCandidate[]> {
  const oldTokens = await parseFragment(document.grammar, group.oldLines.join("\n"));
  if (!oldTokens || oldTokens.length === 0 || oldTokens.length > document.tokens.length) return [];
  const expectedShape = relativeShape(oldTokens);
  const sourceBytes = Buffer.from(source, "utf8");
  const newTokens =
    group.newLines.length === 0
      ? []
      : await parseFragment(document.grammar, group.newLines.join("\n"));
  if (!newTokens) return [];
  const candidates: EditCandidate[] = [];

  for (let index = 0; index <= document.tokens.length - oldTokens.length; index++) {
    const window = document.tokens.slice(index, index + oldTokens.length);
    if (!tokenSignatureMatches(window, oldTokens) || relativeShape(window) !== expectedShape) {
      continue;
    }
    const first = window[0]!;
    const last = window.at(-1)!;
    const bounds = lineBounds(sourceBytes, first.start, last.end);
    let start = first.start;
    let end = last.end;
    let edits: ByteEdit[];
    if (
      newTokens &&
      newTokens.length === oldTokens.length &&
      newTokens.every((token, tokenIndex) => token.type === oldTokens[tokenIndex]!.type)
    ) {
      edits = window.flatMap((token, tokenIndex) => {
        const replacement = newTokens[tokenIndex]!.text;
        return replacement === token.text
          ? []
          : [
              {
                start: token.start,
                end: token.end,
                replacement: Buffer.from(replacement, "utf8"),
              },
            ];
      });
    } else if (bounds.fullLines) {
      start = bounds.lineStart;
      end = bounds.afterLine;
      edits = [
        {
          start,
          end,
          replacement: formattedReplacement(
            group.newLines.join("\n"),
            bounds.indent,
            end > bounds.lineEnd,
          ),
        },
      ];
    } else {
      edits = [
        {
          start,
          end,
          replacement: formattedReplacement(group.newLines.join("\n"), bounds.indent, false),
        },
      ];
    }
    const startLine = lineForByte(lineStarts, first.start);
    const endLine = Math.min(sourceLines.length, lineForByte(lineStarts, last.end - 1) + 1);
    candidates.push({
      start,
      end,
      startLine,
      endLine,
      score: candidateScore(group, sourceLines, startLine, endLine, path),
      edits,
    });
  }
  return candidates;
}

function applyEdits(source: Buffer, edits: readonly ByteEdit[]): Buffer {
  const ordered = edits
    .map((edit, index) => ({ ...edit, index }))
    .sort((left, right) => left.start - right.start || left.index - right.index);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new FormatterMatchAmbiguityError("formatter-tolerant edits overlap");
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

function distinctMappedOutputs(
  source: string,
  candidateSets: readonly EditCandidate[][],
): { outputs: Map<string, Buffer>; exhaustive: boolean } {
  const outputs = new Map<string, Buffer>();
  const sourceBytes = Buffer.from(source, "utf8");
  let mappings = 0;
  let exhaustive = true;

  const visit = (groupIndex: number, previousEnd: number, edits: ByteEdit[]): void => {
    if (outputs.size > 1) return;
    if (groupIndex === candidateSets.length) {
      if (mappings >= MAX_COMPLETE_MAPPINGS) {
        exhaustive = false;
        return;
      }
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

async function deriveFormatterTolerantContent(
  content: string,
  chunks: readonly UpdateChunk[],
  path: string,
): Promise<string | undefined> {
  const groups = editGroups(chunks);
  if (groups.length === 0) return undefined;
  const normalized = normalizedSource(content);
  const documentCache = new Map<string, Promise<StructuralDocument[]>>();
  const candidates: EditCandidate[][] = [];

  for (const group of groups) {
    let groupCandidates =
      group.oldLines.length === 0
        ? insertionCandidates(group, normalized.lines, normalized.lineStarts, path)
        : lineCandidates(group, normalized.lines, normalized.lineStarts, path);
    if (groupCandidates.length === 0 && group.oldLines.length > 0) {
      const grammar =
        grammarForPath(path) ?? (isMarkdownPath(path) ? fenceGrammar(group) : undefined);
      if (grammar) {
        const cacheKey = `${isMarkdownPath(path) ? "embedded:" : "file:"}${grammar}`;
        let documentsPromise = documentCache.get(cacheKey);
        if (!documentsPromise) {
          documentsPromise = structuralDocuments(
            path,
            group,
            normalized.source,
            normalized.lines,
            normalized.lineStarts,
          );
          documentCache.set(cacheKey, documentsPromise);
        }
        const documents = await documentsPromise;
        groupCandidates = (
          await Promise.all(
            documents.map((document) =>
              tokenCandidates(
                group,
                document,
                normalized.source,
                normalized.lines,
                normalized.lineStarts,
                path,
              ),
            ),
          )
        ).flat();
      }
    }
    const best = keepBestCandidates(groupCandidates, path);
    if (best.length === 0) return undefined;
    candidates.push(best);
  }

  const { outputs, exhaustive } = distinctMappedOutputs(normalized.source, candidates);
  if (outputs.size === 0) return undefined;
  if (outputs.size > 1) {
    throw new FormatterMatchAmbiguityError(
      `Formatter-tolerant match is ambiguous in ${path}: candidate mappings produce different files`,
    );
  }
  if (!exhaustive) {
    throw new FormatterMatchAmbiguityError(
      `Formatter-tolerant match is ambiguous in ${path}: more than ${MAX_COMPLETE_MAPPINGS} candidate mappings require evaluation`,
    );
  }
  return outputs.values().next().value!.toString("utf8");
}

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
): Promise<string> {
  try {
    return deriveStrictContent(content, chunks, path);
  } catch (error) {
    if (!isContextMismatch(error)) throw error;
    const tolerant = await deriveFormatterTolerantContent(content, chunks, path);
    if (tolerant !== undefined) return tolerant;
    throw error;
  }
}
