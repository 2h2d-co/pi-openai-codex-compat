import { basename, dirname, resolve } from "node:path";
import type { ApplyPatchExecutionFilesystem } from "./apply-patch-engine-contracts.ts";
import { hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import {
  ABSENT_ENTRY,
  buffersEqual,
  entryType,
  fingerprint,
  sameFingerprint,
  sameFingerprintExceptLinkCount,
  samePhysicalEntry,
  type EntryCommitEvidence,
  type ExistingFileEntry,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";

export function commitEvidenceForExistingEntry(
  entry: ExistingFileEntry,
  fingerprintMatch: "exact" | "except-link-count",
): Extract<EntryCommitEvidence, { kind: "regular" | "symlink" }> {
  if (!entry.fingerprint) {
    throw new Error(`Cannot verify commit continuity for ${entry.entryPath}`);
  }
  if (entry.kind === "symlink") {
    const evidence: Extract<EntryCommitEvidence, { kind: "symlink" }> = {
      kind: "symlink",
      fingerprint: entry.fingerprint,
      fingerprintMatch,
      exactSpelling: true,
      target: entry.target,
    };
    if (entry.content.planned && entry.content.value) {
      evidence.content = entry.content.value.bytes;
    }
    return evidence;
  }
  const evidence: Extract<EntryCommitEvidence, { kind: "regular" }> = {
    kind: "regular",
    fingerprint: entry.fingerprint,
    fingerprintMatch,
    exactSpelling: true,
  };
  if (entry.content.planned && entry.content.value) {
    evidence.content = entry.content.value.bytes;
  }
  return evidence;
}

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
        content: { planned: false },
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
        content: { planned: false },
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

function fingerprintMatches(
  actual: VirtualEntry,
  evidence: Exclude<EntryCommitEvidence, { kind: "absent" }>,
): boolean {
  if (!("fingerprint" in actual) || !actual.fingerprint) return false;
  switch (evidence.fingerprintMatch) {
    case "exact":
      return sameFingerprint(actual.fingerprint, evidence.fingerprint);
    case "except-link-count":
      return sameFingerprintExceptLinkCount(actual.fingerprint, evidence.fingerprint);
    case "physical":
      return samePhysicalEntry(actual.fingerprint, evidence.fingerprint);
  }
}

export async function entryMatchesCommitEvidence(
  path: string,
  actual: VirtualEntry,
  evidence: EntryCommitEvidence,
  filesystem: ApplyPatchExecutionFilesystem,
): Promise<boolean> {
  if (actual.kind !== evidence.kind) return false;
  if (evidence.kind === "absent") return true;
  if (!fingerprintMatches(actual, evidence)) return false;
  if (evidence.kind === "symlink") {
    if (actual.kind !== "symlink" || actual.target !== evidence.target) return false;
    if (evidence.content) {
      return buffersEqual(await filesystem.readFile(path), evidence.content);
    }
    return true;
  }
  if (evidence.kind === "regular" && evidence.content) {
    try {
      return buffersEqual(await filesystem.readFile(path), evidence.content);
    } catch (error) {
      if (!hasErrorCode(error, "EACCES") && !hasErrorCode(error, "EPERM")) throw error;
    }
  }
  return true;
}

export function committedEntryFromEvidence(
  actual: VirtualEntry,
  evidence: EntryCommitEvidence,
): VirtualEntry {
  if (actual.kind !== "regular" || evidence.kind !== "regular" || !evidence.content) {
    return actual;
  }
  return {
    ...actual,
    content: {
      planned: true,
      value: { bytes: evidence.content },
    },
  };
}
