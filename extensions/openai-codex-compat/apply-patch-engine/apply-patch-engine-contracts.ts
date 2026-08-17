import type {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { FormatterMatchFailureDetails, UpdateChunk } from "../apply-patch-matcher.ts";

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export type ParsedPatch = {
  patch: string;
  operations: PatchOperation[];
  environmentId?: string;
};

export type AppliedPatchChange =
  | {
      kind: "add";
      path: string;
      content: string;
      overwrittenContent?: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: "delete";
      path: string;
      entryType: "regular-file" | "symlink";
      content?: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      oldContent: string;
      newContent: string;
      overwrittenMoveContent?: string;
      displayDiff: string;
      additions: number;
      deletions: number;
    }
  | {
      kind: "move";
      sourcePath: string;
      destinationPath: string;
      replacedDestination: boolean;
      entryType: "regular-file" | "symlink";
      exact: boolean;
      displayDiff: "";
      additions: 0;
      deletions: 0;
    };

export type ApplyPatchInstructionStatus =
  | "applied"
  | "planned"
  | "no-op"
  | "dead"
  | "failed"
  | "not-run";

export type ApplyPatchInstructionReasonCode =
  | "empty-update"
  | "identity-update"
  | "content-already-present"
  | "update-result-unchanged"
  | "path-already-absent"
  | "same-entry-move"
  | "move-already-fulfilled"
  | "dead-dominated";

export type ApplyPatchInstructionReason = {
  code: ApplyPatchInstructionReasonCode;
  message: string;
  dominatingInstructions?: number[];
  relatedInstructions?: number[];
};

export type ApplyPatchFileEntryDetails =
  | { entryType: "regular-file" }
  | { entryType: "symlink"; target: string };

export type ApplyPatchInstructionEffect =
  | {
      kind: "created" | "updated" | "deleted" | "directory-created" | "temporary-entry-remains";
      path: string;
    }
  | {
      kind: "replaced";
      path: string;
      previousEntry: ApplyPatchFileEntryDetails;
      replacementEntry: ApplyPatchFileEntryDetails;
    }
  | { kind: "source-remains"; path: string }
  | {
      kind: "symlink-removed" | "symlink-moved";
      path: string;
      target: string;
    }
  | { kind: "symlink-target-modified"; path: string; target: string };

export type ApplyPatchFinalPathState = {
  path: string;
  state:
    | "absent"
    | "regular-file"
    | "symlink"
    | "directory"
    | "other-entry"
    | "unchanged"
    | "requested-content"
    | "different-from-requested-content"
    | "different-from-requested-and-previous-content"
    | "different-from-previous-content"
    | "different-entry"
    | "different-entry-type"
    | "not-verified";
};

export type ApplyPatchInstructionDetails = {
  index: number;
  kind: "add" | "delete" | "update" | "move";
  path: string;
  moveTo?: string;
  status: ApplyPatchInstructionStatus;
  reason?: ApplyPatchInstructionReason;
  effects?: ApplyPatchInstructionEffect[];
  finalStates?: ApplyPatchFinalPathState[];
  matcher?: FormatterMatchFailureDetails;
  changeIndexes?: number[];
  error?: string;
};

export type ApplyPatchFailureDetails = {
  phase: "input" | "parse" | "preflight" | "execution";
  message: string;
  failedInstruction?: number;
  matcher?: FormatterMatchFailureDetails;
};

export type ApplyPatchDetails = {
  status: "completed" | "failed";
  exact: boolean;
  changes: AppliedPatchChange[];
  added: string[];
  modified: string[];
  deleted: string[];
  instructions?: ApplyPatchInstructionDetails[];
  failure?: ApplyPatchFailureDetails;
  error?: string;
};

export type ResolvedOperation =
  | { kind: "add"; path: string; absolutePath: string; content: string }
  | { kind: "delete"; path: string; absolutePath: string }
  | {
      kind: "update";
      path: string;
      absolutePath: string;
      moveTo?: string;
      moveAbsolutePath?: string;
      chunks: UpdateChunk[];
    };

export type ApplyPatchExecutionHooks = {
  onExecutionStart?: () => void | Promise<void>;
  onProgress?: (details: ApplyPatchDetails) => void;
  selectMoveStrategy?: (
    sourcePath: string,
    destinationPath: string,
    detected: "rename" | "copy-unlink",
  ) => "rename" | "copy-unlink" | Promise<"rename" | "copy-unlink">;
  filesystem?: Partial<ApplyPatchExecutionFilesystem>;
};

export type ApplyPatchExecutionFilesystem = {
  chmod: typeof chmod;
  copyFile: typeof copyFile;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readlink: typeof readlink;
  readdir: typeof readdir;
  rename: typeof rename;
  symlink: typeof symlink;
  unlink: typeof unlink;
  utimes: typeof utimes;
  writeFile: typeof writeFile;
};
