import { basename, dirname, resolve } from "node:path";
import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { isNotFound } from "./apply-patch-engine-errors.ts";
import {
  ABSENT_ENTRY,
  entryType,
  fingerprint,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";

export async function currentExecutionEntry(
  path: string,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<VirtualEntry> {
  try {
    const metadata = await filesystem.lstat(path);
    const entryFingerprint = fingerprint(metadata);
    if (metadata.isFile()) {
      return {
        kind: "regular",
        id: "",
        entryPath: path,
        entryName: basename(path),
        fingerprint: entryFingerprint,
        content: {},
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await filesystem.readlink(path);
      return {
        kind: "symlink",
        id: "",
        entryPath: path,
        entryName: basename(path),
        fingerprint: entryFingerprint,
        target,
        targetPath: resolve(dirname(path), target),
        content: {},
      };
    }
    if (metadata.isDirectory()) return { kind: "directory", fingerprint: entryFingerprint };
    return {
      kind: "unsupported",
      entryType: entryType(metadata),
      fingerprint: entryFingerprint,
    };
  } catch (error) {
    if (isNotFound(error)) return ABSENT_ENTRY;
    throw error;
  }
}
