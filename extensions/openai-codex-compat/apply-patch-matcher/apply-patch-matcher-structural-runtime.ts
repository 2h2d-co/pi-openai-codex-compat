import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { wasmURL, type GrammarName } from "@2h2d/tree-sitter-wasms";
import { Language, type Node as SyntaxNode, Parser } from "web-tree-sitter";
import type {
  EditGroup,
  StructuralDocument,
  SyntaxPathEntry,
  SyntaxToken,
  WrappedFragment,
} from "./apply-patch-matcher-contracts.ts";
import {
  GRAMMAR_BY_FENCE_INFO,
  fenceClosing,
  fenceOpening,
  isMarkdownPath,
  rustTrim,
  throwIfAborted,
} from "./apply-patch-matcher-line-matching.ts";

export const GRAMMAR_BY_EXTENSION = new Map<string, GrammarName>([
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

export const languagePromises = new Map<GrammarName, Promise<Language>>();

export let parserInitialization: Promise<void> | undefined;

export function parserInitializationPromise(): Promise<void> {
  if (!parserInitialization) {
    const promise = structuralRuntime.initializeParser();
    parserInitialization = promise;
    void promise.catch(() => {
      if (parserInitialization === promise) parserInitialization = undefined;
    });
  }
  return parserInitialization;
}

export async function loadLanguage(grammar: GrammarName): Promise<Language> {
  let promise = languagePromises.get(grammar);
  if (!promise) {
    promise = (async () => {
      await parserInitializationPromise();
      return structuralRuntime.loadLanguage(fileURLToPath(wasmURL(grammar)));
    })();
    languagePromises.set(grammar, promise);
    void promise.catch(() => {
      if (languagePromises.get(grammar) === promise) languagePromises.delete(grammar);
    });
  }
  return promise;
}

export type StructuralRuntime = {
  initializeParser: () => Promise<void>;
  loadLanguage: (path: string) => Promise<Language>;
};

export const DEFAULT_STRUCTURAL_RUNTIME: StructuralRuntime = {
  initializeParser: () => Parser.init(),
  loadLanguage: (path) => Language.load(path),
};

export let structuralRuntime = DEFAULT_STRUCTURAL_RUNTIME;

export function setApplyPatchStructuralRuntimeForTesting(
  overrides: Partial<StructuralRuntime>,
): () => void {
  parserInitialization = undefined;
  languagePromises.clear();
  structuralRuntime = { ...DEFAULT_STRUCTURAL_RUNTIME, ...overrides };
  return () => {
    parserInitialization = undefined;
    languagePromises.clear();
    structuralRuntime = DEFAULT_STRUCTURAL_RUNTIME;
  };
}

export function grammarForPath(path: string): GrammarName | undefined {
  return GRAMMAR_BY_EXTENSION.get(extname(path).toLowerCase());
}

export function fenceGrammar(group: EditGroup): GrammarName | undefined {
  const context = [...(group.chunk.context ? [group.chunk.context] : []), ...group.beforeContext];
  for (const line of context.toReversed()) {
    if (/^ {0,3}(?:`{3,}|~{3,})[\t ]*$/u.test(line)) return undefined;
    const match = rustTrim(line).match(/^(?:`{3,}|~{3,})[\t ]*([A-Za-z0-9_+-]+)/u);
    if (match) return GRAMMAR_BY_FENCE_INFO.get(match[1]!.toLowerCase());
  }
  return undefined;
}

export function utf16ByteOffsets(source: string): Uint32Array {
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

export function syntaxTokens(root: SyntaxNode, source: string): SyntaxToken[] {
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

export async function parseStructuralDocument(
  grammar: GrammarName,
  source: string,
  byteOffset = 0,
  signal?: AbortSignal,
): Promise<StructuralDocument | null> {
  try {
    throwIfAborted(signal);
    const language = await loadLanguage(grammar);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source, null, {
        progressCallback: () => signal?.aborted ?? false,
      });
      throwIfAborted(signal);
      if (!tree) return null;
      try {
        if (tree.rootNode.hasError) return null;
        const tokens = syntaxTokens(tree.rootNode, source).map((token) => ({
          ...token,
          start: token.start + byteOffset,
          end: token.end + byteOffset,
        }));
        if (tokens.some((token) => token.unsafe)) return null;
        return { grammar, tokens };
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  } catch {
    if (signal?.aborted) throw new Error("apply_patch was cancelled.");
    return null;
  }
}

export async function embeddedStructuralDocuments(
  grammar: GrammarName,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  signal?: AbortSignal,
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
        signal,
      );
      if (document) documents.push(document);
    }
    index = closing;
  }
  return documents;
}

export async function structuralDocuments(
  path: string,
  group: EditGroup,
  source: string,
  sourceLines: readonly string[],
  lineStarts: readonly number[],
  signal?: AbortSignal,
): Promise<StructuralDocument[]> {
  const grammar = grammarForPath(path);
  if (grammar) {
    const document = await parseStructuralDocument(grammar, source, 0, signal);
    return document ? [document] : [];
  }
  if (!isMarkdownPath(path)) return [];
  const embeddedGrammar = fenceGrammar(group);
  return embeddedGrammar
    ? embeddedStructuralDocuments(embeddedGrammar, source, sourceLines, lineStarts, signal)
    : [];
}

export function commonIndent(lines: readonly string[]): string {
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

export function dedent(value: string): string {
  const lines = value.split("\n");
  const indent = commonIndent(lines);
  return lines.map((line) => (line.trim() ? line.slice(indent.length) : "")).join("\n");
}

export function indented(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function wrapped(prefix: string, fragment: string, suffix: string): WrappedFragment {
  return {
    source: `${prefix}${fragment}${suffix}`,
    start: Buffer.byteLength(prefix, "utf8"),
    end: Buffer.byteLength(`${prefix}${fragment}`, "utf8"),
  };
}

export function fragmentWrappers(grammar: GrammarName, value: string): WrappedFragment[] {
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

export function fragmentCovered(
  fragment: WrappedFragment,
  tokens: readonly SyntaxToken[],
): boolean {
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

export async function parseFragment(
  grammar: GrammarName,
  value: string,
): Promise<SyntaxToken[] | null> {
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
        if (valid) return tokens;
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }
  return null;
}

export function tokenSignatureMatches(
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

export function relativeShape(tokens: readonly SyntaxToken[]): string {
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

export function lineBounds(
  source: Buffer,
  start: number,
  end: number,
): {
  lineStart: number;
  lineEnd: number;
  afterLine: number;
  fullLines: boolean;
} {
  const previousNewline = source.lastIndexOf(0x0a, Math.max(0, start - 1));
  const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
  const nextNewline = source.indexOf(0x0a, end);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  const afterLine = nextNewline < 0 ? source.length : nextNewline + 1;
  const prefix = source.subarray(lineStart, start).toString("utf8");
  const contentLineEnd =
    lineEnd > lineStart && source[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
  const suffix = source.subarray(end, contentLineEnd).toString("utf8");
  return {
    lineStart,
    lineEnd,
    afterLine,
    fullLines: /^[\t ]*$/u.test(prefix) && /^[\t ]*$/u.test(suffix),
  };
}
