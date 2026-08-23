import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ResolvedOperation } from "./apply-patch-engine-contracts.ts";
import { hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import { updateRequiresTextValidation } from "./apply-patch-engine-operation-semantics.ts";
import {
  normalizedAliasName,
  realpathWithMissingTail,
} from "./apply-patch-engine-path-identity.ts";

export async function withMutationQueues<T>(
  paths: readonly string[],
  callback: () => Promise<T>,
  index = 0,
): Promise<T> {
  const path = paths[index];
  if (!path) return callback();
  return withFileMutationQueue(path, () => withMutationQueues(paths, callback, index + 1));
}

export type MutationQueueTarget = {
  path: string;
  followSymlink: boolean;
};

export type CanonicalMutationQueuePathOperations = {
  lstat: (path: string) => Promise<{ isSymbolicLink: () => boolean }>;
  realpath: (path: string) => Promise<string>;
  realpathWithMissingTail: (path: string) => Promise<string>;
  symlinkEntryQueuePath: (path: string) => Promise<string>;
};

export function mutationQueueTargets(
  operations: readonly ResolvedOperation[],
): MutationQueueTarget[] {
  return operations.flatMap((operation) => {
    if (operation.kind !== "update") {
      return [{ path: operation.absolutePath, followSymlink: false }];
    }
    const followsSymlink = updateRequiresTextValidation(operation);
    const targets: MutationQueueTarget[] = operation.moveAbsolutePath
      ? [{ path: operation.absolutePath, followSymlink: false }]
      : [{ path: operation.absolutePath, followSymlink: followsSymlink }];
    if (operation.moveAbsolutePath && followsSymlink) {
      targets.push({ path: operation.absolutePath, followSymlink: true });
    }
    if (operation.moveAbsolutePath) {
      targets.push({ path: operation.moveAbsolutePath, followSymlink: false });
    }
    return targets;
  });
}

export async function symlinkEntryQueuePath(path: string): Promise<string> {
  const parent = await realpathWithMissingTail(dirname(path));
  return join(parent, ".apply-patch-entry-locks", normalizedAliasName(basename(path)));
}

const canonicalMutationQueuePathOperations: CanonicalMutationQueuePathOperations = {
  lstat,
  realpath,
  realpathWithMissingTail,
  symlinkEntryQueuePath,
};

export async function canonicalMutationQueuePaths(
  targets: readonly MutationQueueTarget[],
  operations = canonicalMutationQueuePathOperations,
): Promise<string[]> {
  const canonicalPaths = await Promise.all(
    targets.map(async ({ path, followSymlink }) => {
      let isSymlink = false;
      try {
        const metadata = await operations.lstat(path);
        isSymlink = metadata.isSymbolicLink();
        if (isSymlink && !followSymlink) {
          return await operations.symlinkEntryQueuePath(path);
        }
      } catch (error) {
        if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
      }
      try {
        return await operations.realpath(path);
      } catch (error) {
        if (isNotFound(error) || hasErrorCode(error, "ENOTDIR")) {
          return operations.realpathWithMissingTail(path);
        }
        if (isSymlink) return await operations.symlinkEntryQueuePath(path);
        throw error;
      }
    }),
  );
  return [...new Set(canonicalPaths)].sort();
}
