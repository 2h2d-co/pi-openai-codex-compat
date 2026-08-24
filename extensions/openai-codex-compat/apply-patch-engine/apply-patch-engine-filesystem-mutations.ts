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
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { errorMessage, hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import { buffersEqual, type PlannedMutation } from "./apply-patch-engine-filesystem-model.ts";

export const DEFAULT_EXECUTION_FILESYSTEM: ApplyPatchExecutionFilesystem = {
  chmod,
  copyFile,
  lstat,
  mkdir,
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
    if (!buffersEqual(await filesystem.readFile(temporaryPath), content)) {
      throw new Error(`temporary replacement content differs at ${temporaryPath}`);
    }
    if (mode !== undefined) await filesystem.chmod(temporaryPath, mode & 0o7777);
    await filesystem.rename(temporaryPath, path);
    destinationChanged = true;
    await establishExactSpelling(path, filesystem);
  } catch (error) {
    pendingError = error;
  } finally {
    if (!destinationChanged) {
      try {
        await filesystem.unlink(temporaryPath);
      } catch (error) {
        if (!isNotFound(error)) {
          temporaryEntryRemains = true;
          if (pendingError === undefined) pendingError = error;
        }
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
  createdParentPaths: readonly string[],
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const deepest = createdParentPaths.at(-1);
  if (deepest) await filesystem.mkdir(deepest, { recursive: true });
}

export async function exactSpellingExists(
  path: string,
  filesystem: Pick<ApplyPatchExecutionFilesystem, "readdir">,
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
      const sourceMetadata = await filesystem.lstat(sourcePath);
      await filesystem.copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      await filesystem.chmod(temporaryPath, sourceMetadata.mode);
      await filesystem.utimes(temporaryPath, sourceMetadata.atime, sourceMetadata.mtime);
    } else {
      await filesystem.symlink(mutation.expectedSource.target, temporaryPath);
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
    if (!destinationChanged) {
      try {
        await filesystem.unlink(temporaryPath);
      } catch (error) {
        if (!isNotFound(error)) {
          temporaryEntryRemains = true;
          if (pendingError === undefined) pendingError = error;
        }
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
    return executeCrossDeviceMove(mutation, filesystem);
  }
  await filesystem.rename(sourcePath, destinationPath);
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
}
