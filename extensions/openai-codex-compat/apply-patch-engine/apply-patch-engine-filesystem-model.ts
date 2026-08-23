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
  kind: "absent" | "directory" | "regular" | "symlink";
};

export type CommittedEntryMutation = Omit<PlannedEntryMutation, "kind"> & {
  expected: VirtualEntry;
  mutationIndex: number;
};

export type PlannedPhysicalLinkDelta = {
  fingerprint: EntryFingerprint;
  delta: number;
};

export type CommittedPhysicalLinkDelta = PlannedPhysicalLinkDelta & {
  mutationIndex: number;
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

export type RouteEntryExpectation = {
  path: string;
  key: string;
  expected: Extract<VirtualEntry, { kind: "directory" | "symlink" }>;
};

export type InPlaceWritePlan = {
  route: RouteEntryExpectation[];
  targetPath: string;
  targetKey: string;
  expectedTarget: Extract<VirtualEntry, { kind: "regular" }>;
};

type PlannedTextUpdateBase = {
  kind: "text-update";
  expectedSource: ExistingFileEntry;
  parents: ParentPlan;
  content: Buffer;
  replacementMode?: number;
  sourceKey: string;
  entryMutations: PlannedEntryMutation[];
  change: Extract<AppliedPatchChange, { kind: "update" }>;
};

type PlannedTextUpdate =
  | (PlannedTextUpdateBase & {
      moveMode: "none";
      operation: Extract<ResolvedOperation, { kind: "update" }>;
      writePlan: InPlaceWritePlan;
      expectedDestination?: never;
      destinationKey?: never;
      sameEntryMove?: never;
      provisionalChange?: never;
    })
  | (PlannedTextUpdateBase & {
      moveMode: "same-entry";
      operation: ResolvedMoveUpdateOperation;
      writePlan?: never;
      expectedDestination: ExistingFileEntry;
      destinationKey: string;
      sameEntryMove: "rename" | "satisfied";
      provisionalChange: Extract<AppliedPatchChange, { kind: "update" }>;
    })
  | (PlannedTextUpdateBase & {
      moveMode: "destination";
      operation: ResolvedMoveUpdateOperation;
      writePlan?: never;
      expectedDestination: ReplaceableFileEntry;
      destinationKey: string;
      sameEntryMove?: never;
      provisionalChange: Extract<AppliedPatchChange, { kind: "add" }>;
    });

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
  | PlannedTextUpdate
  | {
      kind: "move";
      operation: ResolvedMoveUpdateOperation;
      expectedSource: ExistingFileEntry;
      expectedDestination: ReplaceableFileEntry;
      parents: ParentPlan;
      sourceKey: string;
      destinationKey: string;
      moveStrategy: "rename" | "copy-unlink";
      entryMutations: PlannedEntryMutation[];
      change: Extract<AppliedPatchChange, { kind: "move" }>;
    }
) & {
  instructionIndex: number;
  physicalLinkDeltas: PlannedPhysicalLinkDelta[];
};

export type PlannedNoChangeAssertion =
  | {
      kind: "identical-add";
      instructionIndex: number;
      operation: Extract<ResolvedOperation, { kind: "add" }>;
      content: Buffer;
    }
  | {
      kind: "absent-delete";
      instructionIndex: number;
      operation: Extract<ResolvedOperation, { kind: "delete" }>;
    }
  | {
      kind: "unchanged-update";
      instructionIndex: number;
      operation: Extract<ResolvedOperation, { kind: "update" }>;
    }
  | {
      kind: "same-entry-move";
      instructionIndex: number;
      operation: ResolvedMoveUpdateOperation;
    }
  | {
      kind: "fulfilled-move";
      instructionIndex: number;
      operation: ResolvedMoveUpdateOperation;
      sourceKey: string;
      destinationKey: string;
      expectedDestination: ExistingFileEntry;
    };

export type SemanticPlan = {
  mutations: PlannedMutation[];
  noChangeAssertions: PlannedNoChangeAssertion[];
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
