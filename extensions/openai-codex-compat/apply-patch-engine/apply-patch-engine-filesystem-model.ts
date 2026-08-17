import type { Stats } from "node:fs";
import type {
  AppliedPatchChange,
  ApplyPatchInstructionDetails,
  ResolvedOperation,
} from "./apply-patch-engine-contracts.ts";

export const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type EntryFingerprint = {
  device: number;
  inode: number;
  mode: number;
  linkCount: number;
  size: number;
  modifiedMs: number;
};

export type KnownContent = {
  bytes: Buffer;
  text?: string;
};

export type PlannedEntryMutation = {
  path: string;
  key: string;
  kind: "absent" | "regular" | "symlink";
  releasedFingerprint?: EntryFingerprint;
};

export type CommittedEntryMutation = Omit<PlannedEntryMutation, "kind"> & {
  expected: VirtualEntry;
};

export type ContentCell = {
  value?: KnownContent;
  planned: boolean;
};

export type PhysicalFileState = {
  id: string;
  linkCount: number;
};

export type VirtualEntry =
  | { kind: "absent" }
  | { kind: "directory"; fingerprint?: EntryFingerprint }
  | { kind: "unsupported"; entryType: string; fingerprint: EntryFingerprint }
  | {
      kind: "regular";
      id: string;
      entryPath: string;
      sourcePath?: string;
      fingerprint?: EntryFingerprint;
      content: ContentCell;
      physical?: PhysicalFileState;
    }
  | {
      kind: "symlink";
      id: string;
      entryPath: string;
      sourcePath?: string;
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

export type ParentPlan = {
  createdPaths: string[];
  expectations: Array<{ path: string; kind: "absent" | "directory" | "directory-symlink" }>;
};

export type PlannedMutation = (
  | {
      kind: "add";
      operation: Extract<ResolvedOperation, { kind: "add" }>;
      expectedTarget: ReplaceableFileEntry;
      parents: ParentPlan;
      content: Buffer;
      replacementMode?: number;
      targetKey: string;
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "add" }>;
    }
  | {
      kind: "delete";
      operation: Extract<ResolvedOperation, { kind: "delete" }>;
      expectedTarget: ExistingFileEntry;
      targetKey: string;
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "delete" }>;
    }
  | {
      kind: "text-update";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedSource: ExistingFileEntry;
      expectedDestination?: ReplaceableFileEntry;
      parents: ParentPlan;
      content: Buffer;
      replacementMode?: number;
      sourceKey: string;
      destinationKey?: string;
      sameEntryMove?: "rename" | "satisfied";
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "update" }>;
      provisionalChange?: Extract<AppliedPatchChange, { kind: "add" | "update" }>;
    }
  | {
      kind: "move";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      expectedSource: ExistingFileEntry;
      expectedDestination: ReplaceableFileEntry;
      parents: ParentPlan;
      sourceKey: string;
      destinationKey: string;
      moveStrategy: "rename" | "copy-unlink";
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "move" }>;
    }
) & { instructionIndex: number };

export type SemanticPlan = {
  mutations: PlannedMutation[];
  exact: boolean;
  instructions: ApplyPatchInstructionDetails[];
};

export const ABSENT_ENTRY: VirtualEntry = { kind: "absent" };

export function fingerprint(metadata: Stats): EntryFingerprint {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
  };
}

export function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

export function sameFingerprintExceptLinkCount(
  left: EntryFingerprint,
  right: EntryFingerprint,
): boolean {
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
