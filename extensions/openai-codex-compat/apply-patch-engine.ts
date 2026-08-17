import type {
  ApplyPatchDetails,
  ApplyPatchExecutionFilesystem,
  ApplyPatchExecutionHooks,
  ResolvedOperation,
} from "./apply-patch-engine/apply-patch-engine-contracts.ts";
import {
  failedApplyPatchDetails,
  previewDetailsForPlan,
} from "./apply-patch-engine/apply-patch-engine-details.ts";
import {
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchParseError,
  ApplyPatchVerificationError,
  errorMessage,
  throwIfAborted,
} from "./apply-patch-engine/apply-patch-engine-errors.ts";
import { executePlan } from "./apply-patch-engine/apply-patch-engine-executor.ts";
import { DEFAULT_EXECUTION_FILESYSTEM } from "./apply-patch-engine/apply-patch-engine-filesystem-mutations.ts";
import type { SemanticPlan } from "./apply-patch-engine/apply-patch-engine-filesystem-model.ts";
import {
  mutationQueueTargets,
  logicalMutationQueueKeys,
  canonicalMutationQueuePaths,
  withLogicalMutationQueues,
  withMutationQueues,
} from "./apply-patch-engine/apply-patch-engine-mutation-queue.ts";
import {
  instructionForOperation,
  resolveOperations,
} from "./apply-patch-engine/apply-patch-engine-operation-semantics.ts";
import {
  parsePatchDocument,
  scanPatchInstructions,
} from "./apply-patch-engine/apply-patch-engine-parser.ts";
import {
  SemanticPlanner,
  SemanticPlanningError,
} from "./apply-patch-engine/apply-patch-engine-semantic-planner.ts";

export type { UpdateChunk, UpdateHunkLine } from "./apply-patch-matcher.ts";
export type {
  AppliedPatchChange,
  ApplyPatchDetails,
  ApplyPatchExecutionFilesystem,
  ApplyPatchExecutionHooks,
  ApplyPatchFailureDetails,
  ApplyPatchFinalPathState,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
  ApplyPatchInstructionReason,
  ApplyPatchInstructionReasonCode,
  ApplyPatchInstructionStatus,
  ApplyPatchFileEntryDetails,
  ParsedPatch,
  PatchOperation,
} from "./apply-patch-engine/apply-patch-engine-contracts.ts";
export {
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchParseError,
  ApplyPatchVerificationError,
} from "./apply-patch-engine/apply-patch-engine-errors.ts";
export { parsePatch, parsePatchDocument } from "./apply-patch-engine/apply-patch-engine-parser.ts";
export {
  cloneApplyPatchDetails,
  coalesceAppliedPatchChangesForRendering,
} from "./apply-patch-engine/apply-patch-engine-details.ts";
export {
  applyPatchHasOtherFilesystemChanges,
  applyPatchNeedsInstructionResults,
  applyPatchSummaryPaths,
  formatApplyPatchFailureHeading,
  formatApplyPatchFailureSummary,
  formatApplyPatchInstructionFeedback,
  formatApplyPatchInstructionLabel,
  formatApplyPatchInstructionResult,
  formatApplyPatchInstructionStatusLabel,
  formatApplyPatchModelOutput,
  formatApplyPatchSummary,
} from "./apply-patch-engine/apply-patch-engine-feedback.ts";

function parseFailureDetails(patch: string, error: unknown): ApplyPatchDetails {
  const scanned = scanPatchInstructions(patch);
  const lineNumber = error instanceof ApplyPatchParseError ? error.lineNumber : undefined;
  const failedInstruction =
    lineNumber === undefined
      ? undefined
      : scanned.findLast((instruction) => instruction.sourceLine <= lineNumber)?.index;
  return failedApplyPatchDetails("parse", errorMessage(error), scanned, failedInstruction);
}

function parseAndResolvePatch(cwd: string, patch: string): ResolvedOperation[] {
  const parsed = parsePatchDocument(patch);
  if (parsed.environmentId) {
    throw new ApplyPatchInputError(
      "apply_patch environment selection is unavailable for this turn",
    );
  }
  if (parsed.operations.length === 0) {
    throw new ApplyPatchInputError("patch rejected: empty patch");
  }
  return resolveOperations(cwd, parsed.operations);
}

async function buildPlan(
  operations: readonly ResolvedOperation[],
  signal?: AbortSignal,
  selectMoveStrategy?: ApplyPatchExecutionHooks["selectMoveStrategy"],
): Promise<SemanticPlan> {
  try {
    return await new SemanticPlanner(operations, signal, selectMoveStrategy).plan();
  } catch (error) {
    if (error instanceof ApplyPatchInputError) throw error;
    const message = errorMessage(error);
    const instructions =
      error instanceof SemanticPlanningError
        ? error.instructions
        : operations.map(instructionForOperation);
    const details = failedApplyPatchDetails(
      "preflight",
      message,
      instructions,
      error instanceof SemanticPlanningError ? error.failedInstruction : undefined,
      error instanceof SemanticPlanningError ? error.matcher : undefined,
    );
    throw new ApplyPatchVerificationError(`apply_patch verification failed: ${message}`, details);
  }
}

export async function previewPatch(cwd: string, patch: string): Promise<ApplyPatchDetails> {
  const operations = parseAndResolvePatch(cwd, patch);
  return previewDetailsForPlan(await buildPlan(operations), cwd);
}

export async function applyPatch(
  cwd: string,
  patch: string,
  signal?: AbortSignal,
  hooks: ApplyPatchExecutionHooks = {},
): Promise<ApplyPatchDetails> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    const message = errorMessage(error);
    throw new ApplyPatchInputError(
      message,
      failedApplyPatchDetails("input", message, scanPatchInstructions(patch)),
    );
  }
  let operations: ResolvedOperation[];
  try {
    operations = parseAndResolvePatch(cwd, patch);
  } catch (error) {
    if (error instanceof ApplyPatchInputError) {
      throw new ApplyPatchInputError(
        error.message,
        error.details ??
          failedApplyPatchDetails("input", error.message, scanPatchInstructions(patch)),
      );
    }
    const message = errorMessage(error);
    throw new ApplyPatchVerificationError(
      `apply_patch verification failed: ${message}`,
      parseFailureDetails(patch, error),
    );
  }

  try {
    const queueTargets = mutationQueueTargets(operations);
    const logicalKeys = await logicalMutationQueueKeys(queueTargets);
    const queuePaths = await canonicalMutationQueuePaths(queueTargets);
    const filesystem: ApplyPatchExecutionFilesystem = {
      ...DEFAULT_EXECUTION_FILESYSTEM,
      ...hooks.filesystem,
    };

    return await withLogicalMutationQueues(logicalKeys, () => {
      return withMutationQueues(queuePaths, async () => {
        throwIfAborted(signal);
        const plan = await buildPlan(operations, signal, hooks.selectMoveStrategy);
        throwIfAborted(signal);
        await hooks.onExecutionStart?.();
        return executePlan(plan, signal, filesystem, hooks.onProgress);
      });
    });
  } catch (error) {
    if (
      error instanceof ApplyPatchInputError ||
      error instanceof ApplyPatchVerificationError ||
      error instanceof ApplyPatchExecutionError
    ) {
      throw error;
    }
    const message = errorMessage(error);
    const details = failedApplyPatchDetails(
      "preflight",
      message,
      operations.map(instructionForOperation),
    );
    throw new ApplyPatchVerificationError(`apply_patch verification failed: ${message}`, details);
  }
}
