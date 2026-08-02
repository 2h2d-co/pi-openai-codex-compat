import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";
const ENVIRONMENT_ID = "*** Environment ID:";

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

type ParserMode =
  | { kind: "not-started" }
  | { kind: "started" }
  | { kind: "add" }
  | { kind: "delete" }
  | { kind: "update"; hunkLineNumber: number }
  | { kind: "ended" };

export type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
};

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export type ParsedPatch = {
  patch: string;
  operations: PatchOperation[];
  environmentId?: string;
};

export type AppliedPatchChange =
  | {
      kind: "add";
      path: string;
      content: string;
      overwrittenContent?: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: "delete";
      path: string;
      content: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      oldContent: string;
      newContent: string;
      overwrittenMoveContent?: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    };

export type ApplyPatchDetails = {
  status: "completed" | "failed";
  exact: boolean;
  changes: AppliedPatchChange[];
  added: string[];
  modified: string[];
  deleted: string[];
  error?: string;
};

type ResolvedOperation =
  | { kind: "add"; path: string; absolutePath: string; content: string }
  | { kind: "delete"; path: string; absolutePath: string }
  | {
      kind: "update";
      path: string;
      absolutePath: string;
      moveTo?: string;
      moveAbsolutePath?: string;
      chunks: UpdateChunk[];
    };

export class ApplyPatchParseError extends Error {
  readonly kind: "patch" | "hunk";
  readonly lineNumber: number | undefined;

  constructor(kind: "patch" | "hunk", message: string, lineNumber?: number) {
    super(
      kind === "patch"
        ? `invalid patch: ${message}`
        : `invalid hunk at line ${lineNumber}, ${message}`,
    );
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

export class ApplyPatchInputError extends Error {}

export class ApplyPatchVerificationError extends Error {}

export class ApplyPatchExecutionError extends Error {
  readonly details: ApplyPatchDetails;

  constructor(message: string, details: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

class PatchParser {
  private mode: ParserMode = { kind: "not-started" };
  private readonly operations: PatchOperation[] = [];
  private environmentId?: string;
  private lineNumber = 0;

  parse(lines: readonly string[], patch: string): ParsedPatch {
    for (const [index, line] of lines.entries()) {
      this.lineNumber += 1;
      if (index === lines.length - 1 && rustTrim(line) === END_PATCH) {
        this.ensureUpdateHunkIsNotEmpty(rustTrim(line));
        this.mode = { kind: "ended" };
      } else {
        this.processLine(line);
      }
    }
    if (this.mode.kind !== "ended") {
      throw new ApplyPatchParseError("patch", `The last line of the patch must be '${END_PATCH}'`);
    }
    return {
      patch,
      operations: this.operations,
      ...(this.environmentId ? { environmentId: this.environmentId } : {}),
    };
  }

  private lastUpdate(): Extract<PatchOperation, { kind: "update" }> | undefined {
    const operation = this.operations.at(-1);
    return operation?.kind === "update" ? operation : undefined;
  }

  private ensureUpdateHunkIsNotEmpty(line: string): void {
    const operation = this.lastUpdate();
    if (!operation || this.mode.kind !== "update") return;
    if (operation.chunks.length === 0) {
      throw new ApplyPatchParseError(
        "hunk",
        `Update file hunk for path '${operation.path}' is empty`,
        this.mode.hunkLineNumber,
      );
    }
    const chunk = operation.chunks.at(-1);
    if (!chunk || chunk.oldLines.length !== 0 || chunk.newLines.length !== 0) return;
    if (line === END_PATCH) {
      throw new ApplyPatchParseError(
        "hunk",
        "Update hunk does not contain any lines",
        this.lineNumber,
      );
    }
    throw this.unexpectedUpdateLine(line);
  }

  private invalidHunkHeader(line: string): ApplyPatchParseError {
    return new ApplyPatchParseError(
      "hunk",
      `'${line}' is not a valid hunk header. Valid hunk headers: '${ADD_FILE}{path}', '${DELETE_FILE}{path}', '${UPDATE_FILE}{path}'`,
      this.lineNumber,
    );
  }

  private unexpectedUpdateLine(line: string): ApplyPatchParseError {
    return new ApplyPatchParseError(
      "hunk",
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      this.lineNumber,
    );
  }

  private handleHeadersAndEnd(line: string): boolean {
    if (this.mode.kind === "started" && line.startsWith(ENVIRONMENT_ID)) {
      if (this.environmentId) {
        throw new ApplyPatchParseError(
          "patch",
          "apply_patch environment_id cannot be specified more than once",
        );
      }
      const environmentId = rustTrim(line.slice(ENVIRONMENT_ID.length));
      if (!environmentId) {
        throw new ApplyPatchParseError("patch", "apply_patch environment_id cannot be empty");
      }
      this.environmentId = environmentId;
      return true;
    }
    if (line === END_PATCH) {
      this.ensureUpdateHunkIsNotEmpty(line);
      this.mode = { kind: "ended" };
      return true;
    }
    if (line.startsWith(ADD_FILE)) {
      this.ensureUpdateHunkIsNotEmpty(line);
      this.operations.push({ kind: "add", path: line.slice(ADD_FILE.length), content: "" });
      this.mode = { kind: "add" };
      return true;
    }
    if (line.startsWith(DELETE_FILE)) {
      this.ensureUpdateHunkIsNotEmpty(line);
      this.operations.push({ kind: "delete", path: line.slice(DELETE_FILE.length) });
      this.mode = { kind: "delete" };
      return true;
    }
    if (line.startsWith(UPDATE_FILE)) {
      this.ensureUpdateHunkIsNotEmpty(line);
      this.operations.push({
        kind: "update",
        path: line.slice(UPDATE_FILE.length),
        chunks: [],
      });
      this.mode = { kind: "update", hunkLineNumber: this.lineNumber };
      return true;
    }
    return false;
  }

  private ensureUpdateChunk(operation: Extract<PatchOperation, { kind: "update" }>): UpdateChunk {
    let chunk = operation.chunks.at(-1);
    if (!chunk) {
      chunk = { oldLines: [], newLines: [], endOfFile: false };
      operation.chunks.push(chunk);
    }
    return chunk;
  }

  private processLine(line: string): void {
    const trimmed = rustTrim(line);
    switch (this.mode.kind) {
      case "not-started":
        if (trimmed === BEGIN_PATCH) {
          this.mode = { kind: "started" };
          return;
        }
        throw new ApplyPatchParseError(
          "patch",
          `The first line of the patch must be '${BEGIN_PATCH}'`,
        );

      case "started":
        if (this.handleHeadersAndEnd(trimmed)) return;
        throw this.invalidHunkHeader(trimmed);

      case "add": {
        if (this.handleHeadersAndEnd(trimmed)) return;
        const operation = this.operations.at(-1);
        if (operation?.kind === "add" && line.startsWith("+")) {
          operation.content += `${line.slice(1)}\n`;
          return;
        }
        throw this.invalidHunkHeader(trimmed);
      }

      case "delete":
        if (this.handleHeadersAndEnd(trimmed)) return;
        throw this.invalidHunkHeader(trimmed);

      case "update": {
        const updateLine = rustTrimEnd(line);
        if (this.handleHeadersAndEnd(updateLine)) return;
        const operation = this.lastUpdate();
        if (!operation) throw this.unexpectedUpdateLine(line);

        const lastChunk = operation.chunks.at(-1);
        if (lastChunk?.endOfFile) {
          if (!updateLine) return;
          if (updateLine !== EMPTY_CHANGE_CONTEXT && !updateLine.startsWith(CHANGE_CONTEXT)) {
            throw new ApplyPatchParseError(
              "hunk",
              `Expected update hunk to start with a @@ context marker, got: '${line}'`,
              this.lineNumber,
            );
          }
        }

        if (operation.chunks.length === 0 && !operation.moveTo && updateLine.startsWith(MOVE_TO)) {
          operation.moveTo = updateLine.slice(MOVE_TO.length);
          return;
        }

        if (
          (updateLine === EMPTY_CHANGE_CONTEXT || updateLine.startsWith(CHANGE_CONTEXT)) &&
          lastChunk &&
          lastChunk.oldLines.length === 0 &&
          lastChunk.newLines.length === 0
        ) {
          throw this.unexpectedUpdateLine(line);
        }

        if (updateLine === EMPTY_CHANGE_CONTEXT) {
          operation.chunks.push({ oldLines: [], newLines: [], endOfFile: false });
          return;
        }
        if (updateLine.startsWith(CHANGE_CONTEXT)) {
          operation.chunks.push({
            context: updateLine.slice(CHANGE_CONTEXT.length),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          });
          return;
        }
        if (updateLine === END_OF_FILE) {
          const chunk = operation.chunks.at(-1);
          if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
            throw new ApplyPatchParseError(
              "hunk",
              "Update hunk does not contain any lines",
              this.lineNumber,
            );
          }
          if (chunk) chunk.endOfFile = true;
          return;
        }

        if (line === "") {
          const chunk = this.ensureUpdateChunk(operation);
          chunk.oldLines.push("");
          chunk.newLines.push("");
          return;
        }
        if (line.startsWith(" ")) {
          const chunk = this.ensureUpdateChunk(operation);
          chunk.oldLines.push(line.slice(1));
          chunk.newLines.push(line.slice(1));
          return;
        }
        if (line.startsWith("+")) {
          this.ensureUpdateChunk(operation).newLines.push(line.slice(1));
          return;
        }
        if (line.startsWith("-")) {
          this.ensureUpdateChunk(operation).oldLines.push(line.slice(1));
          return;
        }

        const currentChunk = operation.chunks.at(-1);
        if (
          currentChunk &&
          (currentChunk.oldLines.length > 0 || currentChunk.newLines.length > 0)
        ) {
          throw new ApplyPatchParseError(
            "hunk",
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
            this.lineNumber,
          );
        }
        throw this.unexpectedUpdateLine(line);
      }

      case "ended":
        if (!trimmed) return;
        throw new ApplyPatchParseError(
          "patch",
          `The last line of the patch must be '${END_PATCH}'`,
        );
    }
  }
}

function normalizedLines(patch: string): string[] {
  const normalized = rustTrim(patch);
  if (!normalized) return [];
  return normalized.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function checkBoundaries(lines: readonly string[]): void {
  const first = lines[0] === undefined ? undefined : rustTrim(lines[0]);
  const lastLine = lines.at(-1);
  const last = lastLine === undefined ? undefined : rustTrim(lastLine);
  if (first !== undefined && first !== BEGIN_PATCH) {
    throw new ApplyPatchParseError("patch", `The first line of the patch must be '${BEGIN_PATCH}'`);
  }
  if (last !== END_PATCH) {
    throw new ApplyPatchParseError("patch", `The last line of the patch must be '${END_PATCH}'`);
  }
}

export function parsePatchDocument(patch: string): ParsedPatch {
  const originalLines = normalizedLines(patch);
  let lines = originalLines;
  try {
    checkBoundaries(lines);
  } catch (originalError) {
    const first = originalLines[0];
    const last = originalLines.at(-1);
    const heredocStart = first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
    if (!heredocStart || !last?.endsWith("EOF") || originalLines.length < 4) {
      throw originalError;
    }
    lines = originalLines.slice(1, -1);
    checkBoundaries(lines);
  }

  const normalizedPatch = lines.join("\n");
  return new PatchParser().parse(lines, normalizedPatch);
}

export function parsePatch(patch: string): PatchOperation[] {
  return parsePatchDocument(patch).operations;
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

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
  mode: "exact" | "trim-end" | "trim" | "unicode",
): boolean {
  const candidate = lines.slice(index, index + pattern.length);
  if (candidate.length !== pattern.length) return false;
  return candidate.every((line, offset) => {
    const expected = pattern[offset]!;
    switch (mode) {
      case "exact":
        return line === expected;
      case "trim-end":
        return rustTrimEnd(line) === rustTrimEnd(expected);
      case "trim":
        return rustTrim(line) === rustTrim(expected);
      case "unicode":
        return normalizeFuzzyText(line) === normalizeFuzzyText(expected);
    }
  });
}

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const last = lines.length - pattern.length;
  const searchStart = endOfFile ? last : start;
  for (const mode of ["exact", "trim-end", "trim", "unicode"] as const) {
    for (let index = searchStart; index <= last; index++) {
      if (sequenceMatches(lines, pattern, index, mode)) return index;
    }
  }
  return undefined;
}

function deriveNewContent(content: string, chunks: readonly UpdateChunk[], path: string): string {
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

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function resolvePatchPath(cwd: string, patchPath: string): string {
  return isAbsolute(patchPath) ? resolve(patchPath) : resolve(cwd, patchPath);
}

function resolveOperations(
  cwd: string,
  operations: readonly PatchOperation[],
): ResolvedOperation[] {
  return operations.map((operation) => {
    const absolutePath = resolvePatchPath(cwd, operation.path);
    if (operation.kind !== "update" || !operation.moveTo) {
      return { ...operation, absolutePath };
    }
    return {
      ...operation,
      absolutePath,
      moveAbsolutePath: resolvePatchPath(cwd, operation.moveTo),
    };
  });
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readUtf8(path: string, context: string): Promise<string> {
  try {
    return UTF8_DECODER.decode(await readFile(path));
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

async function supportsExactDelta(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    return isNotFound(error);
  }
}

async function readOptionalUtf8(path: string): Promise<{ content?: string; exact: boolean }> {
  const exact = await supportsExactDelta(path);
  try {
    return { content: UTF8_DECODER.decode(await readFile(path)), exact };
  } catch (error) {
    if (isNotFound(error)) return { exact };
    return { exact: false };
  }
}

async function verifyOperations(operations: readonly ResolvedOperation[]): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "add") continue;
    if (operation.kind === "delete") {
      await readUtf8(operation.absolutePath, `Failed to read ${operation.absolutePath}`);
      continue;
    }
    const current = await readUtf8(
      operation.absolutePath,
      `Failed to read file to update ${operation.absolutePath}`,
    );
    deriveNewContent(current, operation.chunks, operation.absolutePath);
  }
}

function diffDetails(
  oldContent: string,
  newContent: string,
): {
  displayDiff: string;
  additions: number;
  deletions: number;
} {
  const displayDiff = generateDiffString(oldContent, newContent, 1).diff;
  let additions = 0;
  let deletions = 0;
  for (const line of displayDiff.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { displayDiff, additions, deletions };
}

function emptyDetails(): ApplyPatchDetails {
  return {
    status: "completed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
  };
}

export function cloneApplyPatchDetails(details: ApplyPatchDetails): ApplyPatchDetails {
  return {
    ...details,
    changes: details.changes.map((change) => ({ ...change })),
    added: [...details.added],
    modified: [...details.modified],
    deleted: [...details.deleted],
  };
}

export type ApplyPatchExecutionHooks = {
  onExecutionStart?: () => void;
  onProgress?: (details: ApplyPatchDetails) => void;
};

async function writeFileWithParents(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("apply_patch was cancelled.");
}

async function withMutationQueues<T>(
  paths: readonly string[],
  callback: () => Promise<T>,
  index = 0,
): Promise<T> {
  const path = paths[index];
  if (!path) return callback();
  return withFileMutationQueue(path, () => withMutationQueues(paths, callback, index + 1));
}

async function applyOperations(
  operations: readonly ResolvedOperation[],
  signal: AbortSignal | undefined,
  onProgress?: (details: ApplyPatchDetails) => void,
): Promise<ApplyPatchDetails> {
  const details = emptyDetails();
  try {
    for (const operation of operations) {
      throwIfAborted(signal);
      if (operation.kind === "add") {
        const previous = await readOptionalUtf8(operation.absolutePath);
        details.exact &&= previous.exact;
        try {
          await writeFileWithParents(operation.absolutePath, operation.content);
        } catch (error) {
          details.exact = false;
          throw new Error(`Failed to write file ${operation.absolutePath}: ${errorMessage(error)}`);
        }
        const diff = diffDetails("", operation.content);
        details.changes.push({
          kind: "add",
          path: operation.path,
          content: operation.content,
          ...(previous.content !== undefined ? { overwrittenContent: previous.content } : {}),
          ...diff,
        });
        details.added.push(operation.path);
      } else if (operation.kind === "delete") {
        const previous = await readOptionalUtf8(operation.absolutePath);
        details.exact &&= previous.exact;
        try {
          const metadata = await stat(operation.absolutePath);
          if (metadata.isDirectory()) throw new Error("path is a directory");
          await unlink(operation.absolutePath);
        } catch (error) {
          if (previous.content !== undefined) {
            try {
              details.exact &&=
                (await readUtf8(operation.absolutePath, "Failed to inspect delete failure")) ===
                previous.content;
            } catch {
              details.exact = false;
            }
          } else {
            details.exact = false;
          }
          throw new Error(
            `Failed to delete file ${operation.absolutePath}: ${errorMessage(error)}`,
          );
        }
        const content = previous.content ?? "";
        if (previous.content !== undefined) {
          details.changes.push({
            kind: "delete",
            path: operation.path,
            content,
            ...diffDetails(content, ""),
          });
        }
        details.deleted.push(operation.path);
      } else {
        details.exact &&= await supportsExactDelta(operation.absolutePath);
        const oldContent = await readUtf8(
          operation.absolutePath,
          `Failed to read file to update ${operation.absolutePath}`,
        );
        const newContent = deriveNewContent(oldContent, operation.chunks, operation.absolutePath);
        if (operation.moveAbsolutePath && operation.moveTo) {
          const previousDestination = await readOptionalUtf8(operation.moveAbsolutePath);
          details.exact &&= previousDestination.exact;
          try {
            await writeFileWithParents(operation.moveAbsolutePath, newContent);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to write file ${operation.moveAbsolutePath}: ${errorMessage(error)}`,
            );
          }
          const provisionalIndex = details.changes.length;
          details.changes.push({
            kind: "add",
            path: operation.moveTo,
            content: newContent,
            ...(previousDestination.content !== undefined
              ? { overwrittenContent: previousDestination.content }
              : {}),
            ...diffDetails("", newContent),
          });
          try {
            const metadata = await stat(operation.absolutePath);
            if (metadata.isDirectory()) throw new Error("path is a directory");
            await unlink(operation.absolutePath);
          } catch (error) {
            try {
              details.exact &&=
                (await readUtf8(operation.absolutePath, "Failed to inspect move failure")) ===
                oldContent;
            } catch {
              details.exact = false;
            }
            throw new Error(
              `Failed to remove original ${operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          details.changes[provisionalIndex] = {
            kind: "update",
            path: operation.path,
            moveTo: operation.moveTo,
            oldContent,
            newContent,
            ...(previousDestination.content !== undefined
              ? { overwrittenMoveContent: previousDestination.content }
              : {}),
            ...diffDetails(oldContent, newContent),
          };
          details.modified.push(operation.moveTo);
        } else {
          try {
            await writeFile(operation.absolutePath, newContent, "utf8");
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to write file ${operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          details.changes.push({
            kind: "update",
            path: operation.path,
            oldContent,
            newContent,
            ...diffDetails(oldContent, newContent),
          });
          details.modified.push(operation.path);
        }
      }
      throwIfAborted(signal);
      onProgress?.(cloneApplyPatchDetails(details));
    }
    return details;
  } catch (error) {
    details.status = "failed";
    details.error = errorMessage(error);
    throw new ApplyPatchExecutionError(details.error, cloneApplyPatchDetails(details));
  }
}

export async function previewPatch(cwd: string, patch: string): Promise<ApplyPatchDetails> {
  const parsed = parsePatchDocument(patch);
  if (parsed.environmentId) {
    throw new ApplyPatchInputError(
      "apply_patch environment selection is unavailable for this turn",
    );
  }
  if (parsed.operations.length === 0) {
    throw new ApplyPatchInputError("patch rejected: empty patch");
  }
  const operations = resolveOperations(cwd, parsed.operations);
  await verifyOperations(operations);
  const details = emptyDetails();
  const changes = new Map<string, AppliedPatchChange>();
  for (const operation of operations) {
    if (operation.kind === "add") {
      changes.set(operation.absolutePath, {
        kind: "add",
        path: operation.path,
        content: operation.content,
        ...diffDetails("", operation.content),
      });
    } else if (operation.kind === "delete") {
      const content = await readUtf8(
        operation.absolutePath,
        `Failed to read ${operation.absolutePath}`,
      );
      changes.set(operation.absolutePath, {
        kind: "delete",
        path: operation.path,
        content,
        ...diffDetails(content, ""),
      });
    } else {
      const oldContent = await readUtf8(
        operation.absolutePath,
        `Failed to read file to update ${operation.absolutePath}`,
      );
      const newContent = deriveNewContent(oldContent, operation.chunks, operation.absolutePath);
      changes.set(operation.absolutePath, {
        kind: "update",
        path: operation.path,
        ...(operation.moveTo ? { moveTo: operation.moveTo } : {}),
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      });
    }
  }
  details.changes = [...changes.values()];
  for (const change of details.changes) {
    if (change.kind === "add") details.added.push(change.path);
    else if (change.kind === "delete") details.deleted.push(change.path);
    else details.modified.push(change.moveTo ?? change.path);
  }
  return details;
}

export async function applyPatch(
  cwd: string,
  patch: string,
  signal?: AbortSignal,
  hooks: ApplyPatchExecutionHooks = {},
): Promise<ApplyPatchDetails> {
  throwIfAborted(signal);
  let parsed: ParsedPatch;
  let operations: ResolvedOperation[];
  try {
    parsed = parsePatchDocument(patch);
    if (parsed.environmentId) {
      throw new ApplyPatchInputError(
        "apply_patch environment selection is unavailable for this turn",
      );
    }
    if (parsed.operations.length === 0) {
      throw new ApplyPatchInputError("patch rejected: empty patch");
    }
    operations = resolveOperations(cwd, parsed.operations);
  } catch (error) {
    if (error instanceof ApplyPatchInputError) throw error;
    throw new ApplyPatchVerificationError(
      `apply_patch verification failed: ${errorMessage(error)}`,
    );
  }

  const queuePaths = [
    ...new Set(
      operations.flatMap((operation) => [
        operation.absolutePath,
        ...(operation.kind === "update" && operation.moveAbsolutePath
          ? [operation.moveAbsolutePath]
          : []),
      ]),
    ),
  ].sort();

  return withMutationQueues(queuePaths, async () => {
    throwIfAborted(signal);
    try {
      await verifyOperations(operations);
    } catch (error) {
      throw new ApplyPatchVerificationError(
        `apply_patch verification failed: ${errorMessage(error)}`,
      );
    }
    throwIfAborted(signal);
    hooks.onExecutionStart?.();
    return applyOperations(operations, signal, hooks.onProgress);
  });
}

export function formatApplyPatchSummary(details: ApplyPatchDetails): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of details.added) lines.push(`A ${path}`);
  for (const path of details.modified) lines.push(`M ${path}`);
  for (const path of details.deleted) lines.push(`D ${path}`);
  return `${lines.join("\n")}\n`;
}

export function formatApplyPatchModelOutput(
  exitCode: number,
  durationMs: number,
  output: string,
): string {
  const durationSeconds = Math.round(durationMs / 100) / 10;
  return [
    `Exit code: ${exitCode}`,
    `Wall time: ${durationSeconds} seconds`,
    "Output:",
    output,
  ].join("\n");
}
