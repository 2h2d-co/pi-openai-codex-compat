import type { Stats } from "node:fs";
import type {
  AppliedPatchChange,
  ApplyPatchInstructionDetails,
  ResolvedMoveUpdateOperation,
  ResolvedOperation,
} from "./apply-patch-engine-contracts.ts";

export const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type EntryFingerprint = {
  device: number;
  inode: number;
  mode: number;
  size: number;
  modifiedMs: number;
};

export type KnownContent = {
  bytes: Buffer;
  text?: string;
};

export type ContentCell = {
  value?: KnownContent;
};

export type PhysicalFileState = {
  linkCount: number;
  mode: number;
};

export type VirtualEntry =
  | { kind: "absent" }
  | { kind: "directory"; fingerprint?: EntryFingerprint }
  | { kind: "unsupported"; entryType: string }
  | {
      kind: "regular";
      entryName: string;
      sourcePath?: string;
      fingerprint?: EntryFingerprint;
      content: ContentCell;
      physical: PhysicalFileState;
    }
  | {
      kind: "symlink";
      entryPath: string;
      entryName: string;
      fingerprint?: EntryFingerprint;
      target: string;
      targetPath: string;
      content: ContentCell;
    };

export type ExistingFileEntry = Extract<VirtualEntry, { kind: "regular" | "symlink" }>;

export type ReplaceableFileEntry = Extract<
  VirtualEntry,
  { kind: "absent" | "regular" | "symlink" }
>;

type PlannedTextUpdateBase = {
  kind: "text-update";
  expectedSource: ExistingFileEntry;
  createdParentPaths: string[];
  content: Buffer;
  change: Extract<AppliedPatchChange, { kind: "update" }>;
};

type PlannedTextUpdate =
  | (PlannedTextUpdateBase & {
      moveMode: "none";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedDestination?: never;
      sameEntryMove?: never;
      provisionalChange?: never;
    })
  | (PlannedTextUpdateBase & {
      moveMode: "same-entry";
      operation: ResolvedMoveUpdateOperation;
      expectedDestination: ExistingFileEntry;
      sameEntryMove: "rename" | "satisfied";
      provisionalChange: Extract<AppliedPatchChange, { kind: "update" }>;
    })
  | (PlannedTextUpdateBase & {
      moveMode: "destination";
      operation: ResolvedMoveUpdateOperation;
      expectedDestination: ReplaceableFileEntry;
      sameEntryMove?: never;
      provisionalChange: Extract<AppliedPatchChange, { kind: "add" }>;
    });

export type PlannedMutation = (
  | {
      kind: "add";
      operation: Extract<ResolvedOperation, { kind: "add" }>;
      expectedTarget: ReplaceableFileEntry;
      createdParentPaths: string[];
      content: Buffer;
      change: Extract<AppliedPatchChange, { kind: "add" }>;
    }
  | {
      kind: "delete";
      operation: Extract<ResolvedOperation, { kind: "delete" }>;
      expectedTarget: ExistingFileEntry;
      change: Extract<AppliedPatchChange, { kind: "delete" }>;
    }
  | PlannedTextUpdate
  | {
      kind: "move";
      operation: ResolvedMoveUpdateOperation;
      expectedSource: ExistingFileEntry;
      expectedDestination: ReplaceableFileEntry;
      createdParentPaths: string[];
      moveStrategy: "rename" | "copy-unlink";
      change: Extract<AppliedPatchChange, { kind: "move" }>;
    }
) & {
  instructionIndex: number;
};

export type PlannedAction =
  | PlannedMutation
  | {
      kind: "no-change";
      instructionIndex: number;
    };

export type SemanticPlan = {
  actions: PlannedAction[];
  exact: boolean;
  instructions: ApplyPatchInstructionDetails[];
};

export const ABSENT_ENTRY: VirtualEntry = { kind: "absent" };

export function fingerprint(metadata: Stats): EntryFingerprint {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
  };
}

export function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

export function samePhysicalEntry(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function entryType(metadata: Stats): string {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isSocket()) return "socket";
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isCharacterDevice()) return "character device";
  if (metadata.isBlockDevice()) return "block device";
  return "special file";
}

export function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}
