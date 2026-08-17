import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { hasErrorCode, isNotFound } from "./apply-patch-engine-errors.ts";

export function normalizedAliasName(name: string): string {
  return process.platform === "darwin" ? name.normalize("NFD") : name;
}

export async function directoryIsCaseInsensitive(
  directory: string,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  let cached = cache.get(directory);
  if (!cached) {
    cached = (async () => {
      if (process.platform === "win32") return true;
      let candidate = directory;
      while (candidate !== parse(candidate).root) {
        const name = basename(candidate);
        const toggled = Array.from(name)
          .map((character) =>
            character.toLowerCase() === character
              ? character.toUpperCase()
              : character.toLowerCase(),
          )
          .join("");
        if (toggled !== name) {
          try {
            const [original, alias] = await Promise.all([
              lstat(candidate),
              lstat(join(dirname(candidate), toggled)),
            ]);
            return original.dev === alias.dev && original.ino === alias.ino;
          } catch {
            candidate = dirname(candidate);
            continue;
          }
        }
        candidate = dirname(candidate);
      }
      return false;
    })();
    cache.set(directory, cached);
  }
  return cached;
}

export async function namesAlias(
  directory: string,
  left: string,
  right: string,
  caseInsensitiveDirectories: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const normalizedLeft = normalizedAliasName(left);
  const normalizedRight = normalizedAliasName(right);
  if (normalizedLeft === normalizedRight) return true;
  return (
    (await directoryIsCaseInsensitive(directory, caseInsensitiveDirectories)) &&
    normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  );
}

export async function realpathWithMissingTail(path: string): Promise<string> {
  const missingNames: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return join(await realpath(candidate), ...missingNames.toReversed());
    } catch (error) {
      if (!isNotFound(error) && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(path);
    missingNames.push(basename(candidate));
    candidate = parent;
  }
}
