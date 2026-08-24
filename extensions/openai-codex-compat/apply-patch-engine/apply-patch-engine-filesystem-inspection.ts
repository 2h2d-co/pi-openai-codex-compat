import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { isNotFound } from "./apply-patch-engine-errors.ts";
import {
  entryType,
  fingerprint,
  type EntryFingerprint,
} from "./apply-patch-engine-filesystem-model.ts";

export type CurrentFilesystemEntry =
  | { kind: "absent" }
  | { kind: "directory" }
  | { kind: "unsupported"; entryType: string }
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
    if (metadata.isFile()) {
      return {
        kind: "regular",
        fingerprint: fingerprint(metadata),
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await filesystem.readlink(path);
      return {
        kind: "symlink",
        fingerprint: fingerprint(metadata),
        target,
      };
    }
    if (metadata.isDirectory()) return { kind: "directory" };
    return {
      kind: "unsupported",
      entryType: entryType(metadata),
    };
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    throw error;
  }
}
