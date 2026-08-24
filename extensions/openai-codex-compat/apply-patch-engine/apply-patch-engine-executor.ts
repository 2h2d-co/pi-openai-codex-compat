import type {
  ApplyPatchDetails,
  ApplyPatchExecutionFilesystem,
  ApplyPatchFailureDetails,
  ApplyPatchInstructionDetails,
} from "./apply-patch-engine-contracts.ts";
import {
  appendChange,
  cloneApplyPatchDetails,
  emptyDetails,
} from "./apply-patch-engine-details.ts";
import {
  ApplyPatchExecutionError,
  errorMessage,
  hasErrorCode,
  isNotFound,
  throwIfAborted,
} from "./apply-patch-engine-errors.ts";
import {
  addInstructionEffect,
  fileEntryDetails,
  recordFailureInspection,
  replacedInstructionEffect,
} from "./apply-patch-engine-failure-inspection.ts";
import {
  buffersEqual,
  fingerprint,
  samePhysicalEntry,
  type PlannedMutation,
  type SemanticPlan,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";
import {
  PureMoveExecutionError,
  RegularFileReplacementError,
  createPlannedParents,
  exactSpellingExists,
  executePureMove,
  finishSameInodeRename,
  replaceRegularFile,
} from "./apply-patch-engine-filesystem-mutations.ts";

function postconditionFailed(path: string, description: string, cause?: unknown): never {
  const message = `apply_patch did not ${description} at ${path}`;
  if (cause === undefined) throw new Error(message);
  throw new Error(message, { cause });
}

async function assertEntryAbsent(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  try {
    await filesystem.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return;
    postconditionFailed(path, "establish an absent entry", error);
  }
  postconditionFailed(path, "establish an absent entry");
}

async function assertExactSpellingAbsent(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  if (await exactSpellingExists(path, filesystem)) {
    postconditionFailed(path, "remove the exact source spelling");
  }
}

type RegularFilePostcondition = {
  exactSpelling: boolean;
  followSymlink: boolean;
  expectedMode: number | undefined;
  allowUnreadable?: boolean;
};

async function assertCompleteContent(
  path: string,
  expectedContent: Buffer,
  filesystem: ApplyPatchExecutionFilesystem,
  allowUnreadable = false,
): Promise<void> {
  let actualContent: Buffer;
  try {
    actualContent = await filesystem.readFile(path);
  } catch (error) {
    if (allowUnreadable && (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM"))) {
      return;
    }
    postconditionFailed(path, "verify the complete requested bytes", error);
  }
  if (!buffersEqual(actualContent, expectedContent)) {
    postconditionFailed(path, "produce the complete requested bytes");
  }
}

async function assertRegularFileResult(
  path: string,
  expectedContent: Buffer,
  filesystem: ApplyPatchExecutionFilesystem,
  options: RegularFilePostcondition,
): Promise<void> {
  if (options.exactSpelling && !(await exactSpellingExists(path, filesystem))) {
    postconditionFailed(path, "establish the requested exact spelling");
  }

  let metadata;
  try {
    metadata = options.followSymlink ? await filesystem.stat(path) : await filesystem.lstat(path);
  } catch (error) {
    postconditionFailed(path, "establish a regular file", error);
  }
  if (!metadata.isFile()) postconditionFailed(path, "establish a regular file");
  if (
    options.expectedMode !== undefined &&
    (metadata.mode & 0o7777) !== (options.expectedMode & 0o7777)
  ) {
    postconditionFailed(path, "preserve the requested file mode");
  }
  await assertCompleteContent(path, expectedContent, filesystem, options.allowUnreadable);
}

async function assertPureMoveResult(
  mutation: Extract<PlannedMutation, { kind: "move" }>,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const sourcePath = mutation.operation.absolutePath;
  const destinationPath = mutation.operation.moveAbsolutePath;
  await assertExactSpellingAbsent(sourcePath, filesystem);
  if (!(await exactSpellingExists(destinationPath, filesystem))) {
    postconditionFailed(destinationPath, "establish the requested exact spelling");
  }

  let metadata;
  try {
    metadata = await filesystem.lstat(destinationPath);
  } catch (error) {
    postconditionFailed(destinationPath, "establish the moved entry", error);
  }
  if (mutation.expectedSource.kind === "symlink") {
    if (!metadata.isSymbolicLink()) {
      postconditionFailed(destinationPath, "establish the moved symlink");
    }
    const target = await filesystem.readlink(destinationPath);
    if (target !== mutation.expectedSource.target) {
      postconditionFailed(destinationPath, "preserve the moved symlink target");
    }
  } else {
    if (!metadata.isFile()) postconditionFailed(destinationPath, "establish the moved file");
    const expectedMode = regularEntryMode(mutation.expectedSource);
    if (expectedMode !== undefined && (metadata.mode & 0o7777) !== (expectedMode & 0o7777)) {
      postconditionFailed(destinationPath, "preserve the moved file mode");
    }
    const expectedContent = mutation.expectedSource.content.value?.bytes;
    if (expectedContent) {
      await assertCompleteContent(destinationPath, expectedContent, filesystem, true);
    }
  }
  if (
    mutation.moveStrategy === "rename" &&
    mutation.expectedSource.fingerprint &&
    !samePhysicalEntry(fingerprint(metadata), mutation.expectedSource.fingerprint)
  ) {
    postconditionFailed(destinationPath, "preserve native move identity");
  }
}

function regularEntryMode(entry: VirtualEntry): number | undefined {
  return entry.kind === "regular" ? entry.physical.mode : undefined;
}

async function assertAppliedMutationPostconditions(
  mutation: PlannedMutation,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  if (mutation.kind === "add") {
    await assertRegularFileResult(mutation.operation.absolutePath, mutation.content, filesystem, {
      exactSpelling: true,
      followSymlink: false,
      expectedMode: regularEntryMode(mutation.expectedTarget),
      allowUnreadable: true,
    });
    return;
  }
  if (mutation.kind === "delete") {
    await assertEntryAbsent(mutation.operation.absolutePath, filesystem);
    return;
  }
  if (mutation.kind === "move") {
    await assertPureMoveResult(mutation, filesystem);
    return;
  }

  const destinationPath =
    mutation.moveMode === "none"
      ? mutation.operation.absolutePath
      : mutation.operation.moveAbsolutePath;
  await assertRegularFileResult(destinationPath, mutation.content, filesystem, {
    exactSpelling: mutation.moveMode !== "none",
    followSymlink: mutation.moveMode === "none",
    expectedMode: regularEntryMode(mutation.expectedSource),
    allowUnreadable: mutation.moveMode !== "none",
  });
  if (mutation.moveMode === "same-entry" && mutation.sameEntryMove === "rename") {
    await assertExactSpellingAbsent(mutation.operation.absolutePath, filesystem);
  } else if (mutation.moveMode === "destination") {
    await assertEntryAbsent(mutation.operation.absolutePath, filesystem);
  }
}

export function recordAppliedInstructionEffects(
  mutation: PlannedMutation,
  instruction: ApplyPatchInstructionDetails,
): void {
  switch (mutation.kind) {
    case "add":
      if (mutation.expectedTarget.kind !== "absent") {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget, {
            entryType: "regular-file",
          }),
        );
      }
      return;
    case "delete":
      if (mutation.expectedTarget.kind === "symlink") {
        addInstructionEffect(instruction, {
          kind: "symlink-removed",
          path: mutation.operation.path,
          target: mutation.expectedTarget.target,
        });
      }
      return;
    case "text-update":
      if (mutation.expectedSource.kind === "symlink") {
        addInstructionEffect(
          instruction,
          mutation.operation.moveTo
            ? {
                kind: "symlink-removed",
                path: mutation.operation.path,
                target: mutation.expectedSource.target,
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
          replacedInstructionEffect(mutation.operation.moveTo, mutation.expectedDestination, {
            entryType: "regular-file",
          }),
        );
      }
      return;
    case "move":
      if (mutation.expectedSource.kind === "symlink") {
        addInstructionEffect(instruction, {
          kind: "symlink-moved",
          path: mutation.operation.path,
          target: mutation.expectedSource.target,
        });
      }
      if (mutation.change.replacedDestination) {
        addInstructionEffect(
          instruction,
          replacedInstructionEffect(
            mutation.operation.moveTo,
            mutation.expectedDestination,
            fileEntryDetails(mutation.expectedSource),
          ),
        );
      }
  }
}

export async function executePlan(
  plan: SemanticPlan,
  signal: AbortSignal | undefined,
  filesystem: ApplyPatchExecutionFilesystem,
  onProgress?: (details: ApplyPatchDetails) => void,
): Promise<ApplyPatchDetails> {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  for (const action of plan.actions) {
    if (action.kind !== "no-change") continue;
    const instruction = details.instructions[action.instructionIndex];
    if (!instruction) {
      throw new Error(
        `No apply_patch instruction exists for no-change checkpoint ${action.instructionIndex + 1}`,
      );
    }
    instruction.status = "planned";
  }

  let activeInstruction: ApplyPatchInstructionDetails | undefined;
  let activeMutation: PlannedMutation | undefined;
  let activeTemporaryPath: string | undefined;
  try {
    for (const action of plan.actions) {
      activeInstruction = details.instructions[action.instructionIndex];
      activeMutation = action.kind === "no-change" ? undefined : action;
      activeTemporaryPath = undefined;
      throwIfAborted(signal);

      if (action.kind === "no-change") {
        if (activeInstruction) {
          activeInstruction.status = "no-op";
          delete activeInstruction.error;
        }
        activeInstruction = undefined;
        continue;
      }

      const mutation = action;
      if (mutation.kind === "add") {
        try {
          await createPlannedParents(mutation.createdParentPaths, filesystem);
          await replaceRegularFile(
            mutation.operation.absolutePath,
            mutation.content,
            filesystem,
            regularEntryMode(mutation.expectedTarget),
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
                    : replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget, {
                        entryType: "regular-file",
                      }),
                );
              }
            }
          }
          throw new Error(
            `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "delete") {
        try {
          await filesystem.unlink(mutation.operation.absolutePath);
        } catch (error) {
          throw new Error(
            `Failed to delete file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "text-update") {
        if (mutation.moveMode === "same-entry") {
          const provisionalChange = mutation.provisionalChange;
          const moveAbsolutePath = mutation.operation.moveAbsolutePath;
          const moveTo = mutation.operation.moveTo;
          try {
            await replaceRegularFile(
              mutation.operation.absolutePath,
              mutation.content,
              filesystem,
              regularEntryMode(mutation.expectedSource),
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError) {
              activeTemporaryPath = error.temporaryPath;
              if (error.destinationChanged) {
                appendChange(details, provisionalChange, mutation.instructionIndex);
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
              { cause: error },
            );
          }
          appendChange(details, provisionalChange, mutation.instructionIndex);
          if (mutation.sameEntryMove === "rename") {
            try {
              await filesystem.rename(mutation.operation.absolutePath, moveAbsolutePath);
              await finishSameInodeRename(
                mutation.operation.absolutePath,
                moveAbsolutePath,
                filesystem,
              );
            } catch (error) {
              details.exact = false;
              throw new Error(
                `Failed to establish move from ${mutation.operation.absolutePath} to ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
                { cause: error },
              );
            }
          }
          const lastChangeIndex = details.changes.length - 1;
          const lastModifiedIndex = details.modified.length - 1;
          if (lastChangeIndex < 0 || lastModifiedIndex < 0) {
            throw new Error(
              "A same-entry move completed without recording its provisional change.",
            );
          }
          details.changes[lastChangeIndex] = mutation.change;
          details.modified[lastModifiedIndex] = moveTo;
        } else if (mutation.moveMode === "destination") {
          const provisionalChange = mutation.provisionalChange;
          const moveTo = mutation.operation.moveTo;
          try {
            await createPlannedParents(mutation.createdParentPaths, filesystem);
            await replaceRegularFile(
              mutation.operation.moveAbsolutePath,
              mutation.content,
              filesystem,
              regularEntryMode(mutation.expectedSource),
            );
          } catch (error) {
            details.exact = false;
            if (error instanceof RegularFileReplacementError) {
              activeTemporaryPath = error.temporaryPath;
              if (error.destinationChanged) {
                appendChange(details, provisionalChange, mutation.instructionIndex);
                if (activeInstruction) {
                  addInstructionEffect(
                    activeInstruction,
                    mutation.expectedDestination.kind === "absent"
                      ? { kind: "created", path: moveTo }
                      : replacedInstructionEffect(moveTo, mutation.expectedDestination, {
                          entryType: "regular-file",
                        }),
                  );
                }
              }
            }
            throw new Error(
              `Failed to write file ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
              { cause: error },
            );
          }
          appendChange(details, provisionalChange, mutation.instructionIndex);
          try {
            await filesystem.unlink(mutation.operation.absolutePath);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to remove original ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
              { cause: error },
            );
          }
          const lastChangeIndex = details.changes.length - 1;
          if (lastChangeIndex < 0) {
            throw new Error(
              "A moved text update completed without recording its provisional change.",
            );
          }
          details.changes[lastChangeIndex] = mutation.change;
          details.added.pop();
          details.modified.push(moveTo);
        } else {
          try {
            await filesystem.writeFile(mutation.operation.absolutePath, mutation.content);
          } catch (error) {
            details.exact = false;
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
              { cause: error },
            );
          }
          appendChange(details, mutation.change, mutation.instructionIndex);
        }
      } else {
        const moveTo = mutation.operation.moveTo;
        try {
          await createPlannedParents(mutation.createdParentPaths, filesystem);
          await executePureMove(mutation, filesystem);
        } catch (error) {
          if (error instanceof PureMoveExecutionError) {
            activeTemporaryPath = error.temporaryPath;
          }
          if (mutation.createdParentPaths.length > 0) details.exact = false;
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
                  ? { kind: "created", path: moveTo }
                  : replacedInstructionEffect(
                      moveTo,
                      mutation.expectedDestination,
                      fileEntryDetails(mutation.expectedSource),
                    ),
              );
            }
            details.exact = false;
          }
          if (error instanceof PureMoveExecutionError && error.destinationState === "removed") {
            if (activeInstruction) {
              addInstructionEffect(activeInstruction, {
                kind: "deleted",
                path: moveTo,
              });
            }
            details.exact = false;
          }
          throw new Error(
            `Failed to move ${mutation.operation.absolutePath} to ${mutation.operation.moveAbsolutePath}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      }

      try {
        await assertAppliedMutationPostconditions(mutation, filesystem);
      } catch (error) {
        details.exact = false;
        throw error;
      }
      if (activeInstruction) {
        recordAppliedInstructionEffects(mutation, activeInstruction);
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
    const failure: ApplyPatchFailureDetails = {
      phase: "execution",
      message,
    };
    if (activeInstruction) failure.failedInstruction = activeInstruction.index;
    details.failure = failure;
    throw new ApplyPatchExecutionError(details.error, cloneApplyPatchDetails(details), error);
  }
}
