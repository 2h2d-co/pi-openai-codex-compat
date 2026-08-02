import { stat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const APPLY_PATCH_INPUT_PROPERTY = "patch";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

// Adapted from OpenAI Codex's Apache-2.0 apply_patch grammar; see
// THIRD_PARTY_NOTICES.md. Pi serializes it as a native custom grammar tool for
// capable models and falls back to an ordinary function tool elsewhere.
export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
};

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export type ApplyPatchDetails = {
  added: string[];
  updated: string[];
  deleted: string[];
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

type PlannedChange =
  | { kind: "add"; path: string; absolutePath: string; content: string }
  | { kind: "delete"; path: string; absolutePath: string }
  | { kind: "update"; path: string; absolutePath: string; content: string }
  | {
      kind: "move";
      path: string;
      absolutePath: string;
      destination: string;
      destinationAbsolutePath: string;
      content: string;
    };

function patchError(message: string, line?: number): Error {
  return new Error(
    line === undefined ? `Invalid patch: ${message}` : `Invalid patch at line ${line}: ${message}`,
  );
}

function markerPath(line: string, marker: string, lineNumber: number): string {
  const path = line.slice(marker.length).trim();
  if (!path) throw patchError(`${marker.trim()} requires a path`, lineNumber);
  return path;
}

function startsFileHunk(line: string): boolean {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function parseUpdateChunks(
  lines: readonly string[],
  firstLine: number,
  path: string,
): UpdateChunk[] {
  const chunks: UpdateChunk[] = [];
  let current: UpdateChunk | undefined;

  const ensureChunk = (): UpdateChunk => {
    current ??= { oldLines: [], newLines: [], endOfFile: false };
    return current;
  };
  const finishChunk = () => {
    if (!current) return;
    if (current.oldLines.length === 0 && current.newLines.length === 0) {
      throw patchError(`empty update chunk for ${path}`, firstLine);
    }
    chunks.push(current);
    current = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lineNumber = firstLine + index;
    if (line === "@@" || line.startsWith("@@ ")) {
      finishChunk();
      const context = line === "@@" ? undefined : line.slice(3);
      current = {
        ...(context ? { context } : {}),
        oldLines: [],
        newLines: [],
        endOfFile: false,
      };
      continue;
    }
    if (line === END_OF_FILE) {
      const chunk = ensureChunk();
      chunk.endOfFile = true;
      if (lines.slice(index + 1).some((remaining) => remaining !== "")) {
        throw patchError(`${END_OF_FILE} must end an update hunk`, lineNumber);
      }
      break;
    }
    if (line === "" && current?.endOfFile) continue;

    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") {
      throw patchError(`invalid update line for ${path}`, lineNumber);
    }
    const text = line.slice(1);
    const chunk = ensureChunk();
    if (prefix !== "+") chunk.oldLines.push(text);
    if (prefix !== "-") chunk.newLines.push(text);
  }

  finishChunk();
  if (chunks.length === 0) throw patchError(`update hunk for ${path} is empty`, firstLine);
  return chunks;
}

export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replaceAll("\r\n", "\n").trim().split("\n");
  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw patchError(`the first line must be '${BEGIN_PATCH}'`);
  }
  if (lines.at(-1)?.trim() !== END_PATCH) {
    throw patchError(`the last line must be '${END_PATCH}'`);
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (line.startsWith(ADD_FILE)) {
      const path = markerPath(line, ADD_FILE, lineNumber);
      index += 1;
      const content: string[] = [];
      while (index < lines.length - 1 && !startsFileHunk(lines[index]!)) {
        const contentLine = lines[index]!;
        if (!contentLine.startsWith("+")) {
          throw patchError(`add lines for ${path} must start with '+'`, index + 1);
        }
        content.push(contentLine.slice(1));
        index += 1;
      }
      if (content.length === 0) throw patchError(`add hunk for ${path} is empty`, lineNumber);
      operations.push({ kind: "add", path, content: `${content.join("\n")}\n` });
      continue;
    }
    if (line.startsWith(DELETE_FILE)) {
      operations.push({ kind: "delete", path: markerPath(line, DELETE_FILE, lineNumber) });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_FILE)) {
      const path = markerPath(line, UPDATE_FILE, lineNumber);
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith(MOVE_TO)) {
        moveTo = markerPath(lines[index]!, MOVE_TO, index + 1);
        index += 1;
      }
      const changeStart = index;
      while (index < lines.length - 1 && !startsFileHunk(lines[index]!)) index += 1;
      const chunks = parseUpdateChunks(lines.slice(changeStart, index), changeStart + 1, path);
      operations.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), chunks });
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    throw patchError("expected an add, delete, or update hunk", lineNumber);
  }

  if (operations.length === 0) throw patchError("no files were modified");
  return operations;
}

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
): boolean {
  const candidate = lines.slice(index, index + pattern.length);
  if (candidate.length !== pattern.length) return false;
  if (candidate.every((line, offset) => line === pattern[offset])) return true;
  if (candidate.every((line, offset) => line.trimEnd() === pattern[offset]!.trimEnd())) return true;
  return candidate.every((line, offset) => line.trim() === pattern[offset]!.trim());
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
  if (endOfFile && sequenceMatches(lines, pattern, last)) return last;
  for (let index = start; index <= last; index++) {
    if (sequenceMatches(lines, pattern, index)) return index;
  }
  return undefined;
}

function applyUpdate(content: string, chunks: readonly UpdateChunk[], path: string): string {
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
      replacements.push({ index: lines.length, oldLength: 0, newLines: chunk.newLines });
      continue;
    }

    const found = findSequence(lines, chunk.oldLines, cursor, chunk.endOfFile);
    if (found === undefined) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push({ index: found, oldLength: chunk.oldLines.length, newLines: chunk.newLines });
    cursor = found + chunk.oldLines.length;
  }

  replacements.sort((left, right) => right.index - left.index);
  for (const replacement of replacements) {
    lines.splice(replacement.index, replacement.oldLength, ...replacement.newLines);
  }
  return `${lines.join("\n")}\n`;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

async function canonicalMutationPath(path: string): Promise<string> {
  let candidate = path;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function resolvePatchPath(cwd: string, patchPath: string): Promise<string> {
  if (patchPath.includes("\0")) throw new Error("Patch paths cannot contain NUL bytes.");
  const root = await realpath(cwd);
  const absolutePath = isAbsolute(patchPath) ? resolve(patchPath) : resolve(root, patchPath);
  if (!isWithin(root, absolutePath)) {
    throw new Error(`Patch path escapes the working directory: ${patchPath}`);
  }
  const relativePath = relative(root, absolutePath);
  if (relativePath.split(sep).includes(".git")) {
    throw new Error(`apply_patch cannot modify Git metadata: ${patchPath}`);
  }

  const canonicalPath = await canonicalMutationPath(absolutePath);
  if (!isWithin(root, canonicalPath)) {
    throw new Error(`Patch path resolves outside the working directory: ${patchPath}`);
  }
  if (relative(root, canonicalPath).split(sep).includes(".git")) {
    throw new Error(`apply_patch cannot modify Git metadata: ${patchPath}`);
  }
  return absolutePath;
}

async function assertRegularFile(path: string, action: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Cannot ${action} non-file path: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function resolveOperations(
  cwd: string,
  operations: readonly PatchOperation[],
): Promise<ResolvedOperation[]> {
  const resolvedOperations: ResolvedOperation[] = [];
  const usedPaths = new Set<string>();

  for (const operation of operations) {
    const absolutePath = await resolvePatchPath(cwd, operation.path);
    const paths = [absolutePath];
    let moveAbsolutePath: string | undefined;
    if (operation.kind === "update" && operation.moveTo) {
      moveAbsolutePath = await resolvePatchPath(cwd, operation.moveTo);
      paths.push(moveAbsolutePath);
    }
    for (const path of paths) {
      if (usedPaths.has(path))
        throw new Error(`A patch cannot modify the same path twice: ${path}`);
      usedPaths.add(path);
    }

    if (operation.kind === "add") {
      resolvedOperations.push({ ...operation, absolutePath });
    } else if (operation.kind === "delete") {
      resolvedOperations.push({ ...operation, absolutePath });
    } else {
      resolvedOperations.push({
        ...operation,
        absolutePath,
        ...(moveAbsolutePath ? { moveAbsolutePath } : {}),
      });
    }
  }
  return resolvedOperations;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("apply_patch was cancelled.");
}

async function planChanges(operations: readonly ResolvedOperation[]): Promise<PlannedChange[]> {
  const changes: PlannedChange[] = [];
  for (const operation of operations) {
    if (operation.kind === "add") {
      if (await pathExists(operation.absolutePath)) {
        throw new Error(`Cannot add a file that already exists: ${operation.path}`);
      }
      changes.push(operation);
      continue;
    }

    await assertRegularFile(operation.absolutePath, operation.kind);
    if (operation.kind === "delete") {
      changes.push(operation);
      continue;
    }

    const current = await readFile(operation.absolutePath, "utf8");
    const content = applyUpdate(current, operation.chunks, operation.path);
    if (operation.moveAbsolutePath && operation.moveTo) {
      if (await pathExists(operation.moveAbsolutePath)) {
        throw new Error(`Cannot move to a path that already exists: ${operation.moveTo}`);
      }
      changes.push({
        kind: "move",
        path: operation.path,
        absolutePath: operation.absolutePath,
        destination: operation.moveTo,
        destinationAbsolutePath: operation.moveAbsolutePath,
        content,
      });
    } else {
      changes.push({
        kind: "update",
        path: operation.path,
        absolutePath: operation.absolutePath,
        content,
      });
    }
  }
  return changes;
}

async function commitChanges(
  changes: readonly PlannedChange[],
  signal: AbortSignal | undefined,
): Promise<ApplyPatchDetails> {
  const details: ApplyPatchDetails = { added: [], updated: [], deleted: [] };
  for (const change of changes) {
    throwIfAborted(signal);
    if (change.kind === "add") {
      await mkdir(dirname(change.absolutePath), { recursive: true });
      await writeFile(change.absolutePath, change.content, { encoding: "utf8", flag: "wx" });
      details.added.push(change.path);
    } else if (change.kind === "delete") {
      await unlink(change.absolutePath);
      details.deleted.push(change.path);
    } else if (change.kind === "update") {
      await writeFile(change.absolutePath, change.content, "utf8");
      details.updated.push(change.path);
    } else {
      await mkdir(dirname(change.destinationAbsolutePath), { recursive: true });
      await writeFile(change.destinationAbsolutePath, change.content, {
        encoding: "utf8",
        flag: "wx",
      });
      await unlink(change.absolutePath);
      details.updated.push(`${change.path} -> ${change.destination}`);
    }
  }
  return details;
}

export async function applyPatch(
  cwd: string,
  patch: string,
  signal?: AbortSignal,
): Promise<ApplyPatchDetails> {
  throwIfAborted(signal);
  const operations = await resolveOperations(cwd, parsePatch(patch));
  const operationPaths = operations.flatMap((operation) => [
    operation.absolutePath,
    ...(operation.kind === "update" && operation.moveAbsolutePath
      ? [operation.moveAbsolutePath]
      : []),
  ]);
  const canonicalPaths = await Promise.all(operationPaths.map(canonicalMutationPath));
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    throw new Error("A patch cannot modify the same file through multiple path aliases.");
  }
  const queuePaths = [...canonicalPaths].sort();

  return withMutationQueues(queuePaths, async () => {
    throwIfAborted(signal);
    const changes = await planChanges(operations);
    throwIfAborted(signal);
    return commitChanges(changes, signal);
  });
}

function formatResult(details: ApplyPatchDetails): string {
  const lines = ["Done!"];
  for (const path of details.added) lines.push(`Added ${path}`);
  for (const path of details.updated) lines.push(`Updated ${path}`);
  for (const path of details.deleted) lines.push(`Deleted ${path}`);
  return lines.join("\n");
}

export default function registerApplyPatch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: APPLY_PATCH_TOOL_NAME,
    label: "Apply Patch",
    description:
      "Edit workspace files with the Codex apply_patch format. Paths must remain inside the working directory.",
    promptSnippet: "Apply a Codex-format patch to one or more workspace files",
    promptGuidelines: [
      "Use apply_patch for local file edits; formatting commands and bulk mechanical rewrites may use the shell.",
    ],
    parameters: Type.Object({
      patch: Type.String({ description: "Patch text beginning with *** Begin Patch" }),
    }),
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await applyPatch(ctx.cwd, params.patch, signal);
      return {
        content: [{ type: "text", text: formatResult(details) }],
        details,
      };
    },
  });
}
