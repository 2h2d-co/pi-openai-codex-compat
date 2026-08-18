import { dirname, resolve } from "node:path";
import type {
  ApplyPatchExecutionFilesystem,
  ApplyPatchFileEntryDetails,
  ApplyPatchFinalPathState,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
} from "./apply-patch-engine-contracts.ts";
import { isNotFound } from "./apply-patch-engine-errors.ts";
import {
  ABSENT_ENTRY,
  buffersEqual,
  entryType,
  fingerprint,
  sameFingerprintExceptLinkCount,
  samePhysicalEntry,
  type ExistingFileEntry,
  type PlannedMutation,
  type ReplaceableFileEntry,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";
import { requiredValue } from "../required-value.ts";

export function addInstructionEffect(
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

export function fileEntryDetails(entry: ExistingFileEntry): ApplyPatchFileEntryDetails {
  return entry.kind === "regular"
    ? { entryType: "regular-file" }
    : { entryType: "symlink", target: entry.target };
}

export function replacedInstructionEffect(
  path: string,
  previousEntry: ReplaceableFileEntry,
  replacementEntry: ApplyPatchFileEntryDetails,
): ApplyPatchInstructionEffect {
  if (previousEntry.kind === "absent") {
    throw new Error(`replacement effect for ${path} requires an existing entry`);
  }
  return {
    kind: "replaced",
    path,
    previousEntry: fileEntryDetails(previousEntry),
    replacementEntry,
  };
}

export function addInstructionFinalState(
  instruction: ApplyPatchInstructionDetails,
  state: ApplyPatchFinalPathState,
): void {
  instruction.finalStates ??= [];
  const existing = instruction.finalStates.findIndex((candidate) => candidate.path === state.path);
  if (existing === -1) instruction.finalStates.push(state);
  else instruction.finalStates[existing] = state;
}

export function currentEntryFinalState(entry: VirtualEntry): ApplyPatchFinalPathState["state"] {
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

export function entriesHaveSameIdentity(actual: VirtualEntry, expected: VirtualEntry): boolean {
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

export async function currentExecutionEntry(
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

export type ApplyPatchFinalPathInspection = {
  finalState: ApplyPatchFinalPathState;
  entry?: VirtualEntry;
};

export function finalPathInspection(
  path: string,
  state: ApplyPatchFinalPathState["state"],
  entry?: VirtualEntry,
): ApplyPatchFinalPathInspection {
  const inspection: ApplyPatchFinalPathInspection = {
    finalState: { path, state },
  };
  if (entry) inspection.entry = entry;
  return inspection;
}

export async function inspectFinalPath(
  absolutePath: string,
  displayPath: string,
  expected: VirtualEntry,
  filesystem: ApplyPatchExecutionFilesystem,
  requestedContent?: Buffer,
): Promise<ApplyPatchFinalPathInspection> {
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
          return finalPathInspection(displayPath, "requested-content", actual);
        }
        if (physicalEntryChanged) {
          return finalPathInspection(displayPath, "different-entry", actual);
        }
        if (expected.kind === "regular" || expected.kind === "symlink") {
          const expectedBytes = expected.content.value?.bytes;
          if (expectedBytes && buffersEqual(bytes, expectedBytes)) {
            return finalPathInspection(displayPath, "unchanged", actual);
          }
          if (expectedBytes) {
            return finalPathInspection(
              displayPath,
              "different-from-requested-and-previous-content",
              actual,
            );
          }
        }
        return finalPathInspection(displayPath, "different-from-requested-content", actual);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return finalPathInspection(
          displayPath,
          physicalEntryChanged ? "different-entry" : "not-verified",
          actual,
        );
      }
    }
    if (physicalEntryChanged) {
      return finalPathInspection(displayPath, "different-entry", actual);
    }
    if (
      (actual.kind === "regular" || actual.kind === "symlink") &&
      (expected.kind === "regular" || expected.kind === "symlink") &&
      expected.content.value
    ) {
      try {
        const bytes = await filesystem.readFile(absolutePath);
        return finalPathInspection(
          displayPath,
          buffersEqual(bytes, expected.content.value.bytes)
            ? "unchanged"
            : "different-from-previous-content",
          actual,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return finalPathInspection(displayPath, "not-verified", actual);
      }
    }
    if (entriesHaveSameIdentity(actual, expected)) {
      return finalPathInspection(displayPath, "unchanged", actual);
    }
    if (actual.kind !== expected.kind && actual.kind !== "absent" && expected.kind !== "absent") {
      return finalPathInspection(displayPath, "different-entry-type", actual);
    }
    if (
      actual.kind === expected.kind &&
      "fingerprint" in actual &&
      actual.fingerprint &&
      "fingerprint" in expected &&
      expected.fingerprint
    ) {
      return finalPathInspection(displayPath, "different-entry", actual);
    }
    return finalPathInspection(displayPath, currentEntryFinalState(actual), actual);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return finalPathInspection(displayPath, "not-verified");
  }
}

export function inspectedFileEntry(
  inspection: ApplyPatchFinalPathInspection | undefined,
): ApplyPatchFileEntryDetails | undefined {
  const entry = inspection?.entry;
  return entry?.kind === "regular" || entry?.kind === "symlink"
    ? fileEntryDetails(entry)
    : undefined;
}

export function addInspectedReplacementEffect(
  instruction: ApplyPatchInstructionDetails,
  path: string,
  previousEntry: ExistingFileEntry,
  inspection: ApplyPatchFinalPathInspection | undefined,
): void {
  const replacementEntry = inspectedFileEntry(inspection);
  if (!replacementEntry) return;
  addInstructionEffect(
    instruction,
    replacedInstructionEffect(path, previousEntry, replacementEntry),
  );
}

export function finalStateHasChangedPresentEntry(
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

export async function recordFailureInspection(
  mutation: PlannedMutation,
  instruction: ApplyPatchInstructionDetails,
  filesystem: ApplyPatchExecutionFilesystem,
  filesystemMutationStarted: boolean,
  temporaryPath?: string,
): Promise<void> {
  const inspected: ApplyPatchFinalPathInspection[] = [];
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
      const moveTo = requiredValue(
        mutation.operation.moveTo,
        "A moved text update has no destination.",
      );
      inspected.push(
        await inspectFinalPath(
          mutation.operation.moveAbsolutePath,
          moveTo,
          mutation.expectedDestination,
          filesystem,
          mutation.content,
        ),
      );
    }
  } else {
    const moveAbsolutePath = requiredValue(
      mutation.operation.moveAbsolutePath,
      "A move mutation has no destination path.",
    );
    const moveTo = requiredValue(mutation.operation.moveTo, "A move mutation has no destination.");
    inspected.push(
      await inspectFinalPath(
        mutation.operation.absolutePath,
        mutation.operation.path,
        mutation.expectedSource,
        filesystem,
      ),
    );
    inspected.push(
      await inspectFinalPath(moveAbsolutePath, moveTo, mutation.expectedDestination, filesystem),
    );
  }

  for (const inspection of inspected) {
    addInstructionFinalState(instruction, inspection.finalState);
  }
  if (!filesystemMutationStarted) return;

  const sourceInspection = inspected.find(
    ({ finalState }) => finalState.path === mutation.operation.path,
  );
  const sourceState = sourceInspection?.finalState;
  const destinationPath =
    mutation.kind === "text-update" || mutation.kind === "move"
      ? mutation.operation.moveTo
      : undefined;
  const destinationInspection = destinationPath
    ? inspected.find(({ finalState }) => finalState.path === destinationPath)
    : undefined;
  const destinationState = destinationInspection?.finalState;

  if (mutation.kind === "add") {
    if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedTarget)) {
      if (mutation.expectedTarget.kind === "absent") {
        addInstructionEffect(instruction, {
          kind: "created",
          path: mutation.operation.path,
        });
      } else {
        addInspectedReplacementEffect(
          instruction,
          mutation.operation.path,
          mutation.expectedTarget,
          sourceInspection,
        );
      }
    }
  } else if (mutation.kind === "delete") {
    if (sourceState?.state === "absent") {
      addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
    } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedTarget)) {
      addInspectedReplacementEffect(
        instruction,
        mutation.operation.path,
        mutation.expectedTarget,
        sourceInspection,
      );
    }
  } else if (mutation.kind === "text-update") {
    if (mutation.operation.moveTo) {
      if (
        destinationState &&
        mutation.expectedDestination &&
        finalStateHasChangedPresentEntry(destinationState, mutation.expectedDestination)
      ) {
        if (mutation.expectedDestination.kind === "absent") {
          addInstructionEffect(instruction, {
            kind: "created",
            path: mutation.operation.moveTo,
          });
        } else {
          addInspectedReplacementEffect(
            instruction,
            mutation.operation.moveTo,
            mutation.expectedDestination,
            destinationInspection,
          );
        }
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
        addInspectedReplacementEffect(
          instruction,
          mutation.operation.path,
          mutation.expectedSource,
          sourceInspection,
        );
      }
    } else if (sourceState?.state === "absent") {
      addInstructionEffect(instruction, { kind: "deleted", path: mutation.operation.path });
    } else if (finalStateHasChangedPresentEntry(sourceState, mutation.expectedSource)) {
      addInstructionEffect(instruction, { kind: "updated", path: mutation.operation.path });
    }
  } else {
    const moveTo = requiredValue(mutation.operation.moveTo, "A move mutation has no destination.");
    if (
      destinationState &&
      finalStateHasChangedPresentEntry(destinationState, mutation.expectedDestination)
    ) {
      if (mutation.expectedDestination.kind === "absent") {
        addInstructionEffect(instruction, {
          kind: "created",
          path: moveTo,
        });
      } else {
        addInspectedReplacementEffect(
          instruction,
          moveTo,
          mutation.expectedDestination,
          destinationInspection,
        );
      }
    } else if (
      destinationState?.state === "absent" &&
      mutation.expectedDestination.kind !== "absent"
    ) {
      addInstructionEffect(instruction, {
        kind: "deleted",
        path: moveTo,
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
      addInspectedReplacementEffect(
        instruction,
        mutation.operation.path,
        mutation.expectedSource,
        sourceInspection,
      );
    }
  }

  const createdParents = "parents" in mutation ? mutation.parents.createdPaths : [];
  for (const parent of createdParents) {
    try {
      if ((await filesystem.lstat(parent)).isDirectory()) {
        addInstructionEffect(instruction, { kind: "directory-created", path: parent });
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  if (temporaryPath) {
    try {
      await filesystem.lstat(temporaryPath);
      addInstructionEffect(instruction, {
        kind: "temporary-entry-remains",
        path: temporaryPath,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
}
