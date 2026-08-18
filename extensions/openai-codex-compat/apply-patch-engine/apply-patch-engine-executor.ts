import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  ABSENT_ENTRY,
  buffersEqual,
  entryType,
  fingerprint,
  sameFingerprint,
  sameFingerprintExceptLinkCount,
  type CommittedEntryMutation,
  type ParentPlan,
  type PlannedEntryMutation,
  type PlannedMutation,
  type SemanticPlan,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";
import {
  PureMoveExecutionError,
  RegularFileReplacementError,
  createPlannedParents,
  executePureMove,
  finishSameInodeRename,
  replaceRegularFile,
} from "./apply-patch-engine-filesystem-mutations.ts";

export async function currentEntry(path: string): Promise<VirtualEntry> {
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

export async function assertEntryMatches(path: string, expected: VirtualEntry): Promise<void> {
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

export async function assertMutationEntryMatches(
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

export async function captureCommittedEntryMutations(
  mutations: readonly PlannedEntryMutation[],
): Promise<CommittedEntryMutation[]> {
  const committed: CommittedEntryMutation[] = [];
  for (const mutation of mutations) {
    const expected = await currentEntry(mutation.path);
    if (expected.kind !== mutation.kind) {
      throw new Error(`Filesystem changed while committing apply_patch at ${mutation.path}`);
    }
    const committedMutation: CommittedEntryMutation = {
      path: mutation.path,
      key: mutation.key,
      expected,
    };
    if (mutation.releasedFingerprint) {
      committedMutation.releasedFingerprint = mutation.releasedFingerprint;
    }
    committed.push(committedMutation);
  }
  return committed;
}

export async function assertParentPlanMatches(parents: ParentPlan): Promise<void> {
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
            mutation.operation.moveTo!,
            mutation.expectedDestination,
            fileEntryDetails(mutation.expectedSource),
          ),
        );
      }
      return;
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
                    : replacedInstructionEffect(mutation.operation.path, mutation.expectedTarget, {
                        entryType: "regular-file",
                      }),
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
                          { entryType: "regular-file" },
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
    const failure: ApplyPatchFailureDetails = {
      phase: "execution",
      message,
    };
    if (activeInstruction) failure.failedInstruction = activeInstruction.index;
    details.failure = failure;
    throw new ApplyPatchExecutionError(details.error, cloneApplyPatchDetails(details));
  }
}
