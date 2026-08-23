import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { isNotFound } from "./apply-patch-engine-errors.ts";
import {
  entryType,
  fingerprint,
  type EntryFingerprint,
} from "./apply-patch-engine-filesystem-model.ts";

export type CurrentFilesystemEntry =
  | { kind: "absent" }
  | { kind: "directory"; fingerprint: EntryFingerprint }
  | { kind: "unsupported"; entryType: string; fingerprint: EntryFingerprint }
  | { kind: "regular"; fingerprint: EntryFingerprint }
  | {
      kind: "symlink";
      fingerprint: EntryFingerprint;
      target: string;
    };

export async function currentExecutionEntry(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<CurrentFilesystemEntry> {
  try {
    const metadata = await filesystem.lstat(path);
    const entryFingerprint = fingerprint(metadata);
    if (metadata.isFile()) {
      return {
        kind: "regular",
        fingerprint: entryFingerprint,
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await filesystem.readlink(path);
      return {
        kind: "symlink",
        fingerprint: entryFingerprint,
        target,
      };
    }
    if (metadata.isDirectory()) return { kind: "directory", fingerprint: entryFingerprint };
    return {
      kind: "unsupported",
      entryType: entryType(metadata),
      fingerprint: entryFingerprint,
    };
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    throw error;
  }
}
