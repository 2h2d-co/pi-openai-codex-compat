import type {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { UpdateChunk } from "../apply-patch-matcher.ts";
import type { ApplyPatchDetails } from "./apply-patch-engine-details-schema.ts";

export type {
  AppliedPatchChange,
  ApplyPatchDetails,
  ApplyPatchFailureDetails,
  ApplyPatchFileEntryDetails,
  ApplyPatchFinalPathState,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionEffect,
  ApplyPatchInstructionReason,
  ApplyPatchInstructionReasonCode,
  ApplyPatchInstructionStatus,
} from "./apply-patch-engine-details-schema.ts";

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export type ParsedPatch = {
  patch: string;
  operations: PatchOperation[];
  environmentId?: string;
};

type ResolvedUpdateBase = {
  kind: "update";
  path: string;
  absolutePath: string;
  chunks: UpdateChunk[];
};

export type ResolvedTextUpdateOperation = ResolvedUpdateBase & {
  moveTo?: never;
  moveAbsolutePath?: never;
};

export type ResolvedMoveUpdateOperation = ResolvedUpdateBase & {
  moveTo: string;
  moveAbsolutePath: string;
};

export type ResolvedUpdateOperation = ResolvedTextUpdateOperation | ResolvedMoveUpdateOperation;

export type ResolvedOperation =
  | { kind: "add"; path: string; absolutePath: string; content: string }
  | { kind: "delete"; path: string; absolutePath: string }
  | ResolvedUpdateOperation;

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
  lstat: (path: string) => Promise<Stats>;
  mkdir: typeof mkdir;
  readFile: (path: string) => Promise<Buffer>;
  readlink: typeof readlink;
  readdir: typeof readdir;
  rename: typeof rename;
  symlink: typeof symlink;
  unlink: typeof unlink;
  utimes: typeof utimes;
  writeFile: typeof writeFile;
};
