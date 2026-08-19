import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { errorMessage, hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import type { ParentPlan, PlannedMutation } from "./apply-patch-engine-filesystem-model.ts";

export const DEFAULT_EXECUTION_FILESYSTEM: ApplyPatchExecutionFilesystem = {
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

export async function replaceRegularFile(
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
    // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- The failure is captured and thrown after the temporary-file cleanup attempt.
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await filesystem.unlink(temporaryPath);
      // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Non-ENOENT cleanup failures are captured and thrown after cleanup completes.
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
): Promise<void> {
  const deepest = parents.createdPaths.at(-1);
  if (deepest) await filesystem.mkdir(deepest, { recursive: true });
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

export async function requestedSpellingExists(path: string): Promise<boolean> {
  try {
    return (await readdir(dirname(path))).includes(basename(path));
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
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
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
    // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- The failure is captured and thrown after the temporary-entry cleanup attempt.
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await filesystem.unlink(temporaryPath);
      // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Non-ENOENT cleanup failures are captured and thrown after cleanup completes.
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
}

export async function executePureMove(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath;
  if (mutation.moveStrategy === "copy-unlink") {
    await executeCrossDeviceMove(mutation, filesystem);
    return;
  }
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
    try {
      await filesystem.lstat(destinationPath);
      destinationChanged = true;
      // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Destination inspection is best-effort metadata for the primary move failure.
    } catch {}
    throw new PureMoveExecutionError(
      errorMessage(error),
      destinationChanged
        ? mutation.expectedDestination.kind === "absent"
          ? "created"
          : "replaced"
        : "unchanged",
      undefined,
      error,
    );
  }
}
