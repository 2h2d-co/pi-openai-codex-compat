import { isAbsolute, relative, sep } from "node:path";
import type { FormatterMatchFailureDetails } from "../apply-patch-matcher.ts";
import type {
  ApplyPatchDetails,
  ApplyPatchFileEntryDetails,
  ApplyPatchFinalPathState,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
  ApplyPatchInstructionStatus,
} from "./apply-patch-engine-contracts.ts";

export function formatApplyPatchInstructionLabel(
  instruction: ApplyPatchInstructionDetails,
): string {
  const verb =
    instruction.kind === "add"
      ? "Add"
      : instruction.kind === "delete"
        ? "Delete"
        : instruction.kind === "move"
          ? "Move"
          : "Update";
  if (!instruction.moveTo) return `${verb} ${instruction.path}`;
  return instruction.kind === "update"
    ? `Update & Move ${instruction.path} -> ${instruction.moveTo}`
    : `${verb} ${instruction.path} -> ${instruction.moveTo}`;
}

export function feedbackPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const relativePath = relative(cwd, path);
  return relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
    ? path
    : relativePath;
}

export function matcherRangeLabel(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}-${range.endLine}`;
}

export const UPDATED_PATCH_GUIDANCE =
  "Use apply_patch again with more specific surrounding context or smaller changes if needed.";

export function matcherInstructionFeedback(matcher: FormatterMatchFailureDetails): string {
  const ranges = matcher.candidates.map(matcherRangeLabel).join(" and ");
  switch (matcher.reason) {
    case "no-candidate": {
      const replacements = matcher.replacementCandidates?.map(matcherRangeLabel).join(" and ");
      return replacements
        ? `Requested replacement found at ${replacements}, but old content was not found. Inspect the reported lines and use apply_patch again with updated instructions if needed.`
        : "Old content was not found. Read the current file and use apply_patch again with updated instructions if needed.";
    }
    case "no-ordered-mapping": {
      const previous = matcher.previousCandidates?.map(matcherRangeLabel).join(" and ");
      if (matcher.reverseOrdered) {
        return `The requested changes match in reverse source-file order at ${ranges} and ${previous}. Use apply_patch again with the requested changes in source-file order if needed.`;
      }
      if (matcher.overlapping) {
        return `The requested changes overlap at ${ranges} and ${previous}. Use apply_patch again with non-overlapping changes if needed.`;
      }
      return `The requested changes cannot be matched in source-file order; matches were found at ${ranges} and ${previous}. Use apply_patch again with the requested changes in source-file order if needed.`;
    }
    case "too-many-candidates":
      return `${matcher.candidateCount} matching locations exceed the 64-location limit. ${UPDATED_PATCH_GUIDANCE}`;
    case "ambiguous-output":
      return `Matching locations${ranges ? ` at ${ranges}` : ""} produce different results. ${UPDATED_PATCH_GUIDANCE}`;
    case "mapping-limit":
      return `More than 256 possible ways to apply the requested changes were found. ${UPDATED_PATCH_GUIDANCE}`;
    case "overlapping-edits":
      return `The requested changes${ranges ? ` at ${ranges}` : ""} overlap. Use apply_patch again with non-overlapping changes if needed.`;
  }
}

export function conciseInstructionError(error: string): string {
  const message = error
    .replace(/^apply_patch verification failed:\s*/u, "")
    .replace(/^invalid patch:\s*/u, "")
    .replace(/^invalid hunk at line \d+,\s*/u, "")
    .replace(/^Failed to write file .*?:\s*/u, "Write failed: ")
    .replace(/^Failed to delete file .*?:\s*/u, "Delete failed: ")
    .replace(
      /^Failed to remove original .*?:\s*/u,
      "The updated content was written to the destination, but removing the source failed: ",
    )
    .replace(/^Failed to establish move from .*?:\s*/u, "Rename failed: ")
    .replace(/^Failed to read file to update .*?:\s*/u, "Read failed: ")
    .replace(/^Failed to inspect /u, "Failed to read filesystem metadata for ")
    .replace(/^Cannot add .*?: path is\s*/u, "Validation failed: Path is ")
    .replace(/^Cannot delete .*?: path is\s*/u, "Validation failed: Path is ")
    .replace(/^Cannot move update to .*?: destination is\s*/u, "Validation failed: Destination is ")
    .replace(/^Failed to move to .*?: destination is\s*/u, "Validation failed: Destination is ")
    .replace(/^Failed to move .*?: source is\s*/u, "Validation failed: Source is ")
    .replace(
      /^Failed to move .*?: source does not exist, and no earlier instruction moved it to .*$/u,
      "Validation failed: The move source does not exist, and no earlier instruction moved it to the destination.",
    )
    .replace(
      /^Cannot create .*?: parent path .*? is not a directory$/u,
      "Validation failed: Parent path is not a directory.",
    )
    .replace(/^Cannot determine filesystem for .*$/u, "Filesystem check failed.")
    .replace(/^Failed to move .*? to .*?:\s*/u, "Move failed: ")
    .replace(/^Failed to find context [^\n]*/u, "Context was not found.")
    .replace(/^Failed to find expected lines in [^\n]*/u, "Old content was not found.")
    .replace(
      /^Filesystem changed after apply_patch preflight at .*$/u,
      "Filesystem changed after validation.",
    )
    .replace(
      /^Filesystem changed while committing apply_patch at .*$/u,
      "Filesystem changed after the operation.",
    )
    .replace(/; destination was removed before replacement failed$/u, "")
    .replace(/^apply_patch was cancelled\.$/u, "apply_patch was cancelled.");
  return message.split("\n")[0]!;
}

export function fileEntryFeedback(entry: ApplyPatchFileEntryDetails): string {
  return entry.entryType === "regular-file" ? "a regular file" : `a symlink to ${entry.target}`;
}

export function instructionEffectFeedback(
  effect: ApplyPatchInstructionEffect,
  instruction: ApplyPatchInstructionDetails,
  cwd: string,
): string {
  const path = feedbackPath(effect.path, cwd);
  switch (effect.kind) {
    case "created":
      return `Created ${path}.`;
    case "replaced":
      if (
        effect.previousEntry.entryType === "regular-file" &&
        effect.replacementEntry.entryType === "regular-file"
      ) {
        return `${path} is still a regular file.`;
      }
      return `${path}, previously ${fileEntryFeedback(effect.previousEntry)}, is now ${fileEntryFeedback(effect.replacementEntry)}.`;
    case "updated":
      return `Updated ${path}.`;
    case "deleted":
      return `Deleted ${path}.`;
    case "directory-created":
      return `Created directory ${path}.`;
    case "temporary-entry-remains":
      return `Temporary entry remains at ${path}.`;
    case "source-remains":
      return `${path} remains.`;
    case "symlink-removed":
      return `Removed the symlink ${path}; its target was ${effect.target}.`;
    case "symlink-moved": {
      if (!instruction.moveTo) {
        throw new Error(`moved symlink effect for ${instruction.path} requires a destination`);
      }
      return instruction.effects?.some(
        (candidate) => candidate.kind === "replaced" && candidate.path === instruction.moveTo,
      )
        ? `Moved the symlink ${path}.`
        : `Moved the symlink ${path}; ${feedbackPath(instruction.moveTo, cwd)} is now a symlink to ${effect.target}.`;
    }
    case "symlink-target-modified":
      return `Modified file content through the symlink at ${path} (target: ${effect.target}); the symlink was not modified.`;
  }
}

export function finalStateFeedback(state: ApplyPatchFinalPathState, cwd: string): string {
  const path = feedbackPath(state.path, cwd);
  switch (state.state) {
    case "absent":
      return `${path} is absent.`;
    case "regular-file":
      return `${path} is present as a regular file.`;
    case "symlink":
      return `${path} is present as a symlink.`;
    case "directory":
      return `${path} is present as a directory.`;
    case "other-entry":
      return `${path} is present as another entry type.`;
    case "unchanged":
      return `${path} is unchanged.`;
    case "requested-content":
      return `The file at ${path} contains the requested content byte-for-byte despite the reported error.`;
    case "different-from-requested-content":
      return `The content at ${path} does not match the requested content byte-for-byte.`;
    case "different-from-requested-and-previous-content":
      return `The content at ${path} matches neither the requested content nor the previously observed content.`;
    case "different-from-previous-content":
      return `The content at ${path} does not match the previously observed content.`;
    case "different-entry":
      return `${path} is a different filesystem entry.`;
    case "different-entry-type":
      return `Entry type changed for ${path}.`;
    case "not-verified":
      return `Final state not verified for ${path}.`;
  }
}

export function formatApplyPatchInstructionStatusLabel(
  status: ApplyPatchInstructionStatus,
): string {
  switch (status) {
    case "applied":
      return "APPLIED";
    case "planned":
      return "PLANNED";
    case "no-op":
      return "NO CHANGE";
    case "dead":
      return "SKIPPED";
    case "failed":
      return "FAILED";
    case "not-run":
      return "NOT RUN";
  }
}

export function sentenceClause(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

export function formatApplyPatchInstructionFeedback(
  instruction: ApplyPatchInstructionDetails,
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string | undefined {
  const clauses: string[] = [];
  if (instruction.status === "no-op" || instruction.status === "dead") {
    if (instruction.reason) clauses.push(instruction.reason.message);
  }
  for (const effect of instruction.effects ?? []) {
    if (instruction.status === "failed" && effect.kind === "updated") continue;
    clauses.push(instructionEffectFeedback(effect, instruction, cwd));
  }
  if (instruction.status === "failed") {
    if (instruction.matcher) clauses.push(matcherInstructionFeedback(instruction.matcher));
    else if (instruction.error) clauses.push(conciseInstructionError(instruction.error));
    const effectPaths = new Set((instruction.effects ?? []).map((effect) => effect.path));
    const replacementPaths = new Set(
      (instruction.effects ?? []).flatMap((effect) =>
        effect.kind === "replaced" ? [effect.path] : [],
      ),
    );
    for (const state of instruction.finalStates ?? []) {
      if (
        state.state === "not-verified" ||
        state.state === "requested-content" ||
        state.state === "different-from-requested-content" ||
        state.state === "different-from-requested-and-previous-content" ||
        state.state === "different-from-previous-content" ||
        ((state.state === "different-entry" || state.state === "different-entry-type") &&
          !replacementPaths.has(state.path)) ||
        !effectPaths.has(state.path)
      ) {
        clauses.push(finalStateFeedback(state, cwd));
      }
    }
  }
  if (instruction.status === "not-run") {
    if (details.failure?.failedInstruction !== undefined) {
      clauses.push(`Instruction ${details.failure.failedInstruction} failed.`);
    } else if (details.failure?.message === "apply_patch was cancelled.") {
      clauses.push("apply_patch was cancelled before this instruction was executed.");
    } else if (details.failure?.phase === "parse") {
      clauses.push("Patch format error.");
    } else if (details.failure?.phase === "preflight") {
      clauses.push("apply_patch setup failed before this instruction was executed.");
    } else if (details.failure?.phase === "input") {
      clauses.push("The apply_patch request was rejected before this instruction was executed.");
    } else {
      clauses.push("apply_patch stopped before this instruction was executed.");
    }
  }

  if (clauses.length === 0) return undefined;
  return `${clauses.map(sentenceClause).join("; ")}.`;
}

export function formatApplyPatchInstructionResult(
  instruction: ApplyPatchInstructionDetails,
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string {
  const result = `${instruction.index}. [${formatApplyPatchInstructionStatusLabel(instruction.status)}] ${formatApplyPatchInstructionLabel(instruction)}`;
  const feedback = formatApplyPatchInstructionFeedback(instruction, details, cwd);
  return feedback ? `${result} - ${feedback}` : result;
}

export function applyPatchSummaryPaths(details: ApplyPatchDetails): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const added = new Set(details.added);
  const modified = new Set(details.modified);
  const deleted = new Set(details.deleted);
  const partialMoveChanges = new Set(
    (details.instructions ?? []).flatMap((instruction) =>
      instruction.status === "failed"
        ? (instruction.changeIndexes ?? []).filter((index) => {
            const change = details.changes[index];
            return change?.kind === "move" && !change.exact;
          })
        : [],
    ),
  );
  const completedChangePaths = new Set(
    details.changes.flatMap((change, index) => {
      if (partialMoveChanges.has(index)) return [];
      if (change.kind === "move") return [change.destinationPath];
      if (change.kind === "update") return [change.moveTo ?? change.path];
      return [change.path];
    }),
  );
  for (const index of partialMoveChanges) {
    const change = details.changes[index];
    if (change?.kind === "move" && !completedChangePaths.has(change.destinationPath)) {
      modified.delete(change.destinationPath);
    }
  }
  const confirmedPaths = new Set([...added, ...modified, ...deleted]);
  for (const instruction of details.instructions ?? []) {
    for (const effect of instruction.effects ?? []) {
      if (added.has(effect.path) || modified.has(effect.path) || deleted.has(effect.path)) {
        if (
          effect.kind === "created" ||
          effect.kind === "replaced" ||
          effect.kind === "updated" ||
          effect.kind === "deleted"
        ) {
          confirmedPaths.add(effect.path);
        }
        continue;
      }
      if (effect.kind === "created") {
        added.add(effect.path);
        confirmedPaths.add(effect.path);
      } else if (effect.kind === "replaced" || effect.kind === "updated") {
        modified.add(effect.path);
        confirmedPaths.add(effect.path);
      } else if (effect.kind === "deleted") {
        deleted.add(effect.path);
        confirmedPaths.add(effect.path);
      }
    }
  }
  const unverifiedPaths = new Set(
    (details.instructions ?? []).flatMap((instruction) =>
      (instruction.finalStates ?? []).flatMap((state) =>
        state.state === "not-verified" ? [state.path] : [],
      ),
    ),
  );
  for (const path of unverifiedPaths) {
    if (confirmedPaths.has(path)) continue;
    added.delete(path);
    modified.delete(path);
    deleted.delete(path);
  }
  return { added: [...added], modified: [...modified], deleted: [...deleted] };
}

export function applyPatchHasOtherFilesystemChanges(details: ApplyPatchDetails): boolean {
  return (details.instructions ?? []).some((instruction) =>
    instruction.effects?.some(
      (effect) => effect.kind === "directory-created" || effect.kind === "temporary-entry-remains",
    ),
  );
}

export function applyPatchNeedsInstructionResults(
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): boolean {
  return (details.instructions ?? []).some(
    (instruction) =>
      instruction.status !== "applied" ||
      formatApplyPatchInstructionFeedback(instruction, details, cwd) !== undefined,
  );
}

export function instructionResults(details: ApplyPatchDetails, cwd: string): string[] {
  const instructions = details.instructions ?? [];
  if (!applyPatchNeedsInstructionResults(details, cwd)) return [];
  return [
    "Patch instruction results:",
    ...instructions.map((instruction) =>
      formatApplyPatchInstructionResult(instruction, details, cwd),
    ),
  ];
}

export function formatApplyPatchSummary(details: ApplyPatchDetails, cwd = process.cwd()): string {
  const lines: string[] = [];
  const summary = applyPatchSummaryPaths(details);
  if (summary.added.length === 0 && summary.modified.length === 0 && summary.deleted.length === 0) {
    lines.push("Success. No files were changed.");
  } else {
    lines.push("Success. Updated the following files:");
    for (const path of summary.added) lines.push(`A ${feedbackPath(path, cwd)}`);
    for (const path of summary.modified) lines.push(`M ${feedbackPath(path, cwd)}`);
    for (const path of summary.deleted) lines.push(`D ${feedbackPath(path, cwd)}`);
  }
  const results = instructionResults(details, cwd);
  if (results.length > 0) lines.push("", ...results);
  return `${lines.join("\n")}\n`;
}

export function formatApplyPatchFailureHeading(details: ApplyPatchDetails): string[] {
  const lines: string[] = [];
  const instructions = details.instructions ?? [];
  const failed = instructions.find((instruction) => instruction.status === "failed");
  const lastApplied = instructions.findLast((instruction) => instruction.status === "applied");
  if (failed) {
    lines.push(`Patch failed at instruction ${failed.index} of ${instructions.length}.`);
  } else if (details.failure?.message === "apply_patch was cancelled.") {
    lines.push(
      lastApplied
        ? `apply_patch was cancelled after instruction ${lastApplied.index}.`
        : "apply_patch was cancelled before execution.",
    );
  } else if (details.failure?.phase === "parse") {
    const line = details.failure.message.match(/line (\d+)/u)?.[1];
    lines.push(
      `Patch format error${line ? ` at line ${line}` : ""}: ${conciseInstructionError(details.failure.message)}`,
    );
  } else if (details.failure?.phase === "preflight") {
    lines.push(`apply_patch setup failed: ${conciseInstructionError(details.failure.message)}`);
  } else if (
    details.failure?.phase === "input" &&
    details.failure.message !== "apply_patch was cancelled."
  ) {
    lines.push(`apply_patch request rejected: ${conciseInstructionError(details.failure.message)}`);
  } else {
    lines.push(
      lastApplied
        ? `apply_patch stopped after instruction ${lastApplied.index}.`
        : "apply_patch stopped before execution.",
    );
    if (details.failure?.message && details.failure.message !== "apply_patch was cancelled.") {
      lines.push(`Patch error: ${conciseInstructionError(details.failure.message)}`);
    }
  }
  return lines;
}

export function formatApplyPatchFailureSummary(
  details: ApplyPatchDetails,
  cwd = process.cwd(),
): string {
  const lines = formatApplyPatchFailureHeading(details);
  const instructions = details.instructions ?? [];
  const summary = applyPatchSummaryPaths(details);
  const hasSummary =
    summary.added.length > 0 || summary.modified.length > 0 || summary.deleted.length > 0;
  const hasOtherFilesystemChanges = applyPatchHasOtherFilesystemChanges(details);
  const hasUnverifiedState = instructions.some((instruction) =>
    instruction.finalStates?.some((state) => state.state === "not-verified"),
  );
  if (hasSummary) {
    lines.push("Files changed:");
    for (const path of summary.added) lines.push(`A ${feedbackPath(path, cwd)}`);
    for (const path of summary.modified) lines.push(`M ${feedbackPath(path, cwd)}`);
    for (const path of summary.deleted) lines.push(`D ${feedbackPath(path, cwd)}`);
  } else if (hasOtherFilesystemChanges) {
    lines.push("Filesystem changed.");
  } else if (!hasUnverifiedState) {
    lines.push("No files were changed.");
  }

  const results = instructionResults(details, cwd);
  if (results.length > 0) lines.push("", ...results);
  return `${lines.join("\n")}\n`;
}

export function formatApplyPatchModelOutput(
  exitCode: number,
  durationMs: number,
  output: string,
): string {
  const durationSeconds = Math.round(durationMs / 100) / 10;
  return [
    `Exit code: ${exitCode}`,
    `Wall time: ${durationSeconds} seconds`,
    "Output:",
    output,
  ].join("\n");
}
