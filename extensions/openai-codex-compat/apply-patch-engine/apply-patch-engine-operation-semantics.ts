import { isAbsolute, relative, resolve, sep } from "node:path";
import type { UpdateChunk } from "../apply-patch-matcher.ts";
import type {
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionReason,
  ApplyPatchInstructionReasonCode,
  PatchOperation,
  ResolvedMoveUpdateOperation,
  ResolvedOperation,
  ResolvedUpdateOperation,
} from "./apply-patch-engine-contracts.ts";

export function resolvePatchPath(cwd: string, patchPath: string): string {
  return isAbsolute(patchPath) ? resolve(patchPath) : resolve(cwd, patchPath);
}

export function resolveOperations(
  cwd: string,
  operations: readonly PatchOperation[],
): ResolvedOperation[] {
  return operations.map((operation) => {
    const absolutePath = resolvePatchPath(cwd, operation.path);
    if (operation.kind !== "update") {
      return { ...operation, absolutePath };
    }
    if (!operation.moveTo) {
      return {
        kind: "update",
        path: operation.path,
        absolutePath,
        chunks: operation.chunks,
      };
    }
    return {
      kind: "update",
      path: operation.path,
      absolutePath,
      chunks: operation.chunks,
      moveTo: operation.moveTo,
      moveAbsolutePath: resolvePatchPath(cwd, operation.moveTo),
    };
  });
}

export function chunksAreIdentity(chunks: readonly UpdateChunk[]): boolean {
  return chunks.every(
    (chunk) =>
      chunk.oldLines.length === chunk.newLines.length &&
      chunk.oldLines.every((line, index) => line === chunk.newLines[index]),
  );
}

export function pathIsRelated(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isWithin = (value: string): boolean =>
    value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  return leftToRight === "" || isWithin(leftToRight) || isWithin(rightToLeft);
}

export function resolvedUpdateHasMove(
  operation: ResolvedUpdateOperation,
): operation is ResolvedMoveUpdateOperation {
  return operation.moveAbsolutePath !== undefined;
}

export function semanticMoveOperation(
  operation: ResolvedUpdateOperation,
): ResolvedMoveUpdateOperation | undefined {
  return resolvedUpdateHasMove(operation) && operation.moveAbsolutePath !== operation.absolutePath
    ? operation
    : undefined;
}

export function instructionReason(
  code: Exclude<ApplyPatchInstructionReasonCode, "move-already-fulfilled">,
  relatedInstructions: readonly number[] = [],
): ApplyPatchInstructionReason {
  switch (code) {
    case "empty-update":
      return { code, message: "The instruction contains no changes." };
    case "identity-update":
      return { code, message: "Old and replacement content are identical." };
    case "content-already-present":
      return { code, message: "The file already contains the requested content byte-for-byte." };
    case "update-result-unchanged":
      return { code, message: "Applying the update would not change the file." };
    case "path-already-absent":
      return { code, message: "Path already absent." };
    case "same-entry-move":
      return { code, message: "Source and destination identify the same entry." };
    case "dead-dominated": {
      const instructions = [...new Set(relatedInstructions)].toSorted(
        (left, right) => left - right,
      );
      const noun = instructions.length === 1 ? "instruction" : "instructions";
      return {
        code,
        message: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${instructions.join(", ")} ${instructions.length === 1 ? "determines" : "determine"} the final filesystem state before another instruction reads it.`,
        dominatingInstructions: instructions,
        relatedInstructions: instructions,
      };
    }
  }
}

export function moveAlreadyFulfilledReason(instruction: number): ApplyPatchInstructionReason {
  return {
    code: "move-already-fulfilled",
    message: `Instruction ${instruction} already moved this entry.`,
    relatedInstructions: [instruction],
  };
}

export function instructionForOperation(
  operation: ResolvedOperation,
  index: number,
): ApplyPatchInstructionDetails {
  if (operation.kind === "update") {
    const instruction: ApplyPatchInstructionDetails = {
      index: index + 1,
      kind: operation.moveTo && chunksAreIdentity(operation.chunks) ? "move" : "update",
      path: operation.path,
      status: "not-run",
    };
    if (operation.moveTo) instruction.moveTo = operation.moveTo;
    return instruction;
  }
  return {
    index: index + 1,
    kind: operation.kind,
    path: operation.path,
    status: "not-run",
  };
}
