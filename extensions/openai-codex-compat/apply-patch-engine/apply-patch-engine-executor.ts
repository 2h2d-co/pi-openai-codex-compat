import { constants } from "node:fs";
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
  samePhysicalEntry,
  type CommittedEntryMutation,
  type CommittedPhysicalLinkDelta,
  type ExistingFileEntry,
  type ParentPlan,
  type PlannedEntryMutation,
  type PlannedMutation,
  type RouteEntryExpectation,
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
    throw new Error(`Failed to verify ${path} before mutation: ${errorMessage(error)}`, {
      cause: error,
    });
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
    throw new Error(`Filesystem changed after apply_patch preflight at ${path}`);
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

function mergeExpectedWithCommittedEntry(
  path: string,
  expected: VirtualEntry,
  prior: CommittedEntryMutation | undefined,
): VirtualEntry {
  if (!prior) return expected;
  if (prior.expected.kind !== expected.kind) {
    throw new Error(`Filesystem state created by apply_patch changed unexpectedly at ${path}`);
  }
  if (
    (expected.kind === "regular" || expected.kind === "symlink") &&
    (prior.expected.kind === "regular" || prior.expected.kind === "symlink")
  ) {
    const content = expected.content.planned ? expected.content : prior.expected.content;
    if (expected.kind === "symlink" && prior.expected.kind === "symlink") {
      return {
        ...prior.expected,
        target: expected.target,
        targetPath: expected.targetPath,
        content,
      };
    }
    if (expected.kind === "regular" && prior.expected.kind === "regular") {
      return { ...prior.expected, content };
    }
  }
  return prior.expected;
}

function expectedAfterPhysicalLinkDeltas(
  expected: VirtualEntry,
  afterMutationIndex: number,
  physicalLinkDeltas: readonly CommittedPhysicalLinkDelta[],
): VirtualEntry {
  if ((expected.kind !== "regular" && expected.kind !== "symlink") || !expected.fingerprint) {
    return expected;
  }
  const expectedFingerprint = expected.fingerprint;
  const linkCountDelta = physicalLinkDeltas.reduce((total, change) => {
    return change.mutationIndex > afterMutationIndex &&
      samePhysicalEntry(expectedFingerprint, change.fingerprint)
      ? total + change.delta
      : total;
  }, 0);
  if (linkCountDelta === 0) return expected;
  return {
    ...expected,
    fingerprint: {
      ...expected.fingerprint,
      linkCount: expected.fingerprint.linkCount + linkCountDelta,
    },
  };
}

function effectiveExpectedEntry(
  path: string,
  key: string,
  expected: VirtualEntry,
  priorMutations: readonly CommittedEntryMutation[],
  physicalLinkDeltas: readonly CommittedPhysicalLinkDelta[],
): VirtualEntry {
  const priorByKey = priorMutations.findLast((mutation) => mutation.key === key);
  let priorByPhysicalEntry: CommittedEntryMutation | undefined;
  if ((expected.kind === "regular" || expected.kind === "symlink") && expected.fingerprint) {
    const expectedFingerprint = expected.fingerprint;
    priorByPhysicalEntry = priorMutations.findLast((mutation) => {
      return (
        (mutation.expected.kind === "regular" || mutation.expected.kind === "symlink") &&
        mutation.expected.fingerprint !== undefined &&
        samePhysicalEntry(expectedFingerprint, mutation.expected.fingerprint)
      );
    });
  }
  const prior = priorByKey ?? priorByPhysicalEntry;
  return expectedAfterPhysicalLinkDeltas(
    mergeExpectedWithCommittedEntry(path, expected, prior),
    prior?.mutationIndex ?? -1,
    physicalLinkDeltas,
  );
}

export async function assertMutationEntryMatches(
  path: string,
  key: string,
  expected: VirtualEntry,
  priorMutations: readonly CommittedEntryMutation[],
  physicalLinkDeltas: readonly CommittedPhysicalLinkDelta[],
): Promise<void> {
  await assertEntryMatches(
    path,
    effectiveExpectedEntry(path, key, expected, priorMutations, physicalLinkDeltas),
  );
}

export async function captureCommittedEntryMutations(
  mutations: readonly PlannedEntryMutation[],
  mutationIndex: number,
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
      mutationIndex,
    };
    committed.push(committedMutation);
  }
  return committed;
}

async function assertRouteMatches(
  route: readonly RouteEntryExpectation[],
  priorMutations: readonly CommittedEntryMutation[],
  physicalLinkDeltas: readonly CommittedPhysicalLinkDelta[],
): Promise<void> {
  for (const expectation of route) {
    const expected = effectiveExpectedEntry(
      expectation.path,
      expectation.key,
      expectation.expected,
      priorMutations,
      physicalLinkDeltas,
    );
    const actual = await currentEntry(expectation.path);
    if (actual.kind !== expected.kind) {
      throw new Error(
        `Filesystem route changed after apply_patch preflight at ${expectation.path}`,
      );
    }
    if (
      (actual.kind !== "directory" && actual.kind !== "symlink") ||
      (expected.kind !== "directory" && expected.kind !== "symlink") ||
      !actual.fingerprint ||
      !expected.fingerprint ||
      !samePhysicalEntry(actual.fingerprint, expected.fingerprint) ||
      (actual.kind === "symlink" &&
        expected.kind === "symlink" &&
        actual.target !== expected.target)
    ) {
      throw new Error(
        `Filesystem route changed after apply_patch preflight at ${expectation.path}`,
      );
    }
  }
}

async function writeCompleteBuffer(
  handle: Awaited<ReturnType<ApplyPatchExecutionFilesystem["open"]>>,
  content: Buffer,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  await filesystem.writeFile(handle, content);
  await handle.truncate(content.length);
}

async function readCompleteBuffer(
  handle: Awaited<ReturnType<ApplyPatchExecutionFilesystem["open"]>>,
  size: number,
): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === content.length ? content : content.subarray(0, offset);
}

async function assertPathStillBindsToOpenedTarget(
  path: string,
  expectedSource: ExistingFileEntry,
  openedTargetFingerprint: ReturnType<typeof fingerprint>,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<void> {
  const sourceMetadata = await filesystem.lstat(path);
  if (expectedSource.kind === "regular") {
    if (
      !sourceMetadata.isFile() ||
      !samePhysicalEntry(fingerprint(sourceMetadata), openedTargetFingerprint)
    ) {
      throw new Error(`Filesystem changed while apply_patch updated ${path}`);
    }
  } else {
    if (
      !sourceMetadata.isSymbolicLink() ||
      !expectedSource.fingerprint ||
      !samePhysicalEntry(fingerprint(sourceMetadata), expectedSource.fingerprint) ||
      (await filesystem.readlink(path)) !== expectedSource.target
    ) {
      throw new Error(`Filesystem changed while apply_patch updated ${path}`);
    }
  }
  const resolvedMetadata = await filesystem.stat(path);
  if (!samePhysicalEntry(fingerprint(resolvedMetadata), openedTargetFingerprint)) {
    throw new Error(`Filesystem changed while apply_patch updated ${path}`);
  }
}

async function executeInPlaceTextUpdate(
  mutation: Extract<PlannedMutation, { kind: "text-update"; moveMode: "none" }>,
  filesystem: ApplyPatchExecutionFilesystem,
  priorMutations: readonly CommittedEntryMutation[],
  physicalLinkDeltas: readonly CommittedPhysicalLinkDelta[],
  onMutationStart: () => void,
): Promise<void> {
  await assertMutationEntryMatches(
    mutation.operation.absolutePath,
    mutation.sourceKey,
    mutation.expectedSource,
    priorMutations,
    physicalLinkDeltas,
  );
  await assertRouteMatches(mutation.writePlan.route, priorMutations, physicalLinkDeltas);

  const expectedTarget = effectiveExpectedEntry(
    mutation.writePlan.targetPath,
    mutation.writePlan.targetKey,
    mutation.writePlan.expectedTarget,
    priorMutations,
    physicalLinkDeltas,
  );
  if (
    expectedTarget.kind !== "regular" ||
    !expectedTarget.fingerprint ||
    !expectedTarget.content.value
  ) {
    throw new Error(
      `Could not verify the planned regular-file write target for ${mutation.operation.absolutePath}`,
    );
  }

  const handle = await filesystem.open(mutation.operation.absolutePath, constants.O_RDWR);
  try {
    const openedTargetFingerprint = fingerprint(await handle.stat());
    if (!sameFingerprint(openedTargetFingerprint, expectedTarget.fingerprint)) {
      throw new Error(
        `Filesystem changed after apply_patch preflight at ${mutation.operation.absolutePath}`,
      );
    }
    if (
      !buffersEqual(
        await readCompleteBuffer(handle, openedTargetFingerprint.size),
        expectedTarget.content.value.bytes,
      )
    ) {
      throw new Error(
        `Filesystem changed after apply_patch preflight at ${mutation.operation.absolutePath}`,
      );
    }

    // Recheck after opening so a pathname swap during open cannot authorize a
    // write. A later swap cannot redirect the descriptor-bound mutation.
    await assertMutationEntryMatches(
      mutation.operation.absolutePath,
      mutation.sourceKey,
      mutation.expectedSource,
      priorMutations,
      physicalLinkDeltas,
    );
    await assertRouteMatches(mutation.writePlan.route, priorMutations, physicalLinkDeltas);

    onMutationStart();
    await writeCompleteBuffer(handle, mutation.content, filesystem);
    const resultingTargetFingerprint = fingerprint(await handle.stat());
    if (
      !samePhysicalEntry(resultingTargetFingerprint, expectedTarget.fingerprint) ||
      resultingTargetFingerprint.linkCount !== expectedTarget.fingerprint.linkCount
    ) {
      throw new Error(
        `Filesystem changed while apply_patch updated ${mutation.operation.absolutePath}`,
      );
    }
    await assertRouteMatches(mutation.writePlan.route, priorMutations, physicalLinkDeltas);
    const expectedSource = effectiveExpectedEntry(
      mutation.operation.absolutePath,
      mutation.sourceKey,
      mutation.expectedSource,
      priorMutations,
      physicalLinkDeltas,
    );
    if (expectedSource.kind !== "regular" && expectedSource.kind !== "symlink") {
      throw new Error(
        `Could not verify the planned source entry for ${mutation.operation.absolutePath}`,
      );
    }
    await assertPathStillBindsToOpenedTarget(
      mutation.operation.absolutePath,
      expectedSource,
      resultingTargetFingerprint,
      filesystem,
    );
  } finally {
    await handle.close();
  }
}

export async function assertParentPlanMatches(parents: ParentPlan): Promise<void> {
  for (const expectation of parents.expectations) {
    let actual: VirtualEntry;
    try {
      actual = await currentEntry(expectation.path);
    } catch (error) {
      throw new Error(
        `Failed to verify parent ${expectation.path} before mutation: ${errorMessage(error)}`,
        { cause: error },
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
        { cause: error },
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
            mutation.operation.moveTo,
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
  const committedPhysicalLinkDeltas: CommittedPhysicalLinkDelta[] = [];
  try {
    for (const [mutationIndex, mutation] of plan.mutations.entries()) {
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
          committedPhysicalLinkDeltas,
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
            { cause: error },
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "delete") {
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.targetKey,
          mutation.expectedTarget,
          committedEntryMutations,
          committedPhysicalLinkDeltas,
        );
        try {
          activeFilesystemMutationStarted = true;
          await filesystem.unlink(mutation.operation.absolutePath);
        } catch (error) {
          throw new Error(
            `Failed to delete file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        appendChange(details, mutation.change, mutation.instructionIndex);
      } else if (mutation.kind === "text-update") {
        if (mutation.moveMode !== "none") {
          await assertMutationEntryMatches(
            mutation.operation.absolutePath,
            mutation.sourceKey,
            mutation.expectedSource,
            committedEntryMutations,
            committedPhysicalLinkDeltas,
          );
        }
        if (mutation.moveMode === "same-entry") {
          const provisionalChange = mutation.provisionalChange;
          const moveAbsolutePath = mutation.operation.moveAbsolutePath;
          const moveTo = mutation.operation.moveTo;
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
          const destinationKey = mutation.destinationKey;
          const provisionalChange = mutation.provisionalChange;
          const moveTo = mutation.operation.moveTo;
          await assertMutationEntryMatches(
            mutation.operation.moveAbsolutePath,
            destinationKey,
            mutation.expectedDestination,
            committedEntryMutations,
            committedPhysicalLinkDeltas,
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
            await executeInPlaceTextUpdate(
              mutation,
              filesystem,
              committedEntryMutations,
              committedPhysicalLinkDeltas,
              () => {
                activeFilesystemMutationStarted = true;
              },
            );
          } catch (error) {
            details.exact = false;
            if (!activeFilesystemMutationStarted) throw error;
            throw new Error(
              `Failed to write file ${mutation.operation.absolutePath}: ${errorMessage(error)}`,
              { cause: error },
            );
          }
          appendChange(details, mutation.change, mutation.instructionIndex);
        }
      } else {
        const moveAbsolutePath = mutation.operation.moveAbsolutePath;
        const moveTo = mutation.operation.moveTo;
        await assertMutationEntryMatches(
          mutation.operation.absolutePath,
          mutation.sourceKey,
          mutation.expectedSource,
          committedEntryMutations,
          committedPhysicalLinkDeltas,
        );
        await assertMutationEntryMatches(
          moveAbsolutePath,
          mutation.destinationKey,
          mutation.expectedDestination,
          committedEntryMutations,
          committedPhysicalLinkDeltas,
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
      if (activeInstruction) recordAppliedInstructionEffects(mutation, activeInstruction);
      try {
        committedEntryMutations.push(
          ...(await captureCommittedEntryMutations(mutation.entryMutations, mutationIndex)),
        );
        committedPhysicalLinkDeltas.push(
          ...mutation.physicalLinkDeltas.map((change) => ({ ...change, mutationIndex })),
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
    throw new ApplyPatchExecutionError(details.error, cloneApplyPatchDetails(details), error);
  }
}
