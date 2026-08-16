import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  deriveNewContent,
  FormatterMatchError,
  type FormatterMatchFailureDetails,
  type UpdateChunk,
  type UpdateHunkLine,
} from "./apply-patch-matcher.ts";

export type { UpdateChunk, UpdateHunkLine } from "./apply-patch-matcher.ts";

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
      entryType: "regular-file" | "symlink";
      content?: string;
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
    }
  | {
      kind: "move";
      sourcePath: string;
      destinationPath: string;
      replacedDestination: boolean;
      entryType: "regular-file" | "symlink";
      exact: boolean;
      displayDiff: "";
      additions: 0;
      deletions: 0;
    };

export type ApplyPatchInstructionStatus =
  | "applied"
  | "planned"
  | "no-op"
  | "dead"
  | "failed"
  | "not-run";

export type ApplyPatchInstructionReasonCode =
  | "empty-update"
  | "identity-update"
  | "content-already-present"
  | "update-result-unchanged"
  | "path-already-absent"
  | "same-entry-move"
  | "move-already-fulfilled"
  | "dead-dominated";

export type ApplyPatchInstructionReason = {
  code: ApplyPatchInstructionReasonCode;
  message: string;
  dominatingInstructions?: number[];
  relatedInstructions?: number[];
};

export type ApplyPatchInstructionEffect =
  | {
      kind: "created" | "updated" | "deleted" | "directory-created" | "temporary-entry-remains";
      path: string;
    }
  | { kind: "replaced"; path: string; previousEntryType: "regular-file" }
  | {
      kind: "replaced";
      path: string;
      previousEntryType: "symlink";
      originalTarget: string;
    }
  | { kind: "source-remains"; path: string }
  | {
      kind: "symlink-target-not-modified";
      path: string;
      target: string;
      symlinkAction: "removed" | "moved";
    }
  | { kind: "symlink-target-modified"; path: string; target: string };

export type ApplyPatchFinalPathState = {
  path: string;
  state:
    | "absent"
    | "regular-file"
    | "symlink"
    | "directory"
    | "other-entry"
    | "unchanged"
    | "requested-content"
    | "different-from-requested-content"
    | "different-from-requested-and-previous-content"
    | "different-from-previous-content"
    | "different-entry"
    | "different-entry-type"
    | "not-verified";
};

export type ApplyPatchInstructionDetails = {
  index: number;
  kind: "add" | "delete" | "update" | "move";
  path: string;
  moveTo?: string;
  status: ApplyPatchInstructionStatus;
  reason?: ApplyPatchInstructionReason;
  effects?: ApplyPatchInstructionEffect[];
  finalStates?: ApplyPatchFinalPathState[];
  matcher?: FormatterMatchFailureDetails;
  changeIndexes?: number[];
  error?: string;
};

export type ApplyPatchFailureDetails = {
  phase: "input" | "parse" | "preflight" | "execution";
  message: string;
  failedInstruction?: number;
  matcher?: FormatterMatchFailureDetails;
};

export type ApplyPatchDetails = {
  status: "completed" | "failed";
  exact: boolean;
  changes: AppliedPatchChange[];
  added: string[];
  modified: string[];
  deleted: string[];
  instructions?: ApplyPatchInstructionDetails[];
  failure?: ApplyPatchFailureDetails;
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

export class ApplyPatchInputError extends Error {
  readonly details: ApplyPatchDetails | undefined;

  constructor(message: string, details?: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

export class ApplyPatchVerificationError extends Error {
  readonly details: ApplyPatchDetails;

  constructor(message: string, details: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

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
      this.mode = { kind: "ended" };
      return true;
    }
    if (line.startsWith(ADD_FILE)) {
      this.operations.push({ kind: "add", path: line.slice(ADD_FILE.length), content: "" });
      this.mode = { kind: "add" };
      return true;
    }
    if (line.startsWith(DELETE_FILE)) {
      this.operations.push({ kind: "delete", path: line.slice(DELETE_FILE.length) });
      this.mode = { kind: "delete" };
      return true;
    }
    if (line.startsWith(UPDATE_FILE)) {
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
      chunk = { oldLines: [], newLines: [], lines: [], endOfFile: false };
      operation.chunks.push(chunk);
    }
    return chunk;
  }

  private appendUpdateLine(
    operation: Extract<PatchOperation, { kind: "update" }>,
    line: UpdateHunkLine,
  ): void {
    const chunk = this.ensureUpdateChunk(operation);
    chunk.lines.push(line);
    if (line.kind !== "add") chunk.oldLines.push(line.text);
    if (line.kind !== "delete") chunk.newLines.push(line.text);
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

        if (updateLine === EMPTY_CHANGE_CONTEXT) {
          operation.chunks.push({ oldLines: [], newLines: [], lines: [], endOfFile: false });
          return;
        }
        if (updateLine.startsWith(CHANGE_CONTEXT)) {
          operation.chunks.push({
            context: updateLine.slice(CHANGE_CONTEXT.length),
            oldLines: [],
            newLines: [],
            lines: [],
            endOfFile: false,
          });
          return;
        }
        if (updateLine === END_OF_FILE) {
          const chunk = operation.chunks.at(-1);
          if (chunk) chunk.endOfFile = true;
          return;
        }

        if (line === "") {
          this.appendUpdateLine(operation, { kind: "context", text: "" });
          return;
        }
        if (line.startsWith(" ")) {
          this.appendUpdateLine(operation, { kind: "context", text: line.slice(1) });
          return;
        }
        if (line.startsWith("+")) {
          this.appendUpdateLine(operation, { kind: "add", text: line.slice(1) });
          return;
        }
        if (line.startsWith("-")) {
          this.appendUpdateLine(operation, { kind: "delete", text: line.slice(1) });
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

function initialContent(change: AppliedPatchChange): string | undefined {
  if (change.kind === "move") return undefined;
  if (change.kind === "add") return change.overwrittenContent;
  if (change.kind === "delete") return change.content;
  return change.oldContent;
}

function finalContent(change: AppliedPatchChange): string | undefined {
  if (change.kind === "move") return undefined;
  if (change.kind === "delete") return undefined;
  if (change.kind === "add") return change.content;
  return change.newContent;
}

export function coalesceAppliedPatchChangesForRendering(
  changes: readonly AppliedPatchChange[],
  cwd: string,
): AppliedPatchChange[] {
  type TextualChange = Exclude<AppliedPatchChange, { kind: "move" }>;
  const groups = new Map<string, { firstIndex: number; changes: TextualChange[] }>();
  const rendered: Array<{ index: number; change: AppliedPatchChange }> = [];

  for (const [index, change] of changes.entries()) {
    if (change.kind === "move" || (change.kind === "update" && change.moveTo)) {
      // Moves span source and destination identities, so retain their existing operation-level row.
      rendered.push({ index, change });
      continue;
    }
    const textualChange: TextualChange = change;
    const key = resolvePatchPath(cwd, change.path);
    const group = groups.get(key);
    if (group) {
      group.changes.push(textualChange);
    } else {
      groups.set(key, { firstIndex: index, changes: [textualChange] });
    }
  }

  for (const group of groups.values()) {
    const first = group.changes[0]!;
    const last = group.changes.at(-1)!;
    if (group.changes.length === 1) {
      rendered.push({ index: group.firstIndex, change: first });
      continue;
    }
    if (group.changes.some((change) => change.kind === "delete" && change.content === undefined)) {
      for (const [offset, change] of group.changes.entries()) {
        rendered.push({ index: group.firstIndex + offset / group.changes.length, change });
      }
      continue;
    }

    const oldContent = initialContent(first);
    const newContent = finalContent(last);
    if (oldContent === undefined) {
      if (newContent === undefined) continue;
      rendered.push({
        index: group.firstIndex,
        change: {
          kind: "add",
          path: first.path,
          content: newContent,
          ...diffDetails("", newContent),
        },
      });
      continue;
    }
    if (newContent === undefined) {
      rendered.push({
        index: group.firstIndex,
        change: {
          kind: "delete",
          path: first.path,
          entryType: "regular-file",
          content: oldContent,
          ...diffDetails(oldContent, ""),
        },
      });
      continue;
    }
    rendered.push({
      index: group.firstIndex,
      change: {
        kind: "update",
        path: first.path,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      },
    });
  }

  return rendered.toSorted((left, right) => left.index - right.index).map(({ change }) => change);
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
  const cloneMatcher = (matcher: FormatterMatchFailureDetails): FormatterMatchFailureDetails => ({
    ...matcher,
    candidates: matcher.candidates.map((range) => ({ ...range })),
    ...(matcher.previousCandidates
      ? { previousCandidates: matcher.previousCandidates.map((range) => ({ ...range })) }
      : {}),
    ...(matcher.replacementCandidates
      ? { replacementCandidates: matcher.replacementCandidates.map((range) => ({ ...range })) }
      : {}),
  });
  return {
    ...details,
    changes: details.changes.map((change) => ({ ...change })),
    added: [...details.added],
    modified: [...details.modified],
    deleted: [...details.deleted],
    ...(details.instructions
      ? {
          instructions: details.instructions.map((instruction) => ({
            ...instruction,
            ...(instruction.effects
              ? { effects: instruction.effects.map((effect) => ({ ...effect })) }
              : {}),
            ...(instruction.finalStates
              ? { finalStates: instruction.finalStates.map((state) => ({ ...state })) }
              : {}),
            ...(instruction.matcher ? { matcher: cloneMatcher(instruction.matcher) } : {}),
            ...(instruction.changeIndexes ? { changeIndexes: [...instruction.changeIndexes] } : {}),
            ...(instruction.reason
              ? {
                  reason: {
                    ...instruction.reason,
                    ...(instruction.reason.dominatingInstructions
                      ? {
                          dominatingInstructions: [...instruction.reason.dominatingInstructions],
                        }
                      : {}),
                    ...(instruction.reason.relatedInstructions
                      ? {
                          relatedInstructions: [...instruction.reason.relatedInstructions],
                        }
                      : {}),
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(details.failure
      ? {
          failure: {
            ...details.failure,
            ...(details.failure.matcher ? { matcher: cloneMatcher(details.failure.matcher) } : {}),
          },
        }
      : {}),
  };
}

export type ApplyPatchExecutionHooks = {
  onExecutionStart?: () => void | Promise<void>;
  onProgress?: (details: ApplyPatchDetails) => void;
  selectMoveStrategy?: (
    sourcePath: string,
    destinationPath: string,
    detected: "rename" | "copy-unlink",
  ) => "rename" | "copy-unlink" | Promise<"rename" | "copy-unlink">;
  filesystem?: Partial<ApplyPatchExecutionFilesystem>;
};

export type ApplyPatchExecutionFilesystem = {
  chmod: typeof chmod;
  copyFile: typeof copyFile;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readlink: typeof readlink;
  readdir: typeof readdir;
  rename: typeof rename;
  symlink: typeof symlink;
  unlink: typeof unlink;
  utimes: typeof utimes;
  writeFile: typeof writeFile;
};

const DEFAULT_EXECUTION_FILESYSTEM: ApplyPatchExecutionFilesystem = {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
};

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

const logicalMutationQueues = new Map<string, Promise<void>>();
let logicalQueueRegistration = Promise.resolve();

async function withLogicalMutationQueue<T>(key: string, callback: () => Promise<T>): Promise<T> {
  const registration = logicalQueueRegistration.then(() => {
    const currentQueue = logicalMutationQueues.get(key) ?? Promise.resolve();
    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    logicalMutationQueues.set(key, chainedQueue);
    return { currentQueue, chainedQueue, releaseNext };
  });
  logicalQueueRegistration = registration.then(
    () => undefined,
    () => undefined,
  );
  const { currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await callback();
  } finally {
    releaseNext();
    if (logicalMutationQueues.get(key) === chainedQueue) logicalMutationQueues.delete(key);
  }
}

async function withLogicalMutationQueues<T>(
  keys: readonly string[],
  callback: () => Promise<T>,
  index = 0,
): Promise<T> {
  const key = keys[index];
  if (!key) return callback();
  return withLogicalMutationQueue(key, () => withLogicalMutationQueues(keys, callback, index + 1));
}

function normalizedAliasName(name: string): string {
  return process.platform === "darwin" ? name.normalize("NFD") : name;
}

async function directoryIsCaseInsensitive(
  directory: string,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  let cached = cache.get(directory);
  if (!cached) {
    cached = (async () => {
      if (process.platform === "win32") return true;
      let candidate = directory;
      while (candidate !== parse(candidate).root) {
        const name = basename(candidate);
        const toggled = Array.from(name)
          .map((character) =>
            character.toLowerCase() === character
              ? character.toUpperCase()
              : character.toLowerCase(),
          )
          .join("");
        if (toggled !== name) {
          try {
            const [original, alias] = await Promise.all([
              lstat(candidate),
              lstat(join(dirname(candidate), toggled)),
            ]);
            return original.dev === alias.dev && original.ino === alias.ino;
          } catch {
            candidate = dirname(candidate);
            continue;
          }
        }
        candidate = dirname(candidate);
      }
      return false;
    })();
    cache.set(directory, cached);
  }
  return cached;
}

async function namesAlias(
  directory: string,
  left: string,
  right: string,
  caseInsensitiveDirectories: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const normalizedLeft = normalizedAliasName(left);
  const normalizedRight = normalizedAliasName(right);
  if (normalizedLeft === normalizedRight) return true;
  return (
    (await directoryIsCaseInsensitive(directory, caseInsensitiveDirectories)) &&
    normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  );
}

async function logicalEntryQueueKey(
  path: string,
  caseInsensitiveDirectories: Map<string, Promise<boolean>>,
): Promise<string> {
  const parent = await realpathWithMissingTail(dirname(path));
  const requestedName = basename(path);
  let entryName = requestedName;
  try {
    const requestedMetadata = await lstat(path);
    for (const name of await readdir(parent)) {
      if (!(await namesAlias(parent, name, requestedName, caseInsensitiveDirectories))) {
        continue;
      }
      const metadata = await lstat(join(parent, name));
      if (metadata.dev === requestedMetadata.dev && metadata.ino === requestedMetadata.ino) {
        entryName = name;
        break;
      }
    }
  } catch (error) {
    if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
  }
  entryName = normalizedAliasName(entryName);
  if (await directoryIsCaseInsensitive(parent, caseInsensitiveDirectories)) {
    entryName = entryName.toLowerCase();
  }
  return `entry:${join(parent, entryName)}`;
}

type MutationQueueTarget = {
  path: string;
  followSymlink: boolean;
};

function mutationQueueTargets(operations: readonly ResolvedOperation[]): MutationQueueTarget[] {
  return operations.flatMap((operation) => {
    if (operation.kind !== "update") {
      return [{ path: operation.absolutePath, followSymlink: false }];
    }
    const targets: MutationQueueTarget[] = [
      {
        path: operation.absolutePath,
        followSymlink: !chunksAreIdentity(operation.chunks),
      },
    ];
    if (operation.moveAbsolutePath) {
      targets.push({ path: operation.moveAbsolutePath, followSymlink: false });
    }
    return targets;
  });
}

async function logicalMutationQueueKeys(
  targets: readonly MutationQueueTarget[],
): Promise<string[]> {
  const caseInsensitiveDirectories = new Map<string, Promise<boolean>>();
  const keys = new Set<string>();
  for (const { path, followSymlink } of targets) {
    keys.add(await logicalEntryQueueKey(path, caseInsensitiveDirectories));
    try {
      const entryMetadata = await lstat(path);
      if (entryMetadata.isFile()) {
        keys.add(`physical:${entryMetadata.dev}:${entryMetadata.ino}`);
      } else if (entryMetadata.isSymbolicLink() && followSymlink) {
        try {
          const targetMetadata = await stat(path);
          if (targetMetadata.isFile()) {
            keys.add(`physical:${targetMetadata.dev}:${targetMetadata.ino}`);
          }
        } catch {
          // The semantic planner reports inaccessible, dangling, or cyclic targets.
        }
      }
    } catch (error) {
      if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
  }
  return [...keys].sort();
}

async function symlinkEntryQueuePath(path: string): Promise<string> {
  const parent = await realpathWithMissingTail(dirname(path));
  return join(parent, ".apply-patch-entry-locks", normalizedAliasName(basename(path)));
}

async function canonicalMutationQueuePaths(
  targets: readonly MutationQueueTarget[],
): Promise<string[]> {
  const canonicalPaths = await Promise.all(
    targets.map(async ({ path, followSymlink }) => {
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() && !followSymlink) {
          return symlinkEntryQueuePath(path);
        }
      } catch (error) {
        if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
      }
      try {
        return await realpath(path);
      } catch (error) {
        if (isNotFound(error) || hasErrorCode(error, "ENOTDIR")) {
          return realpathWithMissingTail(path);
        }
        try {
          if ((await lstat(path)).isSymbolicLink()) {
            return symlinkEntryQueuePath(path);
          }
        } catch {}
        throw error;
      }
    }),
  );
  return [...new Set(canonicalPaths)].sort();
}

async function realpathWithMissingTail(path: string): Promise<string> {
  const missingNames: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return join(await realpath(candidate), ...missingNames.toReversed());
    } catch (error) {
      if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(path);
    missingNames.push(basename(candidate));
    candidate = parent;
  }
}

type EntryFingerprint = {
  device: number;
  inode: number;
  mode: number;
  linkCount: number;
  size: number;
  modifiedMs: number;
};

type KnownContent = {
  bytes: Buffer;
  text?: string;
};

type PlannedEntryMutation = {
  path: string;
  key: string;
  kind: "absent" | "regular" | "symlink";
  releasedFingerprint?: EntryFingerprint;
};

type CommittedEntryMutation = Omit<PlannedEntryMutation, "kind"> & {
  expected: VirtualEntry;
};

type ContentCell = {
  value?: KnownContent;
  planned: boolean;
};

type PhysicalFileState = {
  id: string;
  linkCount: number;
};

type VirtualEntry =
  | { kind: "absent" }
  | { kind: "directory"; fingerprint?: EntryFingerprint }
  | { kind: "unsupported"; entryType: string; fingerprint: EntryFingerprint }
  | {
      kind: "regular";
      id: string;
      entryPath: string;
      sourcePath?: string;
      fingerprint?: EntryFingerprint;
      content: ContentCell;
      physical?: PhysicalFileState;
    }
  | {
      kind: "symlink";
      id: string;
      entryPath: string;
      sourcePath?: string;
      fingerprint?: EntryFingerprint;
      target: string;
      targetPath: string;
      content: ContentCell;
    };

type ExistingFileEntry = Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
type ReplaceableFileEntry = Extract<VirtualEntry, { kind: "absent" | "regular" | "symlink" }>;

type ParentPlan = {
  createdPaths: string[];
  expectations: Array<{ path: string; kind: "absent" | "directory" | "directory-symlink" }>;
};

type PlannedMutation = (
  | {
      kind: "add";
      operation: Extract<ResolvedOperation, { kind: "add" }>;
      expectedTarget: ReplaceableFileEntry;
      parents: ParentPlan;
      content: Buffer;
      replacementMode?: number;
      targetKey: string;
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "add" }>;
    }
  | {
      kind: "delete";
      operation: Extract<ResolvedOperation, { kind: "delete" }>;
      expectedTarget: ExistingFileEntry;
      targetKey: string;
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "delete" }>;
    }
  | {
      kind: "text-update";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedSource: ExistingFileEntry;
      expectedDestination?: ReplaceableFileEntry;
      parents: ParentPlan;
      content: Buffer;
      replacementMode?: number;
      sourceKey: string;
      destinationKey?: string;
      sameEntryMove?: "rename" | "satisfied";
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "update" }>;
      provisionalChange?: Extract<AppliedPatchChange, { kind: "add" | "update" }>;
    }
  | {
      kind: "move";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedSource: ExistingFileEntry;
      expectedDestination: ReplaceableFileEntry;
      parents: ParentPlan;
      sourceKey: string;
      destinationKey: string;
      moveStrategy: "rename" | "copy-unlink";
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "move" }>;
    }
) & { instructionIndex: number };

type SemanticPlan = {
  mutations: PlannedMutation[];
  exact: boolean;
  instructions: ApplyPatchInstructionDetails[];
};

class SemanticPlanningError extends Error {
  readonly instructions: ApplyPatchInstructionDetails[];
  readonly failedInstruction: number;
  readonly matcher: FormatterMatchFailureDetails | undefined;

  constructor(
    message: string,
    instructions: ApplyPatchInstructionDetails[],
    failedInstruction: number,
    matcher?: FormatterMatchFailureDetails,
  ) {
    super(message);
    this.instructions = instructions;
    this.failedInstruction = failedInstruction;
    this.matcher = matcher;
  }
}

const ABSENT_ENTRY: VirtualEntry = { kind: "absent" };

function fingerprint(metadata: Stats): EntryFingerprint {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
  };
}

function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

function sameFingerprintExceptLinkCount(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

function samePhysicalEntry(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function entryType(metadata: Stats): string {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isSocket()) return "socket";
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isCharacterDevice()) return "character device";
  if (metadata.isBlockDevice()) return "block device";
  return "special file";
}

function chunksAreIdentity(chunks: readonly UpdateChunk[]): boolean {
  return chunks.every(
    (chunk) =>
      chunk.oldLines.length === chunk.newLines.length &&
      chunk.oldLines.every((line, index) => line === chunk.newLines[index]),
  );
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function pathIsRelated(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isWithin = (value: string): boolean =>
    value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  return leftToRight === "" || isWithin(leftToRight) || isWithin(rightToLeft);
}

function updateHasSemanticMove(operation: Extract<ResolvedOperation, { kind: "update" }>): boolean {
  return (
    operation.moveAbsolutePath !== undefined &&
    operation.moveAbsolutePath !== operation.absolutePath
  );
}

type DeadOperationProof = {
  dominatingInstructions: number[];
};

function instructionReason(
  code: Exclude<ApplyPatchInstructionReasonCode, "move-already-fulfilled">,
  relatedInstructions: readonly number[] = [],
): ApplyPatchInstructionReason {
  switch (code) {
    case "empty-update":
      return { code, message: "The instruction contains no changes." };
    case "identity-update":
      return { code, message: "Old and replacement content are identical." };
    case "content-already-present":
      return { code, message: "The file already contains the requested content byte-for-byte." };
    case "update-result-unchanged":
      return { code, message: "Applying the update would not change the file." };
    case "path-already-absent":
      return { code, message: "Path already absent." };
    case "same-entry-move":
      return { code, message: "Source and destination identify the same entry." };
    case "dead-dominated": {
      const instructions = [...new Set(relatedInstructions)].toSorted(
        (left, right) => left - right,
      );
      const noun = instructions.length === 1 ? "instruction" : "instructions";
      return {
        code,
        message: `${noun[0]!.toUpperCase()}${noun.slice(1)} ${instructions.join(", ")} ${instructions.length === 1 ? "determines" : "determine"} the final filesystem state before another instruction reads it.`,
        dominatingInstructions: instructions,
        relatedInstructions: instructions,
      };
    }
  }
}

function moveAlreadyFulfilledReason(instruction: number): ApplyPatchInstructionReason {
  return {
    code: "move-already-fulfilled",
    message: `Instruction ${instruction} already moved this entry.`,
    relatedInstructions: [instruction],
  };
}

function instructionForOperation(
  operation: ResolvedOperation,
  index: number,
): ApplyPatchInstructionDetails {
  if (operation.kind === "update") {
    return {
      index: index + 1,
      kind: operation.moveTo && chunksAreIdentity(operation.chunks) ? "move" : "update",
      path: operation.path,
      ...(operation.moveTo ? { moveTo: operation.moveTo } : {}),
      status: "not-run",
    };
  }
  return {
    index: index + 1,
    kind: operation.kind,
    path: operation.path,
    status: "not-run",
  };
}

class SemanticPlanner {
  private readonly states = new Map<string, VirtualEntry>();
  private readonly physicalFiles = new Map<
    string,
    { content: ContentCell; physical: PhysicalFileState }
  >();
  private readonly mutations: PlannedMutation[] = [];
  private readonly fulfilledMoves = new Map<
    string,
    { destinationKey: string; destinationEntryId: string; instruction: number }
  >();
  private nextEntryId = 0;
  private nextPhysicalId = 0;
  private exact = true;
  private readonly operations: readonly ResolvedOperation[];
  private readonly instructions: ApplyPatchInstructionDetails[];
  private readonly signal: AbortSignal | undefined;
  private readonly selectMoveStrategy: ApplyPatchExecutionHooks["selectMoveStrategy"] | undefined;
  private readonly pathKeys = new Map<string, string>();
  private readonly caseInsensitiveDirectories = new Map<string, Promise<boolean>>();

  constructor(
    operations: readonly ResolvedOperation[],
    signal?: AbortSignal,
    selectMoveStrategy?: ApplyPatchExecutionHooks["selectMoveStrategy"],
  ) {
    this.operations = operations;
    this.instructions = operations.map(instructionForOperation);
    this.signal = signal;
    this.selectMoveStrategy = selectMoveStrategy;
  }

  async plan(): Promise<SemanticPlan> {
    for (const [index, operation] of this.operations.entries()) {
      const instruction = this.instructions[index]!;
      const mutationCount = this.mutations.length;
      try {
        throwIfAborted(this.signal);
        if (operation.kind === "add") {
          await this.planAdd(operation, index);
        } else if (operation.kind === "delete") {
          await this.planDelete(operation, index);
        } else {
          await this.planUpdate(operation, index);
        }
        if (this.mutations.length > mutationCount) {
          instruction.status = "planned";
        } else {
          if (!instruction.reason) {
            throw new Error(`Instruction ${instruction.index} has no recorded no-op reason`);
          }
          instruction.status = "no-op";
        }
      } catch (error) {
        if (operation.kind === "update") {
          const deadProof = !updateHasSemanticMove(operation)
            ? await this.deadUpdateProof(index, operation.absolutePath)
            : await this.deadMoveProof(index, operation.absolutePath, operation.moveAbsolutePath!);
          if (deadProof) {
            instruction.status = "dead";
            instruction.reason = instructionReason(
              "dead-dominated",
              deadProof.dominatingInstructions,
            );
            continue;
          }
        }
        for (const planned of this.instructions) {
          if (planned.status === "planned") planned.status = "not-run";
        }
        instruction.status = "failed";
        instruction.error = errorMessage(error);
        if (error instanceof FormatterMatchError) instruction.matcher = error.details;
        throw new SemanticPlanningError(
          instruction.error,
          this.instructions.map((item) => ({ ...item })),
          instruction.index,
          error instanceof FormatterMatchError ? error.details : undefined,
        );
      }
    }
    return {
      mutations: this.mutations,
      exact: this.exact,
      instructions: this.instructions.map((instruction) => ({ ...instruction })),
    };
  }

  private newEntryId(): string {
    this.nextEntryId += 1;
    return `planned-entry-${this.nextEntryId}`;
  }

  private newPhysicalFile(linkCount = 1): PhysicalFileState {
    this.nextPhysicalId += 1;
    return {
      id: `planned-physical-${this.nextPhysicalId}`,
      linkCount,
    };
  }

  private releasePhysicalLink(entry: VirtualEntry): void {
    if (entry.kind === "regular" && entry.physical && entry.physical.linkCount > 0) {
      entry.physical.linkCount -= 1;
    }
  }

  private markNoOp(
    instructionIndex: number,
    code: Exclude<ApplyPatchInstructionReasonCode, "dead-dominated" | "move-already-fulfilled">,
  ): void {
    this.instructions[instructionIndex]!.reason = instructionReason(code);
  }

  private async directoryIsCaseInsensitive(directory: string): Promise<boolean> {
    return directoryIsCaseInsensitive(directory, this.caseInsensitiveDirectories);
  }

  private async namesAlias(directory: string, left: string, right: string): Promise<boolean> {
    return namesAlias(directory, left, right, this.caseInsensitiveDirectories);
  }

  private async pathKey(path: string): Promise<string> {
    const known = this.pathKeys.get(path);
    if (known) return known;
    const parent = await realpathWithMissingTail(dirname(path));
    const requestedName = basename(path);
    let actualName = requestedName;
    try {
      const requestedMetadata = await lstat(path);
      const names = await readdir(parent);
      const exactName = names.find((name) => name === requestedName);
      if (exactName) {
        actualName = exactName;
      } else {
        for (const name of names) {
          const metadata = await lstat(join(parent, name));
          if (
            metadata.dev === requestedMetadata.dev &&
            metadata.ino === requestedMetadata.ino &&
            (await this.namesAlias(parent, name, requestedName))
          ) {
            actualName = name;
            break;
          }
        }
      }
    } catch {
      for (const [knownPath, knownKey] of this.pathKeys) {
        const knownParent = await realpathWithMissingTail(dirname(knownPath));
        if (
          knownParent === parent &&
          (await this.namesAlias(parent, basename(knownPath), requestedName))
        ) {
          this.pathKeys.set(path, knownKey);
          return knownKey;
        }
      }
    }
    const key = join(parent, actualName);
    this.pathKeys.set(path, key);
    return key;
  }

  private async stateAt(path: string): Promise<VirtualEntry> {
    const key = await this.pathKey(path);
    const known = this.states.get(key);
    if (known) return known;

    let result: VirtualEntry;
    try {
      const metadata = await lstat(path);
      const entryFingerprint = fingerprint(metadata);
      if (metadata.isFile()) {
        const physicalKey = `${metadata.dev}:${metadata.ino}`;
        let file = this.physicalFiles.get(physicalKey);
        if (!file) {
          file = {
            content: { planned: false },
            physical: this.newPhysicalFile(metadata.nlink),
          };
          this.physicalFiles.set(physicalKey, file);
        }
        result = {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: path,
          sourcePath: path,
          fingerprint: entryFingerprint,
          content: file.content,
          physical: file.physical,
        };
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        result = {
          kind: "symlink",
          id: this.newEntryId(),
          entryPath: path,
          sourcePath: path,
          fingerprint: entryFingerprint,
          target,
          targetPath: resolve(dirname(path), target),
          content: { planned: false },
        };
      } else if (metadata.isDirectory()) {
        result = { kind: "directory", fingerprint: entryFingerprint };
      } else {
        result = {
          kind: "unsupported",
          entryType: entryType(metadata),
          fingerprint: entryFingerprint,
        };
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw new Error(`Failed to inspect ${path}: ${errorMessage(error)}`);
      }
      result = ABSENT_ENTRY;
    }
    this.states.set(key, result);
    return result;
  }

  private async setState(path: string, entry: VirtualEntry): Promise<void> {
    this.states.set(await this.pathKey(path), entry);
  }

  private async sameEntryMoveEffect(
    sourcePath: string,
    destinationPath: string,
  ): Promise<"rename" | "satisfied"> {
    const [sourceParent, destinationParent] = await Promise.all([
      realpath(dirname(sourcePath)).catch(() => dirname(sourcePath)),
      realpath(dirname(destinationPath)).catch(() => dirname(destinationPath)),
    ]);
    return sourceParent === destinationParent &&
      dirname(sourcePath) === dirname(destinationPath) &&
      basename(sourcePath) !== basename(destinationPath)
      ? "rename"
      : "satisfied";
  }

  private virtualSpellingSatisfied(entryPath: string, requestedPath: string): boolean {
    return basename(entryPath) === basename(requestedPath);
  }

  private snapshot<T extends VirtualEntry>(entry: T): T {
    if (entry.kind !== "regular" && entry.kind !== "symlink") return { ...entry };
    return {
      ...entry,
      content: {
        ...(entry.content.value ? { value: entry.content.value } : {}),
        planned: entry.content.planned,
      },
    };
  }

  private async readBytes(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
    visitedSymlinks = new Set<string>(),
  ): Promise<Buffer> {
    if (entry.kind === "regular" && entry.content.value) return entry.content.value.bytes;
    try {
      if (entry.kind === "symlink") {
        const key = await this.pathKey(entry.entryPath);
        if (visitedSymlinks.has(key)) throw new Error("symlink cycle");
        visitedSymlinks.add(key);
        const target = await this.stateAt(entry.targetPath);
        if (target.kind !== "regular" && target.kind !== "symlink") {
          throw new Error(
            target.kind === "absent"
              ? "symlink target does not exist"
              : target.kind === "directory"
                ? "symlink target is a directory"
                : `symlink target is a ${target.entryType}`,
          );
        }
        const bytes = await this.readBytes(target, entry.targetPath, visitedSymlinks);
        entry.content = target.content;
        return bytes;
      }
      const bytes = await readFile(entry.sourcePath ?? path);
      entry.content.value = { bytes };
      return bytes;
    } catch (error) {
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`);
    }
  }

  private async readText(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
  ): Promise<string> {
    if (entry.content.value?.text !== undefined) return entry.content.value.text;
    const bytes = await this.readBytes(entry, path);
    let text: string;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch (error) {
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`);
    }
    entry.content.value = { bytes, text };
    return text;
  }

  private async optionalText(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
  ): Promise<string | undefined> {
    if (entry.content.value?.text !== undefined) return entry.content.value.text;
    try {
      const bytes = await this.readBytes(entry, path);
      const text = UTF8_DECODER.decode(bytes);
      entry.content.value = { bytes, text };
      return text;
    } catch {
      return undefined;
    }
  }

  private async ensureParents(targetPath: string): Promise<ParentPlan> {
    const missing: string[] = [];
    const expectations: ParentPlan["expectations"] = [];
    const root = parse(targetPath).root;
    let parent = dirname(targetPath);
    while (parent !== root) {
      const entry = await this.stateAt(parent);
      if (entry.kind === "absent") {
        expectations.push({ path: parent, kind: "absent" });
        missing.push(parent);
        parent = dirname(parent);
        continue;
      }
      if (entry.kind === "directory") {
        expectations.push({ path: parent, kind: "directory" });
        break;
      }
      if (entry.kind === "symlink") {
        try {
          const metadata = await stat(entry.sourcePath ?? parent);
          if (metadata.isDirectory()) {
            expectations.push({ path: parent, kind: "directory-symlink" });
            break;
          }
        } catch {}
      }
      throw new Error(`Cannot create ${targetPath}: parent path ${parent} is not a directory`);
    }

    const created = missing.toReversed();
    for (const path of created) await this.setState(path, { kind: "directory" });
    return { createdPaths: created, expectations };
  }

  private async entryFilesystemDevice(path: string): Promise<number> {
    const root = parse(path).root;
    let parent = dirname(path);
    while (true) {
      const entry = await this.stateAt(parent);
      if (entry.kind === "directory" && entry.fingerprint) {
        return entry.fingerprint.device;
      }
      if (entry.kind === "symlink") {
        try {
          const metadata = await stat(entry.sourcePath ?? parent);
          if (metadata.isDirectory()) return metadata.dev;
        } catch {}
      }
      if (parent === root) {
        throw new Error(`Cannot determine filesystem for ${path}`);
      }
      parent = dirname(parent);
    }
  }

  private operationRelatedPaths(operation: ResolvedOperation): string[] {
    if (operation.kind !== "update" || !operation.moveAbsolutePath) {
      return [operation.absolutePath];
    }
    return [operation.absolutePath, operation.moveAbsolutePath];
  }

  private async resolvedTextTarget(
    path: string,
  ): Promise<{ path: string; entry: VirtualEntry } | undefined> {
    let targetPath = path;
    let target = await this.stateAt(targetPath);
    const visited = new Set<string>();
    while (target.kind === "symlink") {
      const key = await this.pathKey(target.entryPath);
      if (visited.has(key)) return undefined;
      visited.add(key);
      targetPath = target.targetPath;
      target = await this.stateAt(targetPath);
    }
    return { path: targetPath, entry: target };
  }

  private async operationObservesPhysicalEntry(
    operation: ResolvedOperation,
    affected: Extract<VirtualEntry, { kind: "regular" }>,
  ): Promise<boolean> {
    const sameEntry = (entry: VirtualEntry | undefined): boolean => {
      if (entry?.kind !== "regular") return false;
      if (affected.physical && entry.physical) {
        return affected.physical.id === entry.physical.id;
      }
      return (
        affected.fingerprint !== undefined &&
        entry.fingerprint !== undefined &&
        samePhysicalEntry(affected.fingerprint, entry.fingerprint)
      );
    };
    if (operation.kind === "update" && !chunksAreIdentity(operation.chunks)) {
      const target = await this.resolvedTextTarget(operation.absolutePath);
      return sameEntry(target?.entry);
    }
    if (operation.kind === "update" && chunksAreIdentity(operation.chunks)) {
      if (!updateHasSemanticMove(operation)) return false;
      const source = await this.stateAt(operation.absolutePath);
      const destination = await this.stateAt(operation.moveAbsolutePath!);
      return [source, destination].some(sameEntry);
    }
    return false;
  }

  private async deadUpdateProof(
    index: number,
    targetPath: string,
  ): Promise<DeadOperationProof | undefined> {
    const target = await this.resolvedTextTarget(targetPath);
    if (!target) return undefined;

    const targetKey = await this.pathKey(targetPath);
    if (target.entry.kind === "absent") {
      for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
        const operation = this.operations[futureIndex]!;
        if (
          (operation.kind === "add" || operation.kind === "delete") &&
          (await this.pathKey(operation.absolutePath)) === targetKey
        ) {
          return { dominatingInstructions: [futureIndex + 1] };
        }
        if (
          operation.kind === "update" &&
          !updateHasSemanticMove(operation) &&
          chunksAreIdentity(operation.chunks)
        ) {
          continue;
        }
        if (
          (
            await Promise.all(
              this.operationRelatedPaths(operation).map(async (path) => {
                return (await this.pathKey(path)) === targetKey || pathIsRelated(path, targetPath);
              }),
            )
          ).some(Boolean)
        ) {
          return undefined;
        }
      }
      return undefined;
    }

    if (target.entry.kind !== "regular") return undefined;
    const affectedFingerprint = target.entry.fingerprint;
    const affectedPhysical = target.entry.physical;
    if (!affectedFingerprint && !affectedPhysical) return undefined;
    const effectiveLinkCount = affectedPhysical?.linkCount ?? affectedFingerprint!.linkCount;
    const affectedKey = await this.pathKey(target.path);
    const removedEntryInstructions = new Map<string, number>();
    const samePhysicalFile = (
      entry: VirtualEntry,
    ): entry is Extract<VirtualEntry, { kind: "regular" }> => {
      if (entry.kind !== "regular") return false;
      if (affectedPhysical && entry.physical && affectedPhysical.id === entry.physical.id) {
        return true;
      }
      return (
        affectedFingerprint !== undefined &&
        entry.fingerprint !== undefined &&
        samePhysicalEntry(entry.fingerprint, affectedFingerprint)
      );
    };
    type ProofEntryState = "absent" | "affected" | "other";
    const proofEntryStates = new Map<string, ProofEntryState>();
    const proofEntryAt = async (
      path: string,
    ): Promise<{
      key: string;
      state: ProofEntryState;
      entry?: Extract<VirtualEntry, { kind: "regular" }>;
    }> => {
      const key = await this.pathKey(path);
      const known = proofEntryStates.get(key);
      if (known) return { key, state: known };
      const entry = await this.stateAt(path);
      if (samePhysicalFile(entry)) return { key, state: "affected", entry };
      return { key, state: entry.kind === "absent" ? "absent" : "other" };
    };
    const completedProof = (): DeadOperationProof | undefined => {
      return removedEntryInstructions.size >= effectiveLinkCount
        ? { dominatingInstructions: [...removedEntryInstructions.values()] }
        : undefined;
    };
    for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
      const operation = this.operations[futureIndex]!;
      if (
        operation.kind === "update" &&
        !updateHasSemanticMove(operation) &&
        chunksAreIdentity(operation.chunks)
      ) {
        continue;
      }
      if (operation.kind === "delete") {
        const deleted = await proofEntryAt(operation.absolutePath);
        if (deleted.state === "affected") {
          removedEntryInstructions.set(deleted.key, futureIndex + 1);
          const proof = completedProof();
          if (proof) return proof;
        }
        proofEntryStates.set(deleted.key, "absent");
        continue;
      }
      if (operation.kind === "add") {
        const replaced = await proofEntryAt(operation.absolutePath);
        if (replaced.state === "affected") {
          const entry = replaced.entry!;
          const addIsNoOp =
            buffersEqual(
              await this.readBytes(entry, operation.absolutePath),
              Buffer.from(operation.content, "utf8"),
            ) && this.virtualSpellingSatisfied(entry.entryPath, operation.absolutePath);
          if (addIsNoOp) {
            // Whether this add replaces the entry would depend on the unknown update.
            return undefined;
          }
          removedEntryInstructions.set(replaced.key, futureIndex + 1);
        }
        proofEntryStates.set(replaced.key, "other");
        const proof = completedProof();
        if (proof) return proof;
        continue;
      }
      if (await this.operationObservesPhysicalEntry(operation, target.entry)) {
        return undefined;
      }
      if (
        (
          await Promise.all(
            this.operationRelatedPaths(operation).map(async (path) => {
              return (await this.pathKey(path)) === affectedKey || pathIsRelated(path, target.path);
            }),
          )
        ).some(Boolean)
      ) {
        return undefined;
      }
    }
    return undefined;
  }

  private async deadMoveProof(
    index: number,
    sourcePath: string,
    destinationPath: string,
  ): Promise<DeadOperationProof | undefined> {
    const source = await this.stateAt(sourcePath);
    if (source.kind !== "absent" && source.kind !== "regular" && source.kind !== "symlink") {
      return undefined;
    }
    const sourceKey = await this.pathKey(sourcePath);
    const destinationKey = await this.pathKey(destinationPath);
    let sourceDominated = source.kind === "absent";
    let destinationDominated = false;
    let destinationParentsReproduced = false;
    const dominatingInstructions = new Set<number>();
    const defaultFileMode = 0o666 & ~process.umask();
    const materializedMode =
      source.kind === "regular" && source.fingerprint
        ? source.fingerprint.mode & 0o7777
        : defaultFileMode;

    const destinationParent = await this.stateAt(dirname(destinationPath));
    const destination = await this.stateAt(destinationPath);
    const addResultMode = (entry: VirtualEntry): number | undefined => {
      if (entry.kind === "absent" || entry.kind === "symlink") return defaultFileMode;
      if (entry.kind === "regular" && entry.fingerprint) {
        return entry.fingerprint.mode & 0o7777;
      }
      return undefined;
    };
    const addDominates = async (
      entry: VirtualEntry,
      operation: Extract<ResolvedOperation, { kind: "add" }>,
      expectedMode: number,
    ): Promise<boolean> => {
      if (entry.kind === "regular") {
        if (
          buffersEqual(
            await this.readBytes(entry, operation.absolutePath),
            Buffer.from(operation.content, "utf8"),
          ) &&
          this.virtualSpellingSatisfied(entry.entryPath, operation.absolutePath)
        ) {
          return false;
        }
      }
      return addResultMode(entry) === expectedMode;
    };
    if (destinationParent.kind === "directory") {
      destinationParentsReproduced = true;
    } else if (destinationParent.kind === "symlink") {
      try {
        destinationParentsReproduced = (await stat(destinationParent.entryPath)).isDirectory();
      } catch {
        return undefined;
      }
    }

    for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
      const operation = this.operations[futureIndex]!;
      const instructionNumber = futureIndex + 1;
      const operationPaths = this.operationRelatedPaths(operation);
      const operationKeys = await Promise.all(operationPaths.map((path) => this.pathKey(path)));
      const targetKey = operationKeys[0]!;
      if (operation.kind === "add" || operation.kind === "delete") {
        if (
          targetKey === sourceKey &&
          (operation.kind === "delete" || (await addDominates(source, operation, defaultFileMode)))
        ) {
          sourceDominated = true;
          dominatingInstructions.add(instructionNumber);
        }
        if (targetKey === destinationKey) {
          if (
            operation.kind === "delete" ||
            (await addDominates(destination, operation, materializedMode))
          ) {
            destinationDominated = true;
            dominatingInstructions.add(instructionNumber);
          }
          if (operation.kind === "add") {
            destinationParentsReproduced = true;
            dominatingInstructions.add(instructionNumber);
          }
        }
        if (sourceDominated && destinationDominated && destinationParentsReproduced) {
          return { dominatingInstructions: [...dominatingInstructions] };
        }
        continue;
      }
      if (
        operation.kind === "update" &&
        !updateHasSemanticMove(operation) &&
        chunksAreIdentity(operation.chunks)
      ) {
        continue;
      }
      if (
        operationPaths.some((path, pathIndex) => {
          const key = operationKeys[pathIndex];
          return (
            (!sourceDominated && (key === sourceKey || pathIsRelated(path, sourcePath))) ||
            (!destinationDominated &&
              (key === destinationKey || pathIsRelated(path, destinationPath)))
          );
        })
      ) {
        return undefined;
      }
    }
    return sourceDominated && destinationDominated && destinationParentsReproduced
      ? { dominatingInstructions: [...dominatingInstructions] }
      : undefined;
  }

  private async planAdd(
    operation: Extract<ResolvedOperation, { kind: "add" }>,
    instructionIndex: number,
  ): Promise<void> {
    const target = await this.stateAt(operation.absolutePath);
    if (target.kind === "directory" || target.kind === "unsupported") {
      throw new Error(
        `Cannot add ${operation.absolutePath}: path is ${target.kind === "directory" ? "a directory" : `a ${target.entryType}`}`,
      );
    }
    const content = Buffer.from(operation.content, "utf8");
    if (target.kind === "regular") {
      try {
        if (
          buffersEqual(await this.readBytes(target, operation.absolutePath), content) &&
          (await requestedSpellingExists(operation.absolutePath))
        ) {
          this.markNoOp(instructionIndex, "content-already-present");
          return;
        }
      } catch {
        this.exact = false;
      }
    }

    const parents =
      target.kind === "absent"
        ? await this.ensureParents(operation.absolutePath)
        : { createdPaths: [], expectations: [] };
    const overwrittenContent =
      target.kind === "regular" || target.kind === "symlink"
        ? await this.optionalText(target, operation.absolutePath)
        : undefined;
    const expectedTarget = this.snapshot(target);
    const change: Extract<AppliedPatchChange, { kind: "add" }> = {
      kind: "add",
      path: operation.path,
      content: operation.content,
      ...(overwrittenContent !== undefined ? { overwrittenContent } : {}),
      ...diffDetails("", operation.content),
    };
    const targetKey = await this.pathKey(operation.absolutePath);
    this.mutations.push({
      instructionIndex,
      kind: "add",
      operation,
      expectedTarget,
      parents,
      content,
      ...(target.kind === "regular" && target.fingerprint
        ? { replacementMode: target.fingerprint.mode }
        : {}),
      targetKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: targetKey,
          kind: "regular",
          ...((target.kind === "regular" || target.kind === "symlink") && target.fingerprint
            ? { releasedFingerprint: target.fingerprint }
            : {}),
        },
      ],
      change,
    });
    this.releasePhysicalLink(target);
    await this.setState(operation.absolutePath, {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: operation.absolutePath,
      physical: this.newPhysicalFile(),
      content: {
        value: { bytes: content, text: operation.content },
        planned: true,
      },
    });
  }

  private async planDelete(
    operation: Extract<ResolvedOperation, { kind: "delete" }>,
    index: number,
  ): Promise<void> {
    const target = await this.stateAt(operation.absolutePath);
    if (target.kind === "absent") {
      this.markNoOp(index, "path-already-absent");
      return;
    }
    if (target.kind === "directory" || target.kind === "unsupported") {
      throw new Error(
        `Cannot delete ${operation.absolutePath}: path is ${target.kind === "directory" ? "a directory" : `a ${target.entryType}`}`,
      );
    }

    const content =
      target.kind === "regular"
        ? (target.content.value?.text ??
          (this.hasLaterTextEdit(index, operation.absolutePath)
            ? await this.optionalText(target, operation.absolutePath)
            : undefined))
        : undefined;
    const expectedTarget = this.snapshot(target);
    const change: Extract<AppliedPatchChange, { kind: "delete" }> = {
      kind: "delete",
      path: operation.path,
      entryType: target.kind === "regular" ? "regular-file" : "symlink",
      ...(content !== undefined ? { content } : {}),
      ...(content === undefined
        ? { displayDiff: "", additions: 0, deletions: 0 }
        : diffDetails(content, "")),
    };
    const targetKey = await this.pathKey(operation.absolutePath);
    this.mutations.push({
      instructionIndex: index,
      kind: "delete",
      operation,
      expectedTarget,
      targetKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: targetKey,
          kind: "absent",
          ...((target.kind === "regular" || target.kind === "symlink") && target.fingerprint
            ? { releasedFingerprint: target.fingerprint }
            : {}),
        },
      ],
      change,
    });
    this.releasePhysicalLink(target);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
  }

  private hasLaterTextEdit(index: number, targetPath: string): boolean {
    for (const operation of this.operations.slice(index + 1)) {
      if (operation.absolutePath !== targetPath) {
        if (this.operationRelatedPaths(operation).some((path) => pathIsRelated(path, targetPath))) {
          return false;
        }
        continue;
      }
      if (operation.kind === "add") return true;
      if (operation.kind === "delete") return false;
      return !chunksAreIdentity(operation.chunks);
    }
    return false;
  }

  private async planUpdate(
    operation: Extract<ResolvedOperation, { kind: "update" }>,
    instructionIndex: number,
  ): Promise<void> {
    const identity = chunksAreIdentity(operation.chunks);
    if (identity) {
      if (operation.moveAbsolutePath !== undefined) {
        if (updateHasSemanticMove(operation)) {
          await this.planPureMove(operation, instructionIndex);
        } else {
          this.markNoOp(instructionIndex, "same-entry-move");
        }
      } else {
        this.markNoOp(
          instructionIndex,
          operation.chunks.length === 0 ? "empty-update" : "identity-update",
        );
      }
      return;
    }

    const source = await this.stateAt(operation.absolutePath);
    if (source.kind !== "regular" && source.kind !== "symlink") {
      const description =
        source.kind === "absent"
          ? "path does not exist"
          : source.kind === "unsupported"
            ? `path is a ${source.entryType}`
            : "path is a directory";
      throw new Error(`Failed to read file to update ${operation.absolutePath}: ${description}`);
    }

    const oldContent = await this.readText(source, operation.absolutePath);
    const newContent = await deriveNewContent(
      oldContent,
      operation.chunks,
      operation.absolutePath,
      this.signal,
    );
    const content = Buffer.from(newContent, "utf8");
    const semanticMove = updateHasSemanticMove(operation);
    const sourceKey = await this.pathKey(operation.absolutePath);
    if (!semanticMove && buffersEqual(source.content.value!.bytes, content)) {
      this.markNoOp(instructionIndex, "update-result-unchanged");
      return;
    }

    if (!semanticMove) {
      const expectedSource = this.snapshot(source) as Extract<
        VirtualEntry,
        { kind: "regular" | "symlink" }
      >;
      expectedSource.content.planned = true;
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      this.mutations.push({
        instructionIndex,
        kind: "text-update",
        operation,
        expectedSource,
        parents: { createdPaths: [], expectations: [] },
        content,
        sourceKey,
        entryMutations: [],
        change,
      });
      source.content.value = { bytes: content, text: newContent };
      source.content.planned = true;
      if (source.kind === "symlink") {
        await this.setState(operation.absolutePath, {
          ...source,
        });
      } else {
        await this.setState(operation.absolutePath, {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: operation.absolutePath,
          ...(source.fingerprint?.linkCount === 1 ? {} : { sourcePath: source.sourcePath }),
          content: source.content,
          ...(source.physical ? { physical: source.physical } : {}),
        });
      }
      return;
    }

    const destinationPath = operation.moveAbsolutePath!;
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      const expectedSource = this.snapshot(source) as Extract<
        VirtualEntry,
        { kind: "regular" | "symlink" }
      >;
      expectedSource.content.planned = true;
      const sameEntryMove = await this.sameEntryMoveEffect(operation.absolutePath, destinationPath);
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        moveTo: operation.moveTo!,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      this.mutations.push({
        instructionIndex,
        kind: "text-update",
        operation,
        expectedSource,
        expectedDestination: expectedSource,
        parents: { createdPaths: [], expectations: [] },
        content,
        ...(source.kind === "regular" && source.fingerprint
          ? { replacementMode: source.fingerprint.mode }
          : {}),
        sourceKey,
        destinationKey,
        sameEntryMove,
        entryMutations: [
          {
            path: destinationPath,
            key: destinationKey,
            kind: "regular",
            ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
          },
        ],
        change,
        provisionalChange: {
          kind: "update",
          path: operation.path,
          oldContent,
          newContent,
          ...diffDetails(oldContent, newContent),
        },
      });
      this.releasePhysicalLink(source);
      const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
        kind: "regular",
        id: this.newEntryId(),
        entryPath: destinationPath,
        physical: this.newPhysicalFile(),
        content: {
          value: { bytes: content, text: newContent },
          planned: true,
        },
      };
      await this.setState(destinationPath, resultingEntry);
      this.fulfilledMoves.set(sourceKey, {
        destinationKey,
        destinationEntryId: resultingEntry.id,
        instruction: instructionIndex + 1,
      });
      return;
    }

    const destination = await this.stateAt(destinationPath);
    if (destination.kind === "directory" || destination.kind === "unsupported") {
      throw new Error(
        `Cannot move update to ${destinationPath}: destination is ${destination.kind === "directory" ? "a directory" : `a ${destination.entryType}`}`,
      );
    }
    const parents =
      destination.kind === "absent"
        ? await this.ensureParents(destinationPath)
        : { createdPaths: [], expectations: [] };
    const overwrittenMoveContent =
      destination.kind === "regular" || destination.kind === "symlink"
        ? await this.optionalText(destination, destinationPath)
        : undefined;
    const expectedSource = this.snapshot(source) as Extract<
      VirtualEntry,
      { kind: "regular" | "symlink" }
    >;
    expectedSource.content.planned = true;
    const expectedDestination = this.snapshot(destination);
    const change: Extract<AppliedPatchChange, { kind: "update" }> = {
      kind: "update",
      path: operation.path,
      moveTo: operation.moveTo!,
      oldContent,
      newContent,
      ...(overwrittenMoveContent !== undefined ? { overwrittenMoveContent } : {}),
      ...diffDetails(oldContent, newContent),
    };
    const provisionalChange: Extract<AppliedPatchChange, { kind: "add" }> = {
      kind: "add",
      path: operation.moveTo!,
      content: newContent,
      ...(overwrittenMoveContent !== undefined
        ? { overwrittenContent: overwrittenMoveContent }
        : {}),
      ...diffDetails("", newContent),
    };
    this.mutations.push({
      instructionIndex,
      kind: "text-update",
      operation,
      expectedSource,
      expectedDestination,
      parents,
      content,
      ...(source.kind === "regular" && source.fingerprint
        ? { replacementMode: source.fingerprint.mode }
        : {}),
      sourceKey,
      destinationKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: sourceKey,
          kind: "absent",
          ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
        },
        {
          path: destinationPath,
          key: destinationKey,
          kind: "regular",
          ...((destination.kind === "regular" || destination.kind === "symlink") &&
          destination.fingerprint
            ? { releasedFingerprint: destination.fingerprint }
            : {}),
        },
      ],
      change,
      provisionalChange,
    });
    this.releasePhysicalLink(source);
    this.releasePhysicalLink(destination);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: destinationPath,
      physical: this.newPhysicalFile(),
      content: {
        value: { bytes: content, text: newContent },
        planned: true,
      },
    };
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: resultingEntry.id,
      instruction: instructionIndex + 1,
    });
  }

  private async planPureMove(
    operation: Extract<ResolvedOperation, { kind: "update" }>,
    instructionIndex: number,
  ): Promise<void> {
    const destinationPath = operation.moveAbsolutePath!;
    const sourceKey = await this.pathKey(operation.absolutePath);
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      if (operation.absolutePath === destinationPath) {
        this.markNoOp(instructionIndex, "same-entry-move");
        return;
      }
      const source = await this.stateAt(operation.absolutePath);
      if (
        (source.kind === "regular" || source.kind === "symlink") &&
        this.virtualSpellingSatisfied(source.entryPath, destinationPath)
      ) {
        this.markNoOp(instructionIndex, "same-entry-move");
        return;
      }
      if ((await this.sameEntryMoveEffect(operation.absolutePath, destinationPath)) === "rename") {
        if (source.kind !== "regular" && source.kind !== "symlink") {
          throw new Error(
            `Failed to move ${operation.absolutePath}: source is ${source.kind === "directory" ? "a directory" : source.kind === "absent" ? "absent" : `a ${source.entryType}`}`,
          );
        }
        const expectedSource = this.snapshot(source) as Extract<
          VirtualEntry,
          { kind: "regular" | "symlink" }
        >;
        const change: Extract<AppliedPatchChange, { kind: "move" }> = {
          kind: "move",
          sourcePath: operation.path,
          destinationPath: operation.moveTo!,
          replacedDestination: false,
          entryType: expectedSource.kind === "regular" ? "regular-file" : "symlink",
          exact: true,
          displayDiff: "",
          additions: 0,
          deletions: 0,
        };
        this.mutations.push({
          instructionIndex,
          kind: "move",
          operation,
          expectedSource,
          expectedDestination: this.snapshot(source),
          parents: { createdPaths: [], expectations: [] },
          sourceKey,
          destinationKey,
          moveStrategy: "rename",
          entryMutations: [
            {
              path: destinationPath,
              key: destinationKey,
              kind: expectedSource.kind,
            },
          ],
          change,
        });
        await this.setState(destinationPath, { ...source, entryPath: destinationPath });
        return;
      }
      this.markNoOp(instructionIndex, "same-entry-move");
      return;
    }

    const source = await this.stateAt(operation.absolutePath);
    if (source.kind === "absent") {
      const fulfilled = this.fulfilledMoves.get(sourceKey);
      const destination = await this.stateAt(destinationPath);
      if (
        fulfilled?.destinationKey === destinationKey &&
        (destination.kind === "regular" || destination.kind === "symlink") &&
        fulfilled.destinationEntryId === destination.id
      ) {
        this.instructions[instructionIndex]!.reason = moveAlreadyFulfilledReason(
          fulfilled.instruction,
        );
        return;
      }
      throw new Error(
        `Failed to move ${operation.absolutePath}: source does not exist, and no earlier instruction moved it to ${destinationPath}`,
      );
    }
    if (source.kind !== "regular" && source.kind !== "symlink") {
      throw new Error(
        `Failed to move ${operation.absolutePath}: source is ${source.kind === "directory" ? "a directory" : `a ${source.entryType}`}`,
      );
    }

    const expectedDestination = await this.stateAt(destinationPath);
    if (expectedDestination.kind === "directory" || expectedDestination.kind === "unsupported") {
      throw new Error(
        `Failed to move to ${destinationPath}: destination is ${expectedDestination.kind === "directory" ? "a directory" : `a ${expectedDestination.entryType}`}`,
      );
    }
    const parents =
      expectedDestination.kind === "absent"
        ? await this.ensureParents(destinationPath)
        : { createdPaths: [], expectations: [] };
    const [sourceDevice, destinationDevice] = await Promise.all([
      source.fingerprint?.device ?? this.entryFilesystemDevice(operation.absolutePath),
      this.entryFilesystemDevice(destinationPath),
    ]);
    const detectedMoveStrategy = sourceDevice === destinationDevice ? "rename" : "copy-unlink";
    const moveStrategy = this.selectMoveStrategy
      ? await this.selectMoveStrategy(operation.absolutePath, destinationPath, detectedMoveStrategy)
      : detectedMoveStrategy;
    const replacedDestination = expectedDestination.kind !== "absent";
    const expectedSource = this.snapshot(source) as Extract<
      VirtualEntry,
      { kind: "regular" | "symlink" }
    >;
    const destinationSnapshot = this.snapshot(expectedDestination);
    const change: Extract<AppliedPatchChange, { kind: "move" }> = {
      kind: "move",
      sourcePath: operation.path,
      destinationPath: operation.moveTo!,
      replacedDestination,
      entryType: expectedSource.kind === "regular" ? "regular-file" : "symlink",
      exact: true,
      displayDiff: "",
      additions: 0,
      deletions: 0,
    };
    this.mutations.push({
      instructionIndex,
      kind: "move",
      operation,
      expectedSource,
      expectedDestination: destinationSnapshot,
      parents,
      sourceKey,
      destinationKey,
      moveStrategy,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: sourceKey,
          kind: "absent",
          ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
        },
        {
          path: destinationPath,
          key: destinationKey,
          kind: expectedSource.kind === "regular" ? "regular" : "symlink",
          ...((expectedDestination.kind === "regular" || expectedDestination.kind === "symlink") &&
          expectedDestination.fingerprint
            ? { releasedFingerprint: expectedDestination.fingerprint }
            : {}),
        },
      ],
      change,
    });
    this.releasePhysicalLink(expectedDestination);
    if (moveStrategy === "copy-unlink") this.releasePhysicalLink(source);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    let resultingEntry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
    if (moveStrategy === "copy-unlink" && source.kind === "regular") {
      const content: ContentCell = {
        ...(source.content.value ? { value: source.content.value } : {}),
        planned: source.content.planned,
      };
      resultingEntry = {
        kind: "regular",
        id: this.newEntryId(),
        entryPath: destinationPath,
        sourcePath: source.sourcePath ?? source.entryPath,
        content,
        physical: this.newPhysicalFile(),
      };
    } else if (moveStrategy === "copy-unlink" && source.kind === "symlink") {
      resultingEntry = {
        kind: "symlink",
        id: this.newEntryId(),
        entryPath: destinationPath,
        target: source.target,
        targetPath: resolve(dirname(destinationPath), source.target),
        content: { planned: false },
      };
    } else if (source.kind === "symlink") {
      resultingEntry = {
        kind: "symlink",
        id: source.id,
        entryPath: destinationPath,
        ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}),
        target: source.target,
        targetPath: resolve(dirname(destinationPath), source.target),
        content: { planned: false },
      };
    } else {
      resultingEntry = { ...source, entryPath: destinationPath };
    }
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: resultingEntry.id,
      instruction: instructionIndex + 1,
    });
  }
}

class RegularFileReplacementError extends Error {
  readonly destinationChanged: boolean;
  readonly temporaryPath: string | undefined;

  constructor(message: string, destinationChanged: boolean, temporaryPath?: string) {
    super(message);
    this.destinationChanged = destinationChanged;
    this.temporaryPath = temporaryPath;
  }
}

async function replaceRegularFile(
  path: string,
  content: Buffer,
  filesystem: ApplyPatchExecutionFilesystem,
  mode?: number,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.apply-patch-${randomUUID()}.tmp`,
  );
  let destinationChanged = false;
  let temporaryEntryRemains = false;
  let pendingError: unknown;
  try {
    await filesystem.writeFile(temporaryPath, content);
    if (mode !== undefined) await filesystem.chmod(temporaryPath, mode & 0o7777);
    await filesystem.rename(temporaryPath, path);
    destinationChanged = true;
    await establishExactSpelling(path, filesystem);
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await filesystem.unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) {
        temporaryEntryRemains = true;
        if (pendingError === undefined) pendingError = error;
      }
    }
  }
  if (pendingError !== undefined) {
    throw new RegularFileReplacementError(
      errorMessage(pendingError),
      destinationChanged,
      temporaryEntryRemains ? temporaryPath : undefined,
    );
  }
}

function namesPotentiallyAlias(left: string, right: string): boolean {
  const normalizedLeft = process.platform === "darwin" ? left.normalize("NFD") : left;
  const normalizedRight = process.platform === "darwin" ? right.normalize("NFD") : right;
  return normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase();
}

async function establishExactSpelling(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  if (await exactSpellingExists(path, filesystem)) return;
  const directory = dirname(path);
  const requestedName = basename(path);
  const requestedMetadata = await filesystem.lstat(path);
  let actualPath: string | undefined;
  for (const name of await filesystem.readdir(directory)) {
    if (!namesPotentiallyAlias(name, requestedName)) continue;
    const metadata = await filesystem.lstat(join(directory, name));
    if (metadata.dev === requestedMetadata.dev && metadata.ino === requestedMetadata.ino) {
      actualPath = join(directory, name);
      break;
    }
  }
  if (!actualPath) throw new Error(`could not locate filesystem spelling for ${path}`);

  const temporaryPath = resolve(
    directory,
    `.${requestedName}.apply-patch-spelling-${randomUUID()}.tmp`,
  );
  await filesystem.rename(actualPath, temporaryPath);
  try {
    await filesystem.rename(temporaryPath, path);
  } catch (error) {
    try {
      await filesystem.rename(temporaryPath, actualPath);
    } catch {
      // Preserve the original error; the executor reports that the mutation is inexact.
    }
    throw error;
  }
}

function appendChange(
  details: ApplyPatchDetails,
  change: AppliedPatchChange,
  instructionIndex?: number,
): void {
  const changeIndex = details.changes.length;
  details.changes.push(change);
  if (instructionIndex !== undefined) {
    const instruction = details.instructions?.[instructionIndex];
    if (instruction) {
      instruction.changeIndexes ??= [];
      instruction.changeIndexes.push(changeIndex);
    }
  }
  if (change.kind === "add") details.added.push(change.path);
  else if (change.kind === "delete") details.deleted.push(change.path);
  else if (change.kind === "move") details.modified.push(change.destinationPath);
  else details.modified.push(change.moveTo ?? change.path);
}

function detailsForPlan(plan: SemanticPlan): ApplyPatchDetails {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  for (const mutation of plan.mutations) {
    appendChange(details, mutation.change, mutation.instructionIndex);
  }
  return details;
}

function previewDetailsForPlan(plan: SemanticPlan, cwd: string): ApplyPatchDetails {
  const details = detailsForPlan(plan);
  details.changes = coalesceAppliedPatchChangesForRendering(details.changes, cwd);
  details.added = [];
  details.modified = [];
  details.deleted = [];
  for (const change of details.changes) {
    if (change.kind === "add") details.added.push(change.path);
    else if (change.kind === "delete") details.deleted.push(change.path);
    else if (change.kind === "move") details.modified.push(change.destinationPath);
    else details.modified.push(change.moveTo ?? change.path);
  }
  return details;
}

async function currentEntry(path: string): Promise<VirtualEntry> {
  try {
    const metadata = await lstat(path);
    const entryFingerprint = fingerprint(metadata);
    if (metadata.isFile()) {
      return {
        kind: "regular",
        id: "",
        entryPath: path,
        fingerprint: entryFingerprint,
        content: { planned: false },
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      return {
        kind: "symlink",
        id: "",
        entryPath: path,
        fingerprint: entryFingerprint,
        target,
        targetPath: resolve(dirname(path), target),
        content: { planned: false },
      };
    }
    if (metadata.isDirectory()) return { kind: "directory", fingerprint: entryFingerprint };
    return {
      kind: "unsupported",
      entryType: entryType(metadata),
      fingerprint: entryFingerprint,
    };
  } catch (error) {
    if (isNotFound(error)) return ABSENT_ENTRY;
    throw error;
  }
}

async function assertEntryMatches(path: string, expected: VirtualEntry): Promise<void> {
  let actual: VirtualEntry;
  try {
    actual = await currentEntry(path);
  } catch (error) {
    throw new Error(`Failed to verify ${path} before mutation: ${errorMessage(error)}`);
  }
  if (actual.kind !== expected.kind) {
    throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
  }
  if (
    "fingerprint" in expected &&
    expected.fingerprint &&
    "fingerprint" in actual &&
    actual.fingerprint &&
    !sameFingerprint(expected.fingerprint, actual.fingerprint)
  ) {
    const contentMatch =
      (expected.kind === "regular" || expected.kind === "symlink") &&
      expected.content.planned &&
      expected.content.value &&
      buffersEqual(await readFile(path), expected.content.value.bytes);
    if (!contentMatch) {
      throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
    }
  }
  if (expected.kind === "symlink" && actual.kind === "symlink") {
    if (expected.target !== actual.target) {
      throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
    }
    if (
      expected.content.planned &&
      expected.content.value &&
      !buffersEqual(await readFile(path), expected.content.value.bytes)
    ) {
      throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
    }
  }
  if (
    expected.kind === "regular" &&
    actual.kind === "regular" &&
    expected.content.planned &&
    expected.content.value &&
    !buffersEqual(await readFile(path), expected.content.value.bytes)
  ) {
    throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
  }
}

async function assertMutationEntryMatches(
  path: string,
  key: string,
  expected: VirtualEntry,
  priorMutations: readonly CommittedEntryMutation[],
): Promise<void> {
  const prior = priorMutations.findLast((mutation) => mutation.key === key);
  const effectiveExpected = prior?.expected ?? expected;

  try {
    await assertEntryMatches(path, effectiveExpected);
  } catch (error) {
    if (
      (effectiveExpected.kind === "regular" || effectiveExpected.kind === "symlink") &&
      effectiveExpected.fingerprint
    ) {
      const expectedFingerprint = effectiveExpected.fingerprint;
      const actual = await currentEntry(path);
      const linkCountWasChangedByPlan =
        (actual.kind === "regular" || actual.kind === "symlink") &&
        actual.fingerprint !== undefined &&
        sameFingerprintExceptLinkCount(expectedFingerprint, actual.fingerprint) &&
        priorMutations.some(({ releasedFingerprint }) => {
          return (
            releasedFingerprint?.device === expectedFingerprint.device &&
            releasedFingerprint.inode === expectedFingerprint.inode
          );
        });
      if (linkCountWasChangedByPlan) return;
    }
    throw error;
  }
}

async function captureCommittedEntryMutations(
  mutations: readonly PlannedEntryMutation[],
): Promise<CommittedEntryMutation[]> {
  const committed: CommittedEntryMutation[] = [];
  for (const mutation of mutations) {
    const expected = await currentEntry(mutation.path);
    if (expected.kind !== mutation.kind) {
      throw new Error(`Filesystem changed while committing apply_patch at ${mutation.path}`);
    }
    committed.push({
      path: mutation.path,
      key: mutation.key,
      expected,
      ...(mutation.releasedFingerprint
        ? { releasedFingerprint: mutation.releasedFingerprint }
        : {}),
    });
  }
  return committed;
}

async function assertParentPlanMatches(parents: ParentPlan): Promise<void> {
  for (const expectation of parents.expectations) {
    let actual: VirtualEntry;
    try {
      actual = await currentEntry(expectation.path);
    } catch (error) {
      throw new Error(
        `Failed to verify parent ${expectation.path} before mutation: ${errorMessage(error)}`,
      );
    }
    if (expectation.kind === "absent") {
      if (actual.kind !== "absent") {
        throw new Error(`Filesystem changed after apply_patch preflight at ${expectation.path}`);
      }
      continue;
    }
    if (expectation.kind === "directory") {
      if (actual.kind !== "directory") {
        throw new Error(`Filesystem changed after apply_patch preflight at ${expectation.path}`);
      }
      continue;
    }
    if (actual.kind !== "symlink") {
      throw new Error(`Filesystem changed after apply_patch preflight at ${expectation.path}`);
    }
    try {
      if (!(await stat(expectation.path)).isDirectory()) {
        throw new Error(`Filesystem changed after apply_patch preflight at ${expectation.path}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to verify parent ${expectation.path} before mutation: ${errorMessage(error)}`,
      );
    }
  }
}

async function createPlannedParents(
  parents: ParentPlan,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const deepest = parents.createdPaths.at(-1);
  if (deepest) await filesystem.mkdir(deepest, { recursive: true });
}

async function exactSpellingExists(
  path: string,
  filesystem: Pick<ApplyPatchExecutionFilesystem, "readdir"> = DEFAULT_EXECUTION_FILESYSTEM,
): Promise<boolean> {
  try {
    return (await filesystem.readdir(dirname(path))).includes(basename(path));
  } catch {
    return false;
  }
}

async function requestedSpellingExists(path: string): Promise<boolean> {
  try {
    return (await readdir(dirname(path))).includes(basename(path));
  } catch {
    return false;
  }
}

async function finishSameInodeRename(
  sourcePath: string,
  destinationPath: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  let sourceMetadata: Stats;
  let destinationMetadata: Stats;
  try {
    [sourceMetadata, destinationMetadata] = await Promise.all([
      filesystem.lstat(sourcePath),
      filesystem.lstat(destinationPath),
    ]);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (
    sourceMetadata.dev !== destinationMetadata.dev ||
    sourceMetadata.ino !== destinationMetadata.ino
  ) {
    throw new Error(`rename returned without removing source ${sourcePath}`);
  }

  const [sourceNameExists, destinationNameExists] = await Promise.all([
    exactSpellingExists(sourcePath, filesystem),
    exactSpellingExists(destinationPath, filesystem),
  ]);
  if (!destinationNameExists) {
    throw new Error(`rename completed without creating destination entry ${destinationPath}`);
  }
  if (sourceNameExists) await filesystem.unlink(sourcePath);
}

class PureMoveExecutionError extends Error {
  readonly destinationState: "unchanged" | "removed" | "created" | "replaced";
  readonly temporaryPath: string | undefined;

  constructor(
    message: string,
    destinationState: "unchanged" | "removed" | "created" | "replaced",
    temporaryPath?: string,
  ) {
    super(message);
    this.destinationState = destinationState;
    this.temporaryPath = temporaryPath;
  }
}

async function executeCrossDeviceMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath!;
  const temporaryPath = resolve(
    dirname(destinationPath),
    `.${basename(destinationPath)}.apply-patch-${randomUUID()}.tmp`,
  );
  let destinationChanged = false;
  let destinationRemoved = false;
  let temporaryEntryRemains = false;
  let pendingError: unknown;
  try {
    if (mutation.expectedSource.kind === "regular") {
      await filesystem.copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      if (mutation.expectedSource.fingerprint) {
        await filesystem.chmod(temporaryPath, mutation.expectedSource.fingerprint.mode);
        const metadata = await filesystem.lstat(sourcePath);
        await filesystem.utimes(temporaryPath, metadata.atime, metadata.mtime);
      }
    } else {
      await filesystem.symlink(await filesystem.readlink(sourcePath), temporaryPath);
    }

    try {
      await filesystem.rename(temporaryPath, destinationPath);
    } catch (error) {
      if (
        mutation.expectedDestination.kind === "absent" ||
        (!hasErrorCode(error, "EEXIST") &&
          !hasErrorCode(error, "ENOTEMPTY") &&
          !hasErrorCode(error, "EPERM"))
      ) {
        throw error;
      }
      await filesystem.unlink(destinationPath);
      destinationRemoved = true;
      await filesystem.rename(temporaryPath, destinationPath);
    }
    destinationChanged = true;
    await filesystem.unlink(sourcePath);
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await filesystem.unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) {
        temporaryEntryRemains = true;
        if (pendingError === undefined) pendingError = error;
      }
    }
  }
  if (pendingError !== undefined) {
    const message =
      destinationRemoved && !destinationChanged
        ? `${errorMessage(pendingError)}; destination was removed before replacement failed`
        : errorMessage(pendingError);
    throw new PureMoveExecutionError(
      message,
      destinationChanged
        ? mutation.expectedDestination.kind === "absent"
          ? "created"
          : "replaced"
        : destinationRemoved
          ? "removed"
          : "unchanged",
      temporaryEntryRemains ? temporaryPath : undefined,
    );
  }
}

async function executePureMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath!;
  if (mutation.moveStrategy === "copy-unlink") {
    await executeCrossDeviceMove(mutation, filesystem);
    return;
  }
  try {
    await filesystem.rename(sourcePath, destinationPath);
  } catch (error) {
    if (hasErrorCode(error, "EXDEV")) {
      throw new Error("rename unexpectedly crossed filesystem boundaries after validation");
    }
    throw error;
  }
  try {
    await finishSameInodeRename(sourcePath, destinationPath, filesystem);
  } catch (error) {
    let destinationChanged = false;
    try {
      await filesystem.lstat(destinationPath);
      destinationChanged = true;
    } catch {}
    throw new PureMoveExecutionError(
      errorMessage(error),
      destinationChanged
        ? mutation.expectedDestination.kind === "absent"
          ? "created"
          : "replaced"
        : "unchanged",
    );
  }
}

function addInstructionEffect(
  instruction: ApplyPatchInstructionDetails,
  effect: ApplyPatchInstructionEffect,
): void {
  instruction.effects ??= [];
  if (
    !instruction.effects.some(
      (candidate) => candidate.kind === effect.kind && candidate.path === effect.path,
    )
  ) {
    instruction.effects.push(effect);
  }
}

function replacedInstructionEffect(
  path: string,
  previousEntry: ReplaceableFileEntry,
): ApplyPatchInstructionEffect {
  if (previousEntry.kind === "absent") {
    throw new Error(`replacement effect for ${path} requires an existing entry`);
  }
  return previousEntry.kind === "regular"
    ? { kind: "replaced", path, previousEntryType: "regular-file" }
    : {
        kind: "replaced",
        path,
        previousEntryType: "symlink",
        originalTarget: previousEntry.target,
      };
}

function addInstructionFinalState(
  instruction: ApplyPatchInstructionDetails,
  state: ApplyPatchFinalPathState,
): void {
  instruction.finalStates ??= [];
  const existing = instruction.finalStates.findIndex((candidate) => candidate.path === state.path);
  if (existing === -1) instruction.finalStates.push(state);
  else instruction.finalStates[existing] = state;
}

function currentEntryFinalState(entry: VirtualEntry): ApplyPatchFinalPathState["state"] {
  switch (entry.kind) {
    case "absent":
      return "absent";
    case "regular":
      return "regular-file";
    case "symlink":
      return "symlink";
    case "directory":
      return "directory";
    case "unsupported":
      return "other-entry";
  }
}

function entriesHaveSameIdentity(actual: VirtualEntry, expected: VirtualEntry): boolean {
  if (actual.kind !== expected.kind) return false;
  if (
    (actual.kind === "regular" || actual.kind === "symlink") &&
    (expected.kind === "regular" || expected.kind === "symlink")
  ) {
    if (actual.fingerprint && expected.fingerprint) {
      return sameFingerprintExceptLinkCount(actual.fingerprint, expected.fingerprint);
    }
    return actual.kind === "symlink" && expected.kind === "symlink"
      ? actual.target === expected.target
      : false;
  }
  if (actual.kind === "directory" && expected.kind === "directory") {
    return (
      actual.fingerprint !== undefined &&
      expected.fingerprint !== undefined &&
      sameFingerprintExceptLinkCount(actual.fingerprint, expected.fingerprint)
    );
  }
  return actual.kind === "absent" && expected.kind === "absent";
}

async function currentExecutionEntry(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<VirtualEntry> {
  try {
    const metadata = await filesystem.lstat(path);
    const entryFingerprint = fingerprint(metadata);
    if (metadata.isFile()) {
      return {
        kind: "regular",
        id: "",
        entryPath: path,
        fingerprint: entryFingerprint,
        content: { planned: false },
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await filesystem.readlink(path);
      return {
        kind: "symlink",
        id: "",
        entryPath: path,
        fingerprint: entryFingerprint,
        target,
        targetPath: resolve(dirname(path), target),
        content: { planned: false },
      };
    }
    if (metadata.isDirectory()) return { kind: "directory", fingerprint: entryFingerprint };
    return {
      kind: "unsupported",
      entryType: entryType(metadata),
      fingerprint: entryFingerprint,
    };
  } catch (error) {
    if (isNotFound(error)) return ABSENT_ENTRY;
    throw error;
  }
}

async function inspectFinalPath(
  absolutePath: string,
  displayPath: string,
  expected: VirtualEntry,
  filesystem: ApplyPatchExecutionFilesystem,
  requestedContent?: Buffer,
): Promise<ApplyPatchFinalPathState> {
  try {
    const actual = await currentExecutionEntry(absolutePath, filesystem);
    const physicalEntryChanged =
      actual.kind === expected.kind &&
      (actual.kind === "regular" || actual.kind === "symlink") &&
      (expected.kind === "regular" || expected.kind === "symlink") &&
      actual.fingerprint !== undefined &&
      expected.fingerprint !== undefined &&
      !samePhysicalEntry(actual.fingerprint, expected.fingerprint);
    if (requestedContent && (actual.kind === "regular" || actual.kind === "symlink")) {
      try {
        const bytes = await filesystem.readFile(absolutePath);
        if (buffersEqual(bytes, requestedContent)) {
          return { path: displayPath, state: "requested-content" };
        }
        if (physicalEntryChanged) {
          return { path: displayPath, state: "different-entry" };
        }
        if (expected.kind === "regular" || expected.kind === "symlink") {
          const expectedBytes = expected.content.value?.bytes;
          if (expectedBytes && buffersEqual(bytes, expectedBytes)) {
            return { path: displayPath, state: "unchanged" };
          }
          if (expectedBytes) {
            return {
              path: displayPath,
              state: "different-from-requested-and-previous-content",
            };
          }
        }
        return { path: displayPath, state: "different-from-requested-content" };
      } catch {
        return {
          path: displayPath,
          state: physicalEntryChanged ? "different-entry" : "not-verified",
        };
      }
    }
    if (physicalEntryChanged) {
      return { path: displayPath, state: "different-entry" };
    }
    if (
      (actual.kind === "regular" || actual.kind === "symlink") &&
      (expected.kind === "regular" || expected.kind === "symlink") &&
      expected.content.value
    ) {
      try {
        const bytes = await filesystem.readFile(absolutePath);
        return {
          path: displayPath,
          state: buffersEqual(bytes, expected.content.value.bytes)
            ? "unchanged"
            : "different-from-previous-content",
        };
      } catch {
        return { path: displayPath, state: "not-verified" };
      }
    }
    if (entriesHaveSameIdentity(actual, expected)) {
      return { path: displayPath, state: "unchanged" };
    }
    if (actual.kind !== expected.kind && actual.kind !== "absent" && expected.kind !== "absent") {
      return { path: displayPath, state: "different-entry-type" };
    }
    if (
      actual.kind === expected.kind &&
      "fingerprint" in actual &&
      actual.fingerprint &&
      "fingerprint" in expected &&
      expected.fingerprint
    ) {
      return { path: displayPath, state: "different-entry" };
    }
    return { path: displayPath, state: currentEntryFinalState(actual) };
  } catch {
    return { path: displayPath, state: "not-verified" };
  }
}

function finalStateHasChangedPresentEntry(
  state: ApplyPatchFinalPathState | undefined,
  expected: VirtualEntry,
): boolean {
  if (!state) return false;
  switch (state.state) {
    case "requested-content":
    case "different-from-requested-content":
    case "different-from-requested-and-previous-content":
    case "different-from-previous-content":
    case "different-entry":
    case "different-entry-type":
      return true;
    case "regular-file":
    case "symlink":
    case "directory":
    case "other-entry":
      return expected.kind === "absent";
    case "unchanged":
    case "absent":
    case "not-verified":
      return false;
  }
}

async function recordFailureInspection(
  mutation: PlannedMutation,
  instruction: ApplyPatchInstructionDetails,
  filesystem: ApplyPatchExecutionFilesystem,
  filesystemMutationStarted: boolean,
  temporaryPath?: string,
): Promise<void> {
  const inspected: ApplyPatchFinalPathState[] = [];
  if (mutation.kind === "add") {
    inspected.push(
      await inspectFinalPath(
        mutation.operation.absolutePath,
        mutation.operation.path,
        mutation.expectedTarget,
        filesystem,
        mutation.content,
      ),
    );
  } else if (mutation.kind === "delete") {
    inspected.push(
      await inspectFinalPath(
        mutation.operation.absolutePath,
        mutation.operation.path,
        mutation.expectedTarget,
        filesystem,
      ),
    );
  } else if (mutation.kind === "text-update") {
    inspected.push(
      await inspectFinalPath(
        mutation.operation.absolutePath,
        mutation.operation.path,
        mutation.expectedSource,
        filesystem,
        mutation.operation.moveAbsolutePath ? undefined : mutation.content,
      ),
    );
    if (mutation.operation.moveAbsolutePath && mutation.expectedDestination) {
      inspected.push(
        await inspectFinalPath(
          mutation.operation.moveAbsolutePath,
          mutation.operation.moveTo!,
          mutation.expectedDestination,
          filesystem,
          mutation.content,
        ),
      );
    }
  } else {
    inspected.push(
      await inspectFinalPath(
        mutation.operation.absolutePath,
        mutation.operation.path,
        mutation.expectedSource,
        filesystem,
      ),
    );
    inspected.push(
      await inspectFinalPath(
        mutation.operation.moveAbsolutePath!,
        mutation.operation.moveTo!,
        mutation.expectedDestination,
        filesystem,
      ),
    );
  }

  for (const state of inspected) addInstructionFinalState(instruction, state);
  if (!filesystemMutationStarted) return;

  const sourceState = inspected.find((state) => state.path === mutation.operation.path);
  const destinationPath =
    mutation.kind === "text-update" || mutation.kind === "move"
      ? mutation.operation.moveTo
      : undefined;
  const destinationState = destinationPath
    ? inspected.find((state) => state.path === destinationPath)
    : undefined;

  if (mutation.kind === "add") {
    if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedTarget)) {
      addInstructionEffect(
        instruction,
        mutation.expectedTarget.kind === "absent"
          ? { kind: "created", path: mutation.operation.path }
          : replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget),
      );
    }
  } else if (mutation.kind === "delete") {
    if (sourceState?.state === "absent") {
      addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
    } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedTarget)) {
      addInstructionEffect(
        instruction,
        replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget),
      );
    }
  } else if (mutation.kind === "text-update") {
    if (mutation.operation.moveTo) {
      if (
        destinationState &&
        mutation.expectedDestination &&
        finalStateHasChangedPresentEntry(destinationState, mutation.expectedDestination)
      ) {
        addInstructionEffect(
          instruction,
          mutation.expectedDestination.kind === "absent"
            ? { kind: "created", path: mutation.operation.moveTo }
            : replacedInstructionEffect(mutation.operation.moveTo, mutation.expectedDestination),
        );
      } else if (
        destinationState?.state === "absent" &&
        mutation.expectedDestination?.kind !== "absent"
      ) {
        addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.moveTo });
      }
      if (sourceState?.state === "unchanged") {
        addInstructionEffect(instruction, {
          kind: "source-remains",
          path: mutation.operation.path,
        });
      } else if (sourceState?.state === "absent") {
        addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
      } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedSource)) {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(mutation.operation.path, mutation.expectedSource),
        );
      }
    } else if (sourceState?.state === "absent") {
      addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
    } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedSource)) {
      addInstructionEffect(instruction, { kind: "updated", path: mutation.operation.path });
    }
  } else {
    if (
      destinationState &&
      finalStateHasChangedPresentEntry(destinationState, mutation.expectedDestination)
    ) {
      addInstructionEffect(
        instruction,
        mutation.expectedDestination.kind === "absent"
          ? { kind: "created", path: mutation.operation.moveTo! }
          : replacedInstructionEffect(mutation.operation.moveTo!, mutation.expectedDestination),
      );
    } else if (
      destinationState?.state === "absent" &&
      mutation.expectedDestination.kind !== "absent"
    ) {
      addInstructionEffect(instruction, {
        kind: "deleted",
        path: mutation.operation.moveTo!,
      });
    }
    if (sourceState?.state === "unchanged") {
      addInstructionEffect(instruction, {
        kind: "source-remains",
        path: mutation.operation.path,
      });
    } else if (sourceState?.state === "absent") {
      addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
    } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedSource)) {
      addInstructionEffect(
        instruction,
        replacedInstructionEffect(mutation.operation.path, mutation.expectedSource),
      );
    }
  }

  const createdParents = "parents" in mutation ? mutation.parents.createdPaths : [];
  for (const parent of createdParents) {
    try {
      if ((await filesystem.lstat(parent)).isDirectory()) {
        addInstructionEffect(instruction, { kind: "directory-created", path: parent });
      }
    } catch {}
  }

  if (temporaryPath) {
    try {
      await filesystem.lstat(temporaryPath);
      addInstructionEffect(instruction, {
        kind: "temporary-entry-remains",
        path: temporaryPath,
      });
    } catch {}
  }
}

function recordAppliedInstructionEffects(
  mutation: PlannedMutation,
  instruction: ApplyPatchInstructionDetails,
): void {
  switch (mutation.kind) {
    case "add":
      if (mutation.expectedTarget.kind !== "absent") {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget),
        );
      }
      return;
    case "delete":
      if (mutation.expectedTarget.kind === "symlink") {
        addInstructionEffect(instruction, {
          kind: "symlink-target-not-modified",
          path: mutation.operation.path,
          target: mutation.expectedTarget.target,
          symlinkAction: "removed",
        });
      }
      return;
    case "text-update":
      if (mutation.expectedSource.kind === "symlink") {
        addInstructionEffect(
          instruction,
          mutation.operation.moveTo
            ? {
                kind: "symlink-target-not-modified",
                path: mutation.operation.path,
                target: mutation.expectedSource.target,
                symlinkAction: "removed",
              }
            : {
                kind: "symlink-target-modified",
                path: mutation.operation.path,
                target: mutation.expectedSource.target,
              },
        );
      }
      if (
        mutation.operation.moveTo &&
        mutation.expectedDestination &&
        mutation.expectedDestination.kind !== "absent"
      ) {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(mutation.operation.moveTo, mutation.expectedDestination),
        );
      }
      return;
    case "move":
      if (mutation.expectedSource.kind === "symlink") {
        addInstructionEffect(instruction, {
          kind: "symlink-target-not-modified",
          path: mutation.operation.path,
          target: mutation.expectedSource.target,
          symlinkAction: "moved",
        });
      }
      if (mutation.expectedDestination.kind !== "absent") {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(mutation.operation.moveTo!, mutation.expectedDestination),
        );
      }
      return;
  }
}

async function executePlan(
  plan: SemanticPlan,
  signal: AbortSignal | undefined,
  filesystem: ApplyPatchExecutionFilesystem,
  onProgress?: (details: ApplyPatchDetails) => void,
): Promise<ApplyPatchDetails> {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  let activeInstruction: ApplyPatchInstructionDetails | undefined;
  let activeMutation: PlannedMutation | undefined;
  let activeTemporaryPath: string | undefined;
  let activeFilesystemMutationStarted = false;
  const committedEntryMutations: CommittedEntryMutation[] = [];
  try {
    for (const mutation of plan.mutations) {
      activeInstruction = details.instructions[mutation.instructionIndex];
      activeMutation = mutation;
      activeTemporaryPath = undefined;
      activeFilesystemMutationStarted = false;
      throwIfAborted(signal);
      if (mutation.kind === "add") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.targetKey,
          mutation.expectedTarget,
          committedEntryMutations,
        );
        await assertParentPlanMatches(mutation.parents);
        try {
          activeFilesystemMutationStarted = true;
          await createPlannedParents(mutation.parents, filesystem);
          await replaceRegularFile(
            mutation.operation.absolutePath,
            mutation.content,
            filesystem,
            mutation.replacementMode,
          );
        } catch (error) {
          details.exact = false;
          if (error instanceof RegularFileReplacementError) {
            activeTemporaryPath = error.temporaryPath;
            if (error.destinationChanged) {
              appendChange(details, mutation.change, mutation.instructionIndex);
              if (activeInstruction) {
                addInstructionEffect(
                  activeInstruction,
                  mutation.expectedTarget.kind === "absent"
                    ? { kind: "created", path: mutation.operation.path }
                    : replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget),
                );
              }
            }
          }
          throw new Error(
            `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "delete") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.targetKey,
          mutation.expectedTarget,
          committedEntryMutations,
        );
        try {
          activeFilesystemMutationStarted = true;
          await filesystem.unlink(mutation.operation.absolutePath);
        } catch (error) {
          throw new Error(
            `Failed to delete file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "text-update") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.sourceKey,
          mutation.expectedSource,
          committedEntryMutations,
        );
        if (mutation.sameEntryMove) {
          try {
            activeFilesystemMutationStarted = true;
            await replaceRegularFile(
              mutation.operation.absolutePath,
              mutation.content,
              filesystem,
              mutation.replacementMode,
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError) {
              activeTemporaryPath = error.temporaryPath;
              if (error.destinationChanged) {
                appendChange(details, mutation.provisionalChange!, mutation.instructionIndex);
                if (activeInstruction) {
                  addInstructionEffect(activeInstruction, {
                    kind: "updated",
                    path: mutation.operation.path,
                  });
                }
              }
            }
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.provisionalChange!, mutation.instructionIndex);
          if (mutation.sameEntryMove === "rename") {
            try {
              await filesystem.rename(
                mutation.operation.absolutePath,
                mutation.operation.moveAbsolutePath!,
              );
              await finishSameInodeRename(
                mutation.operation.absolutePath,
                mutation.operation.moveAbsolutePath!,
                filesystem,
              );
            } catch (error) {
              details.exact = false;
              throw new Error(
                `Failed to establish move from ${mutation.operation.absolutePath} to ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
              );
            }
          }
          details.changes[details.changes.length - 1] = mutation.change;
          details.modified[details.modified.length - 1] = mutation.operation.moveTo!;
        } else if (mutation.operation.moveAbsolutePath && mutation.expectedDestination) {
          await assertMutationEntryMatches(
            mutation.operation.moveAbsolutePath,
            mutation.destinationKey!,
            mutation.expectedDestination,
            committedEntryMutations,
          );
          await assertParentPlanMatches(mutation.parents);
          try {
            activeFilesystemMutationStarted = true;
            await createPlannedParents(mutation.parents, filesystem);
            await replaceRegularFile(
              mutation.operation.moveAbsolutePath,
              mutation.content,
              filesystem,
              mutation.replacementMode,
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError) {
              activeTemporaryPath = error.temporaryPath;
              if (error.destinationChanged) {
                appendChange(details, mutation.provisionalChange!, mutation.instructionIndex);
                if (activeInstruction) {
                  addInstructionEffect(
                    activeInstruction,
                    mutation.expectedDestination.kind === "absent"
                      ? { kind: "created", path: mutation.operation.moveTo! }
                      : replacedInstructionEffect(
                          mutation.operation.moveTo!,
                          mutation.expectedDestination,
                        ),
                  );
                }
              }
            }
            throw new Error(
              `Failed to write file ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.provisionalChange!, mutation.instructionIndex);
          try {
            await filesystem.unlink(mutation.operation.absolutePath);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to remove original ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          details.changes[details.changes.length - 1] = mutation.change;
          details.added.pop();
          details.modified.push(mutation.operation.moveTo!);
        } else {
          try {
            activeFilesystemMutationStarted = true;
            await filesystem.writeFile(mutation.operation.absolutePath, mutation.content);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.change, mutation.instructionIndex);
        }
      } else {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.sourceKey,
          mutation.expectedSource,
          committedEntryMutations,
        );
        await assertMutationEntryMatches(
          mutation.operation.moveAbsolutePath!,
          mutation.destinationKey,
          mutation.expectedDestination,
          committedEntryMutations,
        );
        await assertParentPlanMatches(mutation.parents);
        try {
          activeFilesystemMutationStarted = true;
          await createPlannedParents(mutation.parents, filesystem);
          await executePureMove(mutation, filesystem);
        } catch (error) {
          if (error instanceof PureMoveExecutionError) {
            activeTemporaryPath = error.temporaryPath;
          }
          if (mutation.parents.createdPaths.length > 0) details.exact = false;
          if (
            error instanceof PureMoveExecutionError &&
            (error.destinationState === "created" || error.destinationState === "replaced")
          ) {
            const inexactMove = { ...mutation.change, exact: false };
            appendChange(details, inexactMove, mutation.instructionIndex);
            if (activeInstruction) {
              addInstructionEffect(
                activeInstruction,
                error.destinationState === "created"
                  ? { kind: "created", path: mutation.operation.moveTo! }
                  : replacedInstructionEffect(
                      mutation.operation.moveTo!,
                      mutation.expectedDestination,
                    ),
              );
            }
            details.exact = false;
          }
          if (error instanceof PureMoveExecutionError && error.destinationState === "removed") {
            if (activeInstruction) {
              addInstructionEffect(activeInstruction, {
                kind: "deleted",
                path: mutation.operation.moveTo!,
              });
            }
            details.exact = false;
          }
          throw new Error(
            `Failed to move ${mutation.operation.absolutePath} to ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      }
      if (activeInstruction) recordAppliedInstructionEffects(mutation, activeInstruction);
      try {
        committedEntryMutations.push(
          ...(await captureCommittedEntryMutations(mutation.entryMutations)),
        );
      } catch (error) {
        details.exact = false;
        throw error;
      }
      if (activeInstruction) {
        activeInstruction.status = "applied";
        delete activeInstruction.error;
      }
      activeInstruction = undefined;
      activeMutation = undefined;
      throwIfAborted(signal);
      onProgress?.(cloneApplyPatchDetails(details));
    }
    return details;
  } catch (error) {
    const message = errorMessage(error);
    if (activeInstruction) {
      if (activeMutation) {
        await recordFailureInspection(
          activeMutation,
          activeInstruction,
          filesystem,
          activeFilesystemMutationStarted,
          activeTemporaryPath,
        );
      }
      activeInstruction.status = "failed";
      activeInstruction.error = message;
    }
    for (const instruction of details.instructions) {
      if (instruction.status === "planned") instruction.status = "not-run";
    }
    details.status = "failed";
    details.error = message;
    details.failure = {
      phase: "execution",
      message,
      ...(activeInstruction ? { failedInstruction: activeInstruction.index } : {}),
    };
    throw new ApplyPatchExecutionError(details.error, cloneApplyPatchDetails(details));
  }
}

type ScannedPatchInstruction = ApplyPatchInstructionDetails & { sourceLine: number };

function scanPatchInstructions(patch: string): ScannedPatchInstruction[] {
  const instructions: ScannedPatchInstruction[] = [];
  let current: ScannedPatchInstruction | undefined;
  let mode: ParserMode["kind"] = "not-started";
  let lines = patch.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const first = lines[0];
  const last = lines.at(-1);
  if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last?.endsWith("EOF")) {
    lines = lines.slice(1, -1);
  }

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line: string = mode === "update" ? rustTrimEnd(rawLine) : rustTrim(rawLine);
    if (mode === "not-started") {
      if (rustTrim(line) === BEGIN_PATCH) mode = "started";
      continue;
    }
    if (mode === "ended") continue;
    if (line === END_PATCH) {
      mode = "ended";
      continue;
    }
    const headers = [
      { prefix: ADD_FILE, kind: "add" as const },
      { prefix: DELETE_FILE, kind: "delete" as const },
      { prefix: UPDATE_FILE, kind: "update" as const },
    ];
    const header: (typeof headers)[number] | undefined = headers.find(({ prefix }) =>
      line.startsWith(prefix),
    );
    if (header) {
      current = {
        index: instructions.length + 1,
        kind: header.kind,
        path: line.slice(header.prefix.length),
        status: "not-run",
        sourceLine: lineIndex + 1,
      };
      instructions.push(current);
      mode = header.kind;
      continue;
    }
    if (mode === "update" && current?.kind === "update" && line.startsWith(MOVE_TO)) {
      current.kind = "move";
      current.moveTo = line.slice(MOVE_TO.length);
    }
  }
  return instructions;
}

function failedApplyPatchDetails(
  phase: ApplyPatchFailureDetails["phase"],
  message: string,
  instructions: readonly ApplyPatchInstructionDetails[],
  failedInstruction?: number,
  matcher?: FormatterMatchFailureDetails,
): ApplyPatchDetails {
  const details = emptyDetails();
  details.status = "failed";
  details.error = message;
  details.instructions = instructions.map((instruction) => ({ ...instruction }));
  if (failedInstruction !== undefined) {
    const failed = details.instructions.find(
      (instruction) => instruction.index === failedInstruction,
    );
    if (failed) {
      failed.status = "failed";
      failed.error = message;
    }
  }
  details.failure = {
    phase,
    message,
    ...(failedInstruction !== undefined ? { failedInstruction } : {}),
    ...(matcher ? { matcher } : {}),
  };
  return details;
}

function parseFailureDetails(patch: string, error: unknown): ApplyPatchDetails {
  const scanned = scanPatchInstructions(patch);
  const lineNumber = error instanceof ApplyPatchParseError ? error.lineNumber : undefined;
  const failedInstruction =
    lineNumber === undefined
      ? undefined
      : scanned.findLast((instruction) => instruction.sourceLine <= lineNumber)?.index;
  return failedApplyPatchDetails("parse", errorMessage(error), scanned, failedInstruction);
}

function parseAndResolvePatch(cwd: string, patch: string): ResolvedOperation[] {
  const parsed = parsePatchDocument(patch);
  if (parsed.environmentId) {
    throw new ApplyPatchInputError(
      "apply_patch environment selection is unavailable for this turn",
    );
  }
  if (parsed.operations.length === 0) {
    throw new ApplyPatchInputError("patch rejected: empty patch");
  }
  return resolveOperations(cwd, parsed.operations);
}

async function buildPlan(
  operations: readonly ResolvedOperation[],
  signal?: AbortSignal,
  selectMoveStrategy?: ApplyPatchExecutionHooks["selectMoveStrategy"],
): Promise<SemanticPlan> {
  try {
    return await new SemanticPlanner(operations, signal, selectMoveStrategy).plan();
  } catch (error) {
    if (error instanceof ApplyPatchInputError) throw error;
    const message = errorMessage(error);
    const instructions =
      error instanceof SemanticPlanningError
        ? error.instructions
        : operations.map(instructionForOperation);
    const details = failedApplyPatchDetails(
      "preflight",
      message,
      instructions,
      error instanceof SemanticPlanningError ? error.failedInstruction : undefined,
      error instanceof SemanticPlanningError ? error.matcher : undefined,
    );
    throw new ApplyPatchVerificationError(`apply_patch verification failed: ${message}`, details);
  }
}

export async function previewPatch(cwd: string, patch: string): Promise<ApplyPatchDetails> {
  const operations = parseAndResolvePatch(cwd, patch);
  return previewDetailsForPlan(await buildPlan(operations), cwd);
}

export async function applyPatch(
  cwd: string,
  patch: string,
  signal?: AbortSignal,
  hooks: ApplyPatchExecutionHooks = {},
): Promise<ApplyPatchDetails> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    const message = errorMessage(error);
    throw new ApplyPatchInputError(
      message,
      failedApplyPatchDetails("input", message, scanPatchInstructions(patch)),
    );
  }
  let operations: ResolvedOperation[];
  try {
    operations = parseAndResolvePatch(cwd, patch);
  } catch (error) {
    if (error instanceof ApplyPatchInputError) {
      throw new ApplyPatchInputError(
        error.message,
        error.details ??
          failedApplyPatchDetails("input", error.message, scanPatchInstructions(patch)),
      );
    }
    const message = errorMessage(error);
    throw new ApplyPatchVerificationError(
      `apply_patch verification failed: ${message}`,
      parseFailureDetails(patch, error),
    );
  }

  try {
    const queueTargets = mutationQueueTargets(operations);
    const logicalKeys = await logicalMutationQueueKeys(queueTargets);
    const queuePaths = await canonicalMutationQueuePaths(queueTargets);
    const filesystem: ApplyPatchExecutionFilesystem = {
      ...DEFAULT_EXECUTION_FILESYSTEM,
      ...hooks.filesystem,
    };

    return await withLogicalMutationQueues(logicalKeys, () => {
      return withMutationQueues(queuePaths, async () => {
        throwIfAborted(signal);
        const plan = await buildPlan(operations, signal, hooks.selectMoveStrategy);
        throwIfAborted(signal);
        await hooks.onExecutionStart?.();
        return executePlan(plan, signal, filesystem, hooks.onProgress);
      });
    });
  } catch (error) {
    if (
      error instanceof ApplyPatchInputError ||
      error instanceof ApplyPatchVerificationError ||
      error instanceof ApplyPatchExecutionError
    ) {
      throw error;
    }
    const message = errorMessage(error);
    const details = failedApplyPatchDetails(
      "preflight",
      message,
      operations.map(instructionForOperation),
    );
    throw new ApplyPatchVerificationError(`apply_patch verification failed: ${message}`, details);
  }
}

export function formatApplyPatchInstructionLabel(
  instruction: ApplyPatchInstructionDetails,
): string {
  const verb =
    instruction.kind === "add"
      ? "Add"
      : instruction.kind === "delete"
        ? "Delete"
        : instruction.kind === "move"
          ? "Move"
          : "Update";
  if (!instruction.moveTo) return `${verb} ${instruction.path}`;
  return instruction.kind === "update"
    ? `Update & Move ${instruction.path} -> ${instruction.moveTo}`
    : `${verb} ${instruction.path} -> ${instruction.moveTo}`;
}

function feedbackPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const relativePath = relative(cwd, path);
  return relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
    ? path
    : relativePath;
}

function matcherRangeLabel(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}-${range.endLine}`;
}

function matcherInstructionFeedback(matcher: FormatterMatchFailureDetails): string {
  const ranges = matcher.candidates.map(matcherRangeLabel).join(" and ");
  switch (matcher.reason) {
    case "no-candidate": {
      const replacements = matcher.replacementCandidates?.map(matcherRangeLabel).join(" and ");
      return replacements
        ? `Requested replacement found at ${replacements}, but old content was not found.`
        : "Old content was not found.";
    }
    case "no-ordered-mapping": {
      const previous = matcher.previousCandidates?.map(matcherRangeLabel).join(" and ");
      if (matcher.reverseOrdered) {
        return `Edit group ${matcher.groupIndex} matches before edit group ${matcher.previousGroupIndex}; matches at ${ranges} and ${previous}.`;
      }
      if (matcher.overlapping) {
        return `Edit group ${matcher.groupIndex} overlaps edit group ${matcher.previousGroupIndex}; matches at ${ranges} and ${previous}.`;
      }
      return `Edit group ${matcher.groupIndex} does not follow edit group ${matcher.previousGroupIndex}; matches at ${ranges} and ${previous}.`;
    }
    case "too-many-candidates":
      return `${matcher.candidateCount} matching locations exceed the 64-location limit.`;
    case "ambiguous-output":
      return `Matching locations${ranges ? ` at ${ranges}` : ""} produce different results.`;
    case "mapping-limit":
      return "Matching stopped after 256 complete mappings.";
    case "overlapping-edits":
      return `Matching edits${ranges ? ` at ${ranges}` : ""} overlap.`;
  }
}

function conciseInstructionError(error: string): string {
  const message = error
    .replace(/^apply_patch verification failed:\s*/u, "")
    .replace(/^invalid patch:\s*/u, "")
    .replace(/^invalid hunk at line \d+,\s*/u, "")
    .replace(/^Failed to write file .*?:\s*/u, "Write failed: ")
    .replace(/^Failed to delete file .*?:\s*/u, "Delete failed: ")
    .replace(
      /^Failed to remove original .*?:\s*/u,
      "The updated content was written to the destination, but removing the source failed: ",
    )
    .replace(/^Failed to establish move from .*?:\s*/u, "Rename failed: ")
    .replace(/^Failed to read file to update .*?:\s*/u, "Read failed: ")
    .replace(/^Failed to inspect /u, "Failed to read filesystem metadata for ")
    .replace(/^Cannot add .*?: path is\s*/u, "Validation failed: Path is ")
    .replace(/^Cannot delete .*?: path is\s*/u, "Validation failed: Path is ")
    .replace(/^Cannot move update to .*?: destination is\s*/u, "Validation failed: Destination is ")
    .replace(/^Failed to move to .*?: destination is\s*/u, "Validation failed: Destination is ")
    .replace(/^Failed to move .*?: source is\s*/u, "Validation failed: Source is ")
    .replace(
      /^Failed to move .*?: source does not exist, and no earlier instruction moved it to .*$/u,
      "Validation failed: The move source does not exist, and no earlier instruction moved it to the destination.",
    )
    .replace(
      /^Cannot create .*?: parent path .*? is not a directory$/u,
      "Validation failed: Parent path is not a directory.",
    )
    .replace(/^Cannot determine filesystem for .*$/u, "Filesystem check failed.")
    .replace(/^Failed to move .*? to .*?:\s*/u, "Move failed: ")
    .replace(/^Failed to find context [^\n]*/u, "Context was not found.")
    .replace(/^Failed to find expected lines in [^\n]*/u, "Old content was not found.")
    .replace(
      /^Filesystem changed after apply_patch preflight at .*$/u,
      "Filesystem changed after validation.",
    )
    .replace(
      /^Filesystem changed while committing apply_patch at .*$/u,
      "Filesystem changed after the operation.",
    )
    .replace(/; destination was removed before replacement failed$/u, "")
    .replace(/^apply_patch was cancelled\.$/u, "Patch stopped.");
  return message.split("\n")[0]!;
}

function instructionEffectFeedback(effect: ApplyPatchInstructionEffect, cwd: string): string {
  const path = feedbackPath(effect.path, cwd);
  switch (effect.kind) {
    case "created":
      return `Created ${path}.`;
    case "replaced":
      return effect.previousEntryType === "regular-file"
        ? `Replaced the regular file at ${path}.`
        : `Replaced the symlink at ${path} (original target: ${effect.originalTarget}); the original target was not modified.`;
    case "updated":
      return `Updated ${path}.`;
    case "deleted":
      return `Deleted ${path}.`;
    case "directory-created":
      return `Created directory ${path}.`;
    case "temporary-entry-remains":
      return `Temporary entry remains at ${path}.`;
    case "source-remains":
      return `${path} remains.`;
    case "symlink-target-not-modified":
      return effect.symlinkAction === "moved"
        ? `The moved symlink from ${path} retains target ${effect.target}.`
        : `Removed the symlink at ${path} (original target: ${effect.target}); the original target was not modified.`;
    case "symlink-target-modified":
      return `Modified file content through the symlink at ${path} (target: ${effect.target}); the symlink was not modified.`;
  }
}

function finalStateFeedback(state: ApplyPatchFinalPathState, cwd: string): string {
  const path = feedbackPath(state.path, cwd);
  switch (state.state) {
    case "absent":
      return `${path} is absent.`;
    case "regular-file":
      return `${path} is present as a regular file.`;
    case "symlink":
      return `${path} is present as a symlink.`;
    case "directory":
      return `${path} is present as a directory.`;
    case "other-entry":
      return `${path} is present as another entry type.`;
    case "unchanged":
      return `${path} is unchanged.`;
    case "requested-content":
      return `The file at ${path} contains the requested content byte-for-byte despite the reported error.`;
    case "different-from-requested-content":
      return `The content at ${path} does not match the requested content byte-for-byte.`;
    case "different-from-requested-and-previous-content":
      return `The content at ${path} matches neither the requested content nor the previously observed content.`;
    case "different-from-previous-content":
      return `The content at ${path} does not match the previously observed content.`;
    case "different-entry":
      return `${path} is a different filesystem entry.`;
    case "different-entry-type":
      return `Entry type changed for ${path}.`;
    case "not-verified":
      return `Final state not verified for ${path}.`;
  }
}

export function formatApplyPatchInstructionStatusLabel(
  status: ApplyPatchInstructionStatus,
): string {
  switch (status) {
    case "applied":
      return "APPLIED";
    case "planned":
      return "PLANNED";
    case "no-op":
      return "NO CHANGE";
    case "dead":
      return "SKIPPED";
    case "failed":
      return "FAILED";
    case "not-run":
      return "NOT RUN";
  }
}

function sentenceClause(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

export function formatApplyPatchInstructionFeedback(
  instruction: ApplyPatchInstructionDetails,
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string | undefined {
  const clauses: string[] = [];
  if (instruction.status === "no-op" || instruction.status === "dead") {
    if (instruction.reason) clauses.push(instruction.reason.message);
  }
  for (const effect of instruction.effects ?? []) {
    if (instruction.status === "failed" && effect.kind === "updated") continue;
    clauses.push(instructionEffectFeedback(effect, cwd));
  }
  if (instruction.status === "failed") {
    if (instruction.matcher) clauses.push(matcherInstructionFeedback(instruction.matcher));
    else if (instruction.error) clauses.push(conciseInstructionError(instruction.error));
    const effectPaths = new Set((instruction.effects ?? []).map((effect) => effect.path));
    for (const state of instruction.finalStates ?? []) {
      if (
        state.state === "not-verified" ||
        state.state === "requested-content" ||
        state.state === "different-from-requested-content" ||
        state.state === "different-from-requested-and-previous-content" ||
        state.state === "different-from-previous-content" ||
        state.state === "different-entry" ||
        state.state === "different-entry-type" ||
        !effectPaths.has(state.path)
      ) {
        clauses.push(finalStateFeedback(state, cwd));
      }
    }
  }
  if (instruction.status === "not-run") {
    if (details.failure?.failedInstruction !== undefined) {
      clauses.push(`Instruction ${details.failure.failedInstruction} failed.`);
    } else if (details.failure?.message === "apply_patch was cancelled.") {
      clauses.push("Patch stopped.");
    } else if (details.failure?.phase === "parse") {
      clauses.push("Patch format error.");
    } else if (details.failure?.phase === "preflight") {
      clauses.push("Filesystem setup failed.");
    } else if (details.failure?.phase === "input") {
      clauses.push("Patch input error.");
    } else {
      clauses.push("Patch stopped.");
    }
  }

  if (clauses.length === 0) return undefined;
  return `${clauses.map(sentenceClause).join("; ")}.`;
}

export function formatApplyPatchInstructionResult(
  instruction: ApplyPatchInstructionDetails,
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string {
  const result = `${instruction.index}. [${formatApplyPatchInstructionStatusLabel(instruction.status)}] ${formatApplyPatchInstructionLabel(instruction)}`;
  const feedback = formatApplyPatchInstructionFeedback(instruction, details, cwd);
  return feedback ? `${result} - ${feedback}` : result;
}

export function applyPatchSummaryPaths(details: ApplyPatchDetails): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const added = new Set(details.added);
  const modified = new Set(details.modified);
  const deleted = new Set(details.deleted);
  const partialMoveChanges = new Set(
    (details.instructions ?? []).flatMap((instruction) =>
      instruction.status === "failed"
        ? (instruction.changeIndexes ?? []).filter((index) => {
            const change = details.changes[index];
            return change?.kind === "move" && !change.exact;
          })
        : [],
    ),
  );
  const completedChangePaths = new Set(
    details.changes.flatMap((change, index) => {
      if (partialMoveChanges.has(index)) return [];
      if (change.kind === "move") return [change.destinationPath];
      if (change.kind === "update") return [change.moveTo ?? change.path];
      return [change.path];
    }),
  );
  for (const index of partialMoveChanges) {
    const change = details.changes[index];
    if (change?.kind === "move" && !completedChangePaths.has(change.destinationPath)) {
      modified.delete(change.destinationPath);
    }
  }
  const confirmedPaths = new Set([...added, ...modified, ...deleted]);
  for (const instruction of details.instructions ?? []) {
    for (const effect of instruction.effects ?? []) {
      if (added.has(effect.path) || modified.has(effect.path) || deleted.has(effect.path)) {
        if (
          effect.kind === "created" ||
          effect.kind === "replaced" ||
          effect.kind === "updated" ||
          effect.kind === "deleted"
        ) {
          confirmedPaths.add(effect.path);
        }
        continue;
      }
      if (effect.kind === "created") {
        added.add(effect.path);
        confirmedPaths.add(effect.path);
      } else if (effect.kind === "replaced" || effect.kind === "updated") {
        modified.add(effect.path);
        confirmedPaths.add(effect.path);
      } else if (effect.kind === "deleted") {
        deleted.add(effect.path);
        confirmedPaths.add(effect.path);
      }
    }
  }
  const unverifiedPaths = new Set(
    (details.instructions ?? []).flatMap((instruction) =>
      (instruction.finalStates ?? []).flatMap((state) =>
        state.state === "not-verified" ? [state.path] : [],
      ),
    ),
  );
  for (const path of unverifiedPaths) {
    if (confirmedPaths.has(path)) continue;
    added.delete(path);
    modified.delete(path);
    deleted.delete(path);
  }
  return { added: [...added], modified: [...modified], deleted: [...deleted] };
}

export function applyPatchHasOtherFilesystemChanges(details: ApplyPatchDetails): boolean {
  return (details.instructions ?? []).some((instruction) =>
    instruction.effects?.some(
      (effect) => effect.kind === "directory-created" || effect.kind === "temporary-entry-remains",
    ),
  );
}

export function applyPatchNeedsInstructionResults(
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): boolean {
  return (details.instructions ?? []).some(
    (instruction) =>
      instruction.status !== "applied" ||
      formatApplyPatchInstructionFeedback(instruction, details, cwd) !== undefined,
  );
}

function instructionResults(details: ApplyPatchDetails, cwd: string): string[] {
  const instructions = details.instructions ?? [];
  if (!applyPatchNeedsInstructionResults(details, cwd)) return [];
  return [
    "Patch instruction results:",
    ...instructions.map((instruction) =>
      formatApplyPatchInstructionResult(instruction, details, cwd),
    ),
  ];
}

export function formatApplyPatchSummary(details: ApplyPatchDetails, cwd = process.cwd()): string {
  const lines: string[] = [];
  const summary = applyPatchSummaryPaths(details);
  if (summary.added.length === 0 && summary.modified.length === 0 && summary.deleted.length === 0) {
    lines.push("Success. No files were changed.");
  } else {
    lines.push("Success. Updated the following files:");
    for (const path of summary.added) lines.push(`A ${feedbackPath(path, cwd)}`);
    for (const path of summary.modified) lines.push(`M ${feedbackPath(path, cwd)}`);
    for (const path of summary.deleted) lines.push(`D ${feedbackPath(path, cwd)}`);
  }
  const results = instructionResults(details, cwd);
  if (results.length > 0) lines.push("", ...results);
  return `${lines.join("\n")}\n`;
}

export function formatApplyPatchFailureHeading(details: ApplyPatchDetails): string[] {
  const lines: string[] = [];
  const instructions = details.instructions ?? [];
  const failed = instructions.find((instruction) => instruction.status === "failed");
  if (failed) {
    lines.push(`Patch failed at instruction ${failed.index} of ${instructions.length}.`);
  } else if (details.failure?.phase === "parse") {
    const line = details.failure.message.match(/line (\d+)/u)?.[1];
    lines.push(
      `Patch format error${line ? ` at line ${line}` : ""}: ${conciseInstructionError(details.failure.message)}`,
    );
  } else if (details.failure?.phase === "preflight") {
    lines.push(`Patch setup failed: ${conciseInstructionError(details.failure.message)}`);
  } else if (
    details.failure?.phase === "input" &&
    details.failure.message !== "apply_patch was cancelled."
  ) {
    lines.push(`Patch input error: ${conciseInstructionError(details.failure.message)}`);
  } else {
    const lastApplied = instructions.findLast((instruction) => instruction.status === "applied");
    lines.push(
      lastApplied
        ? `Patch stopped after instruction ${lastApplied.index}.`
        : "Patch stopped before execution.",
    );
    if (details.failure?.message && details.failure.message !== "apply_patch was cancelled.") {
      lines.push(`Patch error: ${conciseInstructionError(details.failure.message)}`);
    }
  }
  return lines;
}

export function formatApplyPatchFailureSummary(
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string {
  const lines = formatApplyPatchFailureHeading(details);
  const instructions = details.instructions ?? [];
  const summary = applyPatchSummaryPaths(details);
  const hasSummary =
    summary.added.length > 0 || summary.modified.length > 0 || summary.deleted.length > 0;
  const hasOtherFilesystemChanges = applyPatchHasOtherFilesystemChanges(details);
  const hasUnverifiedState = instructions.some((instruction) =>
    instruction.finalStates?.some((state) => state.state === "not-verified"),
  );
  if (hasSummary) {
    lines.push("Files changed:");
    for (const path of summary.added) lines.push(`A ${feedbackPath(path, cwd)}`);
    for (const path of summary.modified) lines.push(`M ${feedbackPath(path, cwd)}`);
    for (const path of summary.deleted) lines.push(`D ${feedbackPath(path, cwd)}`);
  } else if (hasOtherFilesystemChanges) {
    lines.push("Filesystem changed.");
  } else if (!hasUnverifiedState) {
    lines.push("No files were changed.");
  }

  const results = instructionResults(details, cwd);
  if (results.length > 0) lines.push("", ...results);
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
