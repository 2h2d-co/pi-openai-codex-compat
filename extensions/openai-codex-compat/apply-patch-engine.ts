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
      entryType: "regular-file" | "symbolic-link";
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

export type ApplyPatchInstructionDetails = {
  index: number;
  kind: "add" | "delete" | "update" | "move";
  path: string;
  moveTo?: string;
  status: ApplyPatchInstructionStatus;
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
  return {
    ...details,
    changes: details.changes.map((change) => ({ ...change })),
    added: [...details.added],
    modified: [...details.modified],
    deleted: [...details.deleted],
    ...(details.instructions
      ? { instructions: details.instructions.map((instruction) => ({ ...instruction })) }
      : {}),
    ...(details.failure
      ? {
          failure: {
            ...details.failure,
            ...(details.failure.matcher
              ? {
                  matcher: {
                    ...details.failure.matcher,
                    candidates: details.failure.matcher.candidates.map((range) => ({ ...range })),
                    ...(details.failure.matcher.previousCandidates
                      ? {
                          previousCandidates: details.failure.matcher.previousCandidates.map(
                            (range) => ({ ...range }),
                          ),
                        }
                      : {}),
                    ...(details.failure.matcher.replacementCandidates
                      ? {
                          replacementCandidates: details.failure.matcher.replacementCandidates.map(
                            (range) => ({
                              ...range,
                            }),
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

export type ApplyPatchExecutionHooks = {
  onExecutionStart?: () => void;
  onProgress?: (details: ApplyPatchDetails) => void;
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

async function canonicalMutationQueuePaths(paths: readonly string[]): Promise<string[]> {
  const canonicalPaths = await Promise.all(
    paths.map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if (isNotFound(error) || hasErrorCode(error, "ENOTDIR")) {
          return realpathWithMissingTail(path);
        }
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

type ParentPlan = {
  createdPaths: string[];
  expectations: Array<{ path: string; kind: "absent" | "directory" | "directory-symlink" }>;
};

type PlannedMutation = (
  | {
      kind: "add";
      operation: Extract<ResolvedOperation, { kind: "add" }>;
      expectedTarget: VirtualEntry;
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
      expectedTarget: VirtualEntry;
      targetKey: string;
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "delete" }>;
    }
  | {
      kind: "text-update";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedSource: VirtualEntry;
      expectedDestination?: VirtualEntry;
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
      expectedSource: Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
      expectedDestination: VirtualEntry;
      parents: ParentPlan;
      sourceKey: string;
      destinationKey: string;
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
  private readonly physicalContent = new Map<string, ContentCell>();
  private readonly mutations: PlannedMutation[] = [];
  private readonly fulfilledMoves = new Map<
    string,
    { destinationKey: string; destinationEntryId: string }
  >();
  private nextEntryId = 0;
  private exact = true;
  private readonly operations: readonly ResolvedOperation[];
  private readonly instructions: ApplyPatchInstructionDetails[];
  private readonly signal: AbortSignal | undefined;
  private readonly pathKeys = new Map<string, string>();
  private readonly caseInsensitiveDirectories = new Map<string, Promise<boolean>>();

  constructor(operations: readonly ResolvedOperation[], signal?: AbortSignal) {
    this.operations = operations;
    this.instructions = operations.map(instructionForOperation);
    this.signal = signal;
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
        instruction.status = this.mutations.length > mutationCount ? "planned" : "no-op";
      } catch (error) {
        if (operation.kind === "update") {
          if (
            !updateHasSemanticMove(operation) &&
            (await this.isDeadUpdate(index, operation.absolutePath))
          ) {
            instruction.status = "dead";
            continue;
          }
          if (
            updateHasSemanticMove(operation) &&
            (await this.isDeadMove(index, operation.absolutePath, operation.moveAbsolutePath!))
          ) {
            instruction.status = "dead";
            continue;
          }
        }
        for (const planned of this.instructions) {
          if (planned.status === "planned") planned.status = "not-run";
        }
        instruction.status = "failed";
        instruction.error = errorMessage(error);
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

  private async directoryIsCaseInsensitive(directory: string): Promise<boolean> {
    let cached = this.caseInsensitiveDirectories.get(directory);
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
      this.caseInsensitiveDirectories.set(directory, cached);
    }
    return cached;
  }

  private async namesAlias(directory: string, left: string, right: string): Promise<boolean> {
    const normalizedLeft = process.platform === "darwin" ? left.normalize("NFD") : left;
    const normalizedRight = process.platform === "darwin" ? right.normalize("NFD") : right;
    if (normalizedLeft === normalizedRight) return true;
    return (
      (await this.directoryIsCaseInsensitive(directory)) &&
      normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    );
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
        let content = this.physicalContent.get(physicalKey);
        if (!content) {
          content = { planned: false };
          this.physicalContent.set(physicalKey, content);
        }
        result = {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: path,
          sourcePath: path,
          fingerprint: entryFingerprint,
          content,
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
    const entryName = basename(entryPath);
    const requestedName = basename(requestedPath);
    return (
      entryName === requestedName ||
      (process.platform === "darwin" &&
        entryName.normalize("NFD") === requestedName.normalize("NFD"))
    );
  }

  private snapshot(entry: VirtualEntry): VirtualEntry {
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
        if (visitedSymlinks.has(key)) throw new Error("symbolic link cycle");
        visitedSymlinks.add(key);
        const target = await this.stateAt(entry.targetPath);
        if (target.kind !== "regular" && target.kind !== "symlink") {
          throw new Error(
            target.kind === "absent"
              ? "symbolic link target does not exist"
              : target.kind === "directory"
                ? "symbolic link target is a directory"
                : `symbolic link target is a ${target.entryType}`,
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

  private operationRelatedPaths(operation: ResolvedOperation): string[] {
    if (operation.kind !== "update" || !operation.moveAbsolutePath) {
      return [operation.absolutePath];
    }
    return [operation.absolutePath, operation.moveAbsolutePath];
  }

  private async isDeadUpdate(index: number, targetPath: string): Promise<boolean> {
    const targetKey = await this.pathKey(targetPath);
    for (const operation of this.operations.slice(index + 1)) {
      if (
        (operation.kind === "add" || operation.kind === "delete") &&
        (await this.pathKey(operation.absolutePath)) === targetKey
      ) {
        return true;
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
        return false;
      }
    }
    return false;
  }

  private async isDeadMove(
    index: number,
    sourcePath: string,
    destinationPath: string,
  ): Promise<boolean> {
    const source = await this.stateAt(sourcePath);
    if (source.kind !== "absent" && source.kind !== "regular" && source.kind !== "symlink") {
      return false;
    }
    const sourceKey = await this.pathKey(sourcePath);
    const destinationKey = await this.pathKey(destinationPath);
    let sourceDominated = source.kind === "absent";
    let destinationDominated = false;
    let destinationParentsReproduced = false;
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
        return false;
      }
    }

    for (const operation of this.operations.slice(index + 1)) {
      const operationPaths = this.operationRelatedPaths(operation);
      const operationKeys = await Promise.all(operationPaths.map((path) => this.pathKey(path)));
      const targetKey = operationKeys[0]!;
      if (operation.kind === "add" || operation.kind === "delete") {
        if (
          targetKey === sourceKey &&
          (operation.kind === "delete" || (await addDominates(source, operation, defaultFileMode)))
        ) {
          sourceDominated = true;
        }
        if (targetKey === destinationKey) {
          if (
            operation.kind === "delete" ||
            (await addDominates(destination, operation, materializedMode))
          ) {
            destinationDominated = true;
          }
          if (operation.kind === "add") destinationParentsReproduced = true;
        }
        if (sourceDominated && destinationDominated && destinationParentsReproduced) return true;
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
        return false;
      }
    }
    return sourceDominated && destinationDominated && destinationParentsReproduced;
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
    await this.setState(operation.absolutePath, {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: operation.absolutePath,
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
    if (target.kind === "absent") return;
    if (target.kind === "directory" || target.kind === "unsupported") {
      throw new Error(
        `Cannot delete ${operation.absolutePath}: path is ${target.kind === "directory" ? "a directory" : `a ${target.entryType}`}`,
      );
    }

    const content =
      target.content.value?.text ??
      (this.hasLaterTextEdit(index, operation.absolutePath)
        ? await this.optionalText(target, operation.absolutePath)
        : undefined);
    const expectedTarget = this.snapshot(target);
    const change: Extract<AppliedPatchChange, { kind: "delete" }> = {
      kind: "delete",
      path: operation.path,
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
      if (updateHasSemanticMove(operation)) {
        await this.planPureMove(operation, instructionIndex);
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
    if (!semanticMove && buffersEqual(source.content.value!.bytes, content)) return;

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
      const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
        kind: "regular",
        id: this.newEntryId(),
        entryPath: destinationPath,
        content: {
          value: { bytes: content, text: newContent },
          planned: true,
        },
      };
      await this.setState(destinationPath, resultingEntry);
      this.fulfilledMoves.set(sourceKey, {
        destinationKey,
        destinationEntryId: resultingEntry.id,
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
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: destinationPath,
      content: {
        value: { bytes: content, text: newContent },
        planned: true,
      },
    };
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: resultingEntry.id,
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
      if (operation.absolutePath === destinationPath) return;
      const source = await this.stateAt(operation.absolutePath);
      if (
        (source.kind === "regular" || source.kind === "symlink") &&
        this.virtualSpellingSatisfied(source.entryPath, destinationPath)
      ) {
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
          entryType: expectedSource.kind === "regular" ? "regular-file" : "symbolic-link",
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
        return;
      }
      throw new Error(
        `Failed to move ${operation.absolutePath}: source path does not exist and destination provenance is unproven`,
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
      entryType: expectedSource.kind === "regular" ? "regular-file" : "symbolic-link",
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
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    await this.setState(destinationPath, { ...source, entryPath: destinationPath });
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: source.id,
    });
  }
}

class RegularFileReplacementError extends Error {
  readonly installed: boolean;

  constructor(message: string, installed: boolean) {
    super(message);
    this.installed = installed;
  }
}

async function replaceRegularFile(path: string, content: Buffer, mode?: number): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.apply-patch-${randomUUID()}.tmp`,
  );
  let installed = false;
  let pendingError: unknown;
  try {
    await writeFile(temporaryPath, content);
    if (mode !== undefined) await chmod(temporaryPath, mode & 0o7777);
    await rename(temporaryPath, path);
    installed = true;
    await establishExactSpelling(path);
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error) && pendingError === undefined) pendingError = error;
    }
  }
  if (pendingError !== undefined) {
    throw new RegularFileReplacementError(errorMessage(pendingError), installed);
  }
}

function namesPotentiallyAlias(left: string, right: string): boolean {
  const normalizedLeft = process.platform === "darwin" ? left.normalize("NFD") : left;
  const normalizedRight = process.platform === "darwin" ? right.normalize("NFD") : right;
  return normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase();
}

async function establishExactSpelling(path: string): Promise<void> {
  if (await requestedSpellingExists(path)) return;
  const directory = dirname(path);
  const requestedName = basename(path);
  const requestedMetadata = await lstat(path);
  let actualPath: string | undefined;
  for (const name of await readdir(directory)) {
    if (!namesPotentiallyAlias(name, requestedName)) continue;
    const metadata = await lstat(join(directory, name));
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
  await rename(actualPath, temporaryPath);
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await rename(temporaryPath, actualPath);
    } catch {
      // Preserve the original error; the executor reports that the mutation is inexact.
    }
    throw error;
  }
}

function appendChange(details: ApplyPatchDetails, change: AppliedPatchChange): void {
  details.changes.push(change);
  if (change.kind === "add") details.added.push(change.path);
  else if (change.kind === "delete") details.deleted.push(change.path);
  else if (change.kind === "move") details.modified.push(change.destinationPath);
  else details.modified.push(change.moveTo ?? change.path);
}

function detailsForPlan(plan: SemanticPlan): ApplyPatchDetails {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  for (const mutation of plan.mutations) appendChange(details, mutation.change);
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

async function createPlannedParents(parents: ParentPlan): Promise<void> {
  const deepest = parents.createdPaths.at(-1);
  if (deepest) await mkdir(deepest, { recursive: true });
}

async function exactSpellingExists(path: string): Promise<boolean> {
  try {
    return (await readdir(dirname(path))).includes(basename(path));
  } catch {
    return false;
  }
}

async function requestedSpellingExists(path: string): Promise<boolean> {
  const requestedName = basename(path);
  try {
    return (await readdir(dirname(path))).some((name) => {
      return (
        name === requestedName ||
        (process.platform === "darwin" && name.normalize("NFD") === requestedName.normalize("NFD"))
      );
    });
  } catch {
    return false;
  }
}

async function finishSameInodeRename(sourcePath: string, destinationPath: string): Promise<void> {
  let sourceMetadata: Stats;
  let destinationMetadata: Stats;
  try {
    [sourceMetadata, destinationMetadata] = await Promise.all([
      lstat(sourcePath),
      lstat(destinationPath),
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
    exactSpellingExists(sourcePath),
    exactSpellingExists(destinationPath),
  ]);
  const normalizationOnlyRename =
    process.platform === "darwin" &&
    basename(sourcePath).normalize("NFD") === basename(destinationPath).normalize("NFD");
  if (normalizationOnlyRename) return;
  if (!destinationNameExists) {
    throw new Error(`rename did not install destination ${destinationPath}`);
  }
  if (sourceNameExists) await unlink(sourcePath);
}

class PureMoveExecutionError extends Error {
  readonly destinationState: "unchanged" | "removed" | "installed";

  constructor(message: string, destinationState: "unchanged" | "removed" | "installed") {
    super(message);
    this.destinationState = destinationState;
  }
}

async function installCrossDeviceMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath!;
  const temporaryPath = resolve(
    dirname(destinationPath),
    `.${basename(destinationPath)}.apply-patch-${randomUUID()}.tmp`,
  );
  let destinationInstalled = false;
  let destinationRemoved = false;
  let pendingError: unknown;
  try {
    if (mutation.expectedSource.kind === "regular") {
      await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      if (mutation.expectedSource.fingerprint) {
        await chmod(temporaryPath, mutation.expectedSource.fingerprint.mode);
        const metadata = await lstat(sourcePath);
        await utimes(temporaryPath, metadata.atime, metadata.mtime);
      }
    } else {
      await symlink(await readlink(sourcePath), temporaryPath);
    }

    try {
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      if (
        mutation.expectedDestination.kind === "absent" ||
        (!hasErrorCode(error, "EEXIST") &&
          !hasErrorCode(error, "ENOTEMPTY") &&
          !hasErrorCode(error, "EPERM"))
      ) {
        throw error;
      }
      await unlink(destinationPath);
      destinationRemoved = true;
      await rename(temporaryPath, destinationPath);
    }
    destinationInstalled = true;
    await unlink(sourcePath);
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error) && pendingError === undefined) pendingError = error;
    }
  }
  if (pendingError !== undefined) {
    const message =
      destinationRemoved && !destinationInstalled
        ? `${errorMessage(pendingError)}; destination was removed before replacement failed`
        : errorMessage(pendingError);
    throw new PureMoveExecutionError(
      message,
      destinationInstalled ? "installed" : destinationRemoved ? "removed" : "unchanged",
    );
  }
}

async function executePureMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath!;
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (!hasErrorCode(error, "EXDEV")) throw error;
    await installCrossDeviceMove(mutation);
    return;
  }
  try {
    await finishSameInodeRename(sourcePath, destinationPath);
  } catch (error) {
    let destinationInstalled = false;
    try {
      await lstat(destinationPath);
      destinationInstalled = true;
    } catch {}
    throw new PureMoveExecutionError(
      errorMessage(error),
      destinationInstalled ? "installed" : "unchanged",
    );
  }
}

async function executePlan(
  plan: SemanticPlan,
  signal: AbortSignal | undefined,
  onProgress?: (details: ApplyPatchDetails) => void,
): Promise<ApplyPatchDetails> {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  let activeInstruction: ApplyPatchInstructionDetails | undefined;
  const committedEntryMutations: CommittedEntryMutation[] = [];
  try {
    for (const mutation of plan.mutations) {
      activeInstruction = details.instructions[mutation.instructionIndex];
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
          await createPlannedParents(mutation.parents);
          await replaceRegularFile(
            mutation.operation.absolutePath,
            mutation.content,
            mutation.replacementMode,
          );
        } catch (error) {
          details.exact = false;
          if (error instanceof RegularFileReplacementError && error.installed) {
            appendChange(details, mutation.change);
          }
          throw new Error(
            `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change);
      } else if (mutation.kind === "delete") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.targetKey,
          mutation.expectedTarget,
          committedEntryMutations,
        );
        try {
          await unlink(mutation.operation.absolutePath);
        } catch (error) {
          throw new Error(
            `Failed to delete file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change);
      } else if (mutation.kind === "text-update") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.sourceKey,
          mutation.expectedSource,
          committedEntryMutations,
        );
        if (mutation.sameEntryMove) {
          try {
            await replaceRegularFile(
              mutation.operation.absolutePath,
              mutation.content,
              mutation.replacementMode,
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError && error.installed) {
              appendChange(details, mutation.provisionalChange!);
            }
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.provisionalChange!);
          if (mutation.sameEntryMove === "rename") {
            try {
              await rename(mutation.operation.absolutePath, mutation.operation.moveAbsolutePath!);
              await finishSameInodeRename(
                mutation.operation.absolutePath,
                mutation.operation.moveAbsolutePath!,
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
            await createPlannedParents(mutation.parents);
            await replaceRegularFile(
              mutation.operation.moveAbsolutePath,
              mutation.content,
              mutation.replacementMode,
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError && error.installed) {
              appendChange(details, mutation.provisionalChange!);
            }
            throw new Error(
              `Failed to write file ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.provisionalChange!);
          try {
            await unlink(mutation.operation.absolutePath);
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
            await writeFile(mutation.operation.absolutePath, mutation.content);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            );
          }
          appendChange(details, mutation.change);
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
          await createPlannedParents(mutation.parents);
          await executePureMove(mutation);
        } catch (error) {
          if (mutation.parents.createdPaths.length > 0) details.exact = false;
          if (error instanceof PureMoveExecutionError && error.destinationState === "installed") {
            const inexactMove = { ...mutation.change, exact: false };
            appendChange(details, inexactMove);
            details.exact = false;
          }
          if (error instanceof PureMoveExecutionError && error.destinationState === "removed") {
            details.exact = false;
          }
          throw new Error(
            `Failed to move ${mutation.operation.absolutePath} to ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
          );
        }
        appendChange(details, mutation.change);
      }
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
      throwIfAborted(signal);
      onProgress?.(cloneApplyPatchDetails(details));
    }
    return details;
  } catch (error) {
    const message = errorMessage(error);
    if (activeInstruction) {
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
): Promise<SemanticPlan> {
  try {
    return await new SemanticPlanner(operations, signal).plan();
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
    const queuePaths = await canonicalMutationQueuePaths(
      operations.flatMap((operation) => [
        operation.absolutePath,
        ...(operation.kind === "update" && operation.moveAbsolutePath
          ? [operation.moveAbsolutePath]
          : []),
      ]),
    );

    return await withMutationQueues(queuePaths, async () => {
      throwIfAborted(signal);
      const plan = await buildPlan(operations, signal);
      throwIfAborted(signal);
      hooks.onExecutionStart?.();
      return executePlan(plan, signal, hooks.onProgress);
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

export function formatApplyPatchSummary(details: ApplyPatchDetails): string {
  if (details.added.length === 0 && details.modified.length === 0 && details.deleted.length === 0) {
    return "Success. No files were changed.\n";
  }
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
