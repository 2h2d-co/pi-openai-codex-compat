import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ResolvedOperation } from "./apply-patch-engine-contracts.ts";
import { hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";
import { chunksAreIdentity } from "./apply-patch-engine-operation-semantics.ts";
import {
  directoryIsCaseInsensitive,
  namesAlias,
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

export const logicalMutationQueues = new Map<string, Promise<void>>();

export let logicalQueueRegistration = Promise.resolve();

export async function withLogicalMutationQueue<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const registration = logicalQueueRegistration.then(() => {
    const currentQueue = logicalMutationQueues.get(key) ?? Promise.resolve();
    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    logicalMutationQueues.set(key, chainedQueue);
    return { currentQueue, chainedQueue, releaseNext };
  });
  logicalQueueRegistration = registration.then(
    () => undefined,
    () => undefined,
  );
  const { currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await callback();
  } finally {
    releaseNext();
    if (logicalMutationQueues.get(key) === chainedQueue) logicalMutationQueues.delete(key);
  }
}

export async function withLogicalMutationQueues<T>(
  keys: readonly string[],
  callback: () => Promise<T>,
  index = 0,
): Promise<T> {
  const key = keys[index];
  if (!key) return callback();
  return withLogicalMutationQueue(key, () => withLogicalMutationQueues(keys, callback, index + 1));
}

export async function logicalEntryQueueKey(
  path: string,
  caseInsensitiveDirectories: Map<string, Promise<boolean>>,
): Promise<string> {
  const parent = await realpathWithMissingTail(dirname(path));
  const requestedName = basename(path);
  let entryName = requestedName;
  try {
    const requestedMetadata = await lstat(path);
    for (const name of await readdir(parent)) {
      if (!(await namesAlias(parent, name, requestedName, caseInsensitiveDirectories))) {
        continue;
      }
      const metadata = await lstat(join(parent, name));
      if (metadata.dev === requestedMetadata.dev && metadata.ino === requestedMetadata.ino) {
        entryName = name;
        break;
      }
    }
  } catch (error) {
    if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
  }
  entryName = normalizedAliasName(entryName);
  if (await directoryIsCaseInsensitive(parent, caseInsensitiveDirectories)) {
    entryName = entryName.toLowerCase();
  }
  return `entry:${join(parent, entryName)}`;
}

export type MutationQueueTarget = {
  path: string;
  followSymlink: boolean;
};

export function mutationQueueTargets(
  operations: readonly ResolvedOperation[],
): MutationQueueTarget[] {
  return operations.flatMap((operation) => {
    if (operation.kind !== "update") {
      return [{ path: operation.absolutePath, followSymlink: false }];
    }
    const targets: MutationQueueTarget[] = [
      {
        path: operation.absolutePath,
        followSymlink: !chunksAreIdentity(operation.chunks),
      },
    ];
    if (operation.moveAbsolutePath) {
      targets.push({ path: operation.moveAbsolutePath, followSymlink: false });
    }
    return targets;
  });
}

export async function logicalMutationQueueKeys(
  targets: readonly MutationQueueTarget[],
): Promise<string[]> {
  const caseInsensitiveDirectories = new Map<string, Promise<boolean>>();
  const keys = new Set<string>();
  for (const { path, followSymlink } of targets) {
    keys.add(await logicalEntryQueueKey(path, caseInsensitiveDirectories));
    try {
      const entryMetadata = await lstat(path);
      if (entryMetadata.isFile()) {
        keys.add(`physical:${entryMetadata.dev}:${entryMetadata.ino}`);
      } else if (entryMetadata.isSymbolicLink() && followSymlink) {
        try {
          const targetMetadata = await stat(path);
          if (targetMetadata.isFile()) {
            keys.add(`physical:${targetMetadata.dev}:${targetMetadata.ino}`);
          }
          // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Queue-key discovery is best-effort; the semantic planner reports inaccessible or invalid targets.
        } catch {
          // The semantic planner reports inaccessible, dangling, or cyclic targets.
        }
      }
    } catch (error) {
      if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
  }
  return [...keys].sort();
}

export async function symlinkEntryQueuePath(path: string): Promise<string> {
  const parent = await realpathWithMissingTail(dirname(path));
  return join(parent, ".apply-patch-entry-locks", normalizedAliasName(basename(path)));
}

export async function canonicalMutationQueuePaths(
  targets: readonly MutationQueueTarget[],
): Promise<string[]> {
  const canonicalPaths = await Promise.all(
    targets.map(async ({ path, followSymlink }) => {
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() && !followSymlink) {
          return symlinkEntryQueuePath(path);
        }
      } catch (error) {
        if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
      }
      try {
        return await realpath(path);
      } catch (error) {
        if (isNotFound(error) || hasErrorCode(error, "ENOTDIR")) {
          return realpathWithMissingTail(path);
        }
        try {
          if ((await lstat(path)).isSymbolicLink()) {
            return symlinkEntryQueuePath(path);
          }
          // oxlint-disable-next-line 2h2d/no-silent-error-suppression -- Symlink inspection is best-effort while preserving the primary canonicalization failure.
        } catch {}
        throw error;
      }
    }),
  );
  return [...new Set(canonicalPaths)].sort();
}
