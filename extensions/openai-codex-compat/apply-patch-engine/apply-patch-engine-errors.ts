import { hasObjectType } from "../value-contracts.ts";
import type { ApplyPatchDetails } from "./apply-patch-engine-contracts.ts";

export class ApplyPatchParseError extends Error {
  readonly kind: "patch" | "hunk";
  readonly lineNumber: number | undefined;

  constructor(kind: "patch" | "hunk", message: string, lineNumber?: number) {
    super(
      kind === "patch"
        ? `invalid patch: ${message}`
        : `invalid hunk at line ${lineNumber}, ${message}`,
    );
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

export class ApplyPatchInputError extends Error {
  readonly details: ApplyPatchDetails | undefined;

  constructor(message: string, details?: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

export class ApplyPatchVerificationError extends Error {
  readonly details: ApplyPatchDetails;

  constructor(message: string, details: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

export class ApplyPatchExecutionError extends Error {
  readonly details: ApplyPatchDetails;

  constructor(message: string, details: ApplyPatchDetails) {
    super(message);
    this.details = details;
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return hasObjectType(error) && error !== null && "code" in error && error.code === code;
}

export function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("apply_patch was cancelled.");
}
