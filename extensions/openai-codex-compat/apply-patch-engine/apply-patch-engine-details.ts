import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type {
  AppliedPatchChange,
  ApplyPatchDetails,
  ApplyPatchFailureDetails,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
  ApplyPatchInstructionReason,
} from "./apply-patch-engine-contracts.ts";
import { resolvePatchPath } from "./apply-patch-engine-operation-semantics.ts";
import { requiredValue } from "../required-value.ts";

export interface PatchDiffDetails {
  displayDiff: string;
  additions: number;
  deletions: number;
}

export function diffDetails(oldContent: string, newContent: string): PatchDiffDetails {
  const displayDiff = generateDiffString(oldContent, newContent, 1).diff;
  let additions = 0;
  let deletions = 0;
  for (const line of displayDiff.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { displayDiff, additions, deletions };
}

export function initialContent(change: AppliedPatchChange): string | undefined {
  if (change.kind === "move") return undefined;
  if (change.kind === "add") return change.overwrittenContent;
  if (change.kind === "delete") return change.content;
  return change.oldContent;
}

export function finalContent(change: AppliedPatchChange): string | undefined {
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
    const first = requiredValue(group.changes[0], "A textual change group has no first change.");
    const last = requiredValue(group.changes.at(-1), "A textual change group has no last change.");
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

export function emptyDetails(): ApplyPatchDetails {
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
  const cloneEffect = (effect: ApplyPatchInstructionEffect): ApplyPatchInstructionEffect =>
    effect.kind === "replaced"
      ? {
          ...effect,
          previousEntry: { ...effect.previousEntry },
          replacementEntry: { ...effect.replacementEntry },
        }
      : { ...effect };
  const cloned: ApplyPatchDetails = {
    ...details,
    changes: details.changes.map((change) => ({ ...change })),
    added: [...details.added],
    modified: [...details.modified],
    deleted: [...details.deleted],
  };
  if (details.instructions) {
    cloned.instructions = details.instructions.map((instruction) => {
      const clonedInstruction: ApplyPatchInstructionDetails = { ...instruction };
      if (instruction.effects) {
        clonedInstruction.effects = instruction.effects.map(cloneEffect);
      }
      if (instruction.finalStates) {
        clonedInstruction.finalStates = instruction.finalStates.map((state) => ({ ...state }));
      }
      if (instruction.changeIndexes) {
        clonedInstruction.changeIndexes = [...instruction.changeIndexes];
      }
      if (instruction.reason) {
        const reason: ApplyPatchInstructionReason = { ...instruction.reason };
        if (instruction.reason.dominatingInstructions) {
          reason.dominatingInstructions = [...instruction.reason.dominatingInstructions];
        }
        if (instruction.reason.relatedInstructions) {
          reason.relatedInstructions = [...instruction.reason.relatedInstructions];
        }
        clonedInstruction.reason = reason;
      }
      return clonedInstruction;
    });
  }
  if (details.failure) {
    const failure: ApplyPatchFailureDetails = { ...details.failure };
    cloned.failure = failure;
  }
  return cloned;
}

export function appendChange(
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

export function failedApplyPatchDetails(
  phase: ApplyPatchFailureDetails["phase"],
  message: string,
  instructions: readonly ApplyPatchInstructionDetails[],
  failedInstruction?: number,
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
  const failure: ApplyPatchFailureDetails = { phase, message };
  if (failedInstruction !== undefined) failure.failedInstruction = failedInstruction;
  details.failure = failure;
  return details;
}
