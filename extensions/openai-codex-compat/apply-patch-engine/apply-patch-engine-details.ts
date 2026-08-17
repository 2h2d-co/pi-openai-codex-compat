import { generateDiffString } from "@earendil-works/pi-coding-agent";
import type { FormatterMatchFailureDetails } from "../apply-patch-matcher.ts";
import type {
  AppliedPatchChange,
  ApplyPatchDetails,
  ApplyPatchFailureDetails,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
} from "./apply-patch-engine-contracts.ts";
import type { SemanticPlan } from "./apply-patch-engine-filesystem-model.ts";
import { resolvePatchPath } from "./apply-patch-engine-operation-semantics.ts";

export function diffDetails(
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
  const cloneMatcher = (matcher: FormatterMatchFailureDetails): FormatterMatchFailureDetails => ({
    ...matcher,
    candidates: matcher.candidates.map((range) => ({ ...range })),
    ...(matcher.previousCandidates
      ? { previousCandidates: matcher.previousCandidates.map((range) => ({ ...range })) }
      : {}),
    ...(matcher.replacementCandidates
      ? { replacementCandidates: matcher.replacementCandidates.map((range) => ({ ...range })) }
      : {}),
  });
  const cloneEffect = (effect: ApplyPatchInstructionEffect): ApplyPatchInstructionEffect =>
    effect.kind === "replaced"
      ? {
          ...effect,
          previousEntry: { ...effect.previousEntry },
          replacementEntry: { ...effect.replacementEntry },
        }
      : { ...effect };
  return {
    ...details,
    changes: details.changes.map((change) => ({ ...change })),
    added: [...details.added],
    modified: [...details.modified],
    deleted: [...details.deleted],
    ...(details.instructions
      ? {
          instructions: details.instructions.map((instruction) => ({
            ...instruction,
            ...(instruction.effects ? { effects: instruction.effects.map(cloneEffect) } : {}),
            ...(instruction.finalStates
              ? { finalStates: instruction.finalStates.map((state) => ({ ...state })) }
              : {}),
            ...(instruction.matcher ? { matcher: cloneMatcher(instruction.matcher) } : {}),
            ...(instruction.changeIndexes ? { changeIndexes: [...instruction.changeIndexes] } : {}),
            ...(instruction.reason
              ? {
                  reason: {
                    ...instruction.reason,
                    ...(instruction.reason.dominatingInstructions
                      ? {
                          dominatingInstructions: [...instruction.reason.dominatingInstructions],
                        }
                      : {}),
                    ...(instruction.reason.relatedInstructions
                      ? {
                          relatedInstructions: [...instruction.reason.relatedInstructions],
                        }
                      : {}),
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(details.failure
      ? {
          failure: {
            ...details.failure,
            ...(details.failure.matcher ? { matcher: cloneMatcher(details.failure.matcher) } : {}),
          },
        }
      : {}),
  };
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

export function detailsForPlan(plan: SemanticPlan): ApplyPatchDetails {
  const details = emptyDetails();
  details.exact = plan.exact;
  details.instructions = plan.instructions.map((instruction) => ({ ...instruction }));
  for (const mutation of plan.mutations) {
    appendChange(details, mutation.change, mutation.instructionIndex);
  }
  return details;
}

export function previewDetailsForPlan(plan: SemanticPlan, cwd: string): ApplyPatchDetails {
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

export function failedApplyPatchDetails(
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
