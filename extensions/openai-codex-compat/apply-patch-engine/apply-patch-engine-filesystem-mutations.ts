import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import {
  commitEvidenceForExistingEntry,
  currentExecutionEntry,
  entryMatchesCommitEvidence,
} from "./apply-patch-engine-commit-evidence.ts";
import { errorMessage, hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import {
  fingerprint,
  type EntryCommitEvidence,
  type ExistingFileEntry,
  type ParentPlan,
  type PathCommitEvidence,
  type PlannedMutation,
} from "./apply-patch-engine-filesystem-model.ts";

export const DEFAULT_EXECUTION_FILESYSTEM: ApplyPatchExecutionFilesystem = {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
};

export class RegularFileReplacementError extends Error {
  readonly destinationChanged: boolean;
  readonly temporaryPath: string | undefined;

  constructor(
    message: string,
    destinationChanged: boolean,
    temporaryPath?: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.destinationChanged = destinationChanged;
    this.temporaryPath = temporaryPath;
  }
}

async function validatedMoveSourceEvidence(
  path: string,
  expected: ExistingFileEntry,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<{
  continuity: Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }>;
  destination: Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }>;
}> {
  const actual = await currentExecutionEntry(path, filesystem);
  const expectedEvidence = commitEvidenceForExistingEntry(expected, "exact");
  if (!(await entryMatchesCommitEvidence(path, actual, expectedEvidence, filesystem))) {
    throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
  }
  if (
    (actual.kind !== "regular" && actual.kind !== "symlink") ||
    actual.fingerprint === undefined
  ) {
    throw new Error(`Could not capture move source identity at ${path}`);
  }
  if (actual.kind === "symlink") {
    const continuity: Extract<EntryCommitEvidence, { kind: "symlink" }> = {
      kind: "symlink",
      fingerprint: actual.fingerprint,
      fingerprintMatch: "exact",
      exactSpelling: true,
      target: actual.target,
    };
    if (expectedEvidence.kind === "symlink" && expectedEvidence.content) {
      continuity.content = expectedEvidence.content;
    }
    return {
      continuity,
      destination: {
        kind: "symlink",
        fingerprint: continuity.fingerprint,
        fingerprintMatch: "except-link-count",
        exactSpelling: true,
        target: continuity.target,
      },
    };
  }
  const continuity: Extract<EntryCommitEvidence, { kind: "regular" }> = {
    kind: "regular",
    fingerprint: actual.fingerprint,
    fingerprintMatch: "exact",
    exactSpelling: true,
  };
  if (expectedEvidence.kind === "regular" && expectedEvidence.content) {
    continuity.content = expectedEvidence.content;
  }
  return {
    continuity,
    destination: { ...continuity, fingerprintMatch: "except-link-count" },
  };
}

async function assertMoveSourceContinuity(
  path: string,
  evidence: Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }>,
  filesystem: ApplyPatchExecutionFilesystem,
  allowLinkCountChange = false,
): Promise<void> {
  const expected = allowLinkCountChange
    ? { ...evidence, fingerprintMatch: "except-link-count" as const }
    : evidence;
  const actual = await currentExecutionEntry(path, filesystem);
  if (!(await entryMatchesCommitEvidence(path, actual, expected, filesystem))) {
    throw new Error(`Filesystem changed while apply_patch moved ${path}`);
  }
}

export async function replaceRegularFile(
  path: string,
  content: Buffer,
  filesystem: ApplyPatchExecutionFilesystem,
  mode?: number,
): Promise<Extract<EntryCommitEvidence, { kind: "regular" }>> {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.apply-patch-${randomUUID()}.tmp`,
  );
  let destinationChanged = false;
  let temporaryEntryRemains = false;
  let pendingError: unknown;
  let commitEvidence: Extract<EntryCommitEvidence, { kind: "regular" }> | undefined;
  try {
    await filesystem.writeFile(temporaryPath, content);
    if (mode !== undefined) await filesystem.chmod(temporaryPath, mode & 0o7777);
    const temporaryMetadata = await filesystem.lstat(temporaryPath);
    if (!temporaryMetadata.isFile()) {
      throw new Error(`temporary replacement entry is not a regular file at ${temporaryPath}`);
    }
    commitEvidence = {
      kind: "regular",
      fingerprint: fingerprint(temporaryMetadata),
      fingerprintMatch: "exact",
      exactSpelling: true,
      content,
    };
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
      pendingError,
    );
  }
  if (!commitEvidence) {
    throw new RegularFileReplacementError(
      `Replacement commit evidence was not captured for ${path}`,
      destinationChanged,
    );
  }
  return commitEvidence;
}

export function namesPotentiallyAlias(left: string, right: string): boolean {
  const normalizedLeft = process.platform === "darwin" ? left.normalize("NFD") : left;
  const normalizedRight = process.platform === "darwin" ? right.normalize("NFD") : right;
  return normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase();
}

export async function establishExactSpelling(
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
    } catch (restoreError) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains both rename failures, and cause identifies the original failure.
      throw new AggregateError([error, restoreError], errorMessage(error), { cause: error });
    }
    throw error;
  }
}

export async function createPlannedParents(
  parents: ParentPlan,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<PathCommitEvidence[]> {
  const deepest = parents.createdPaths.at(-1);
  if (deepest) await filesystem.mkdir(deepest, { recursive: true });
  const evidence: PathCommitEvidence[] = [];
  for (const path of parents.createdPaths) {
    const metadata = await filesystem.lstat(path);
    if (!metadata.isDirectory()) {
      throw new Error(`Planned parent is not a directory after creation at ${path}`);
    }
    evidence.push({
      path,
      evidence: {
        kind: "directory",
        fingerprint: fingerprint(metadata),
        fingerprintMatch: "physical",
        exactSpelling: true,
      },
    });
  }
  return evidence;
}

export async function exactSpellingExists(
  path: string,
  filesystem: Pick<ApplyPatchExecutionFilesystem, "readdir"> = DEFAULT_EXECUTION_FILESYSTEM,
): Promise<boolean> {
  try {
    return (await filesystem.readdir(dirname(path))).includes(basename(path));
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw new Error(`Failed to inspect the spelling of ${path}`, { cause });
  }
}

export async function finishSameInodeRename(
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

export class PureMoveExecutionError extends Error {
  readonly destinationState: "unchanged" | "removed" | "created" | "replaced";
  readonly temporaryPath: string | undefined;

  constructor(
    message: string,
    destinationState: "unchanged" | "removed" | "created" | "replaced",
    temporaryPath?: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.destinationState = destinationState;
    this.temporaryPath = temporaryPath;
  }
}

export async function executeCrossDeviceMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  expectedSource: ExistingFileEntry,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<PathCommitEvidence[]> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath;
  const temporaryPath = resolve(
    dirname(destinationPath),
    `.${basename(destinationPath)}.apply-patch-${randomUUID()}.tmp`,
  );
  let destinationChanged = false;
  let destinationRemoved = false;
  let temporaryEntryRemains = false;
  let pendingError: unknown;
  let sourceEvidence: Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }> | undefined;
  let destinationEvidence:
    | Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }>
    | undefined;
  try {
    const validatedSource = await validatedMoveSourceEvidence(
      sourcePath,
      expectedSource,
      filesystem,
    );
    sourceEvidence = validatedSource.continuity;
    if (sourceEvidence.kind === "regular") {
      await filesystem.copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      await assertMoveSourceContinuity(sourcePath, sourceEvidence, filesystem);
      await filesystem.chmod(temporaryPath, sourceEvidence.fingerprint.mode);
      const metadata = await filesystem.lstat(sourcePath);
      await assertMoveSourceContinuity(sourcePath, sourceEvidence, filesystem);
      await filesystem.utimes(temporaryPath, metadata.atime, metadata.mtime);
      const temporaryMetadata = await filesystem.lstat(temporaryPath);
      if (!temporaryMetadata.isFile()) {
        throw new Error(`temporary move entry is not a regular file at ${temporaryPath}`);
      }
      destinationEvidence = {
        ...sourceEvidence,
        fingerprint: fingerprint(temporaryMetadata),
        fingerprintMatch: "exact",
      };
    } else {
      await filesystem.symlink(sourceEvidence.target, temporaryPath);
      await assertMoveSourceContinuity(sourcePath, sourceEvidence, filesystem);
      const temporaryMetadata = await filesystem.lstat(temporaryPath);
      if (!temporaryMetadata.isSymbolicLink()) {
        throw new Error(`temporary move entry is not a symlink at ${temporaryPath}`);
      }
      destinationEvidence = {
        kind: "symlink",
        fingerprint: fingerprint(temporaryMetadata),
        fingerprintMatch: "exact",
        exactSpelling: true,
        target: sourceEvidence.target,
      };
    }
    await assertMoveSourceContinuity(sourcePath, sourceEvidence, filesystem);

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
    await assertMoveSourceContinuity(sourcePath, sourceEvidence, filesystem, true);
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
      pendingError,
    );
  }
  if (!destinationEvidence) {
    throw new PureMoveExecutionError(
      `Move commit evidence was not captured for ${destinationPath}`,
      destinationChanged
        ? mutation.expectedDestination.kind === "absent"
          ? "created"
          : "replaced"
        : "unchanged",
    );
  }
  return [
    { path: sourcePath, evidence: { kind: "absent" } },
    { path: destinationPath, evidence: destinationEvidence },
  ];
}

export async function executePureMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  expectedSource: ExistingFileEntry,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<PathCommitEvidence[]> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath;
  if (mutation.moveStrategy === "copy-unlink") {
    return executeCrossDeviceMove(mutation, expectedSource, filesystem);
  }
  const sourceEvidence = await validatedMoveSourceEvidence(sourcePath, expectedSource, filesystem);
  try {
    await filesystem.rename(sourcePath, destinationPath);
  } catch (error) {
    if (hasErrorCode(error, "EXDEV")) {
      throw new Error("rename unexpectedly crossed filesystem boundaries after validation", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await finishSameInodeRename(sourcePath, destinationPath, filesystem);
  } catch (error) {
    let destinationChanged = false;
    let destinationInspectionError: unknown;
    try {
      await filesystem.lstat(destinationPath);
      destinationChanged = true;
    } catch (inspectionError) {
      if (!isNotFound(inspectionError)) destinationInspectionError = inspectionError;
    }
    const inspectionFailure =
      destinationInspectionError === undefined
        ? ""
        : `; could not inspect destination state: ${errorMessage(destinationInspectionError)}`;
    throw new PureMoveExecutionError(
      `${errorMessage(error)}${inspectionFailure}`,
      destinationChanged
        ? mutation.expectedDestination.kind === "absent"
          ? "created"
          : "replaced"
        : "unchanged",
      undefined,
      error,
    );
  }
  return [
    { path: sourcePath, evidence: { kind: "absent" } },
    { path: destinationPath, evidence: sourceEvidence.destination },
  ];
}
