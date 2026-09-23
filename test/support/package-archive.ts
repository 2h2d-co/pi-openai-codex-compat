import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireJsonRecords } from "../../extensions/openai-codex-compat/codex-protocol.ts";

export type PackageArchive = {
  /** Absolute path of the archive under test. */
  path: string;
  /** Sorted member paths reported by `tar -tzf`. */
  files: string[];
};

/**
 * Resolve the npm archive a packaged-CLI test loads.
 *
 * A supplied candidate (the `PI_CODEX_PACKAGE_ARCHIVE` value) resolves against
 * the working directory, must be an existing regular file, and must list as a
 * gzip tarball. An empty, missing, directory, or unreadable candidate fails
 * here; it never falls back to packing the worktree. Without a candidate the
 * worktree at `root` is packed into `temporary`.
 */
export async function packageArchive(
  root: string,
  temporary: string,
  supplied: string | undefined,
): Promise<PackageArchive> {
  let archive: string;
  if (supplied !== undefined) {
    assert.ok(supplied.length > 0, "PI_CODEX_PACKAGE_ARCHIVE must not be empty.");
    const candidate = resolve(process.cwd(), supplied);
    assert.ok(
      (await stat(candidate)).isFile(),
      `PI_CODEX_PACKAGE_ARCHIVE ${candidate} is not a regular file.`,
    );
    archive = await realpath(candidate);
  } else {
    const packed = requireJsonRecords(
      JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--allow-directory=all",
            "--pack-destination",
            temporary,
          ],
          { cwd: root, encoding: "utf8" },
        ),
      ),
    );
    assert.equal(packed.length, 1);
    const filename = packed[0]?.["filename"];
    assert.ok(typeof filename === "string");
    archive = join(temporary, filename);
  }
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", stdio: "pipe" })
    .trim()
    .split("\n")
    .sort();
  return { path: archive, files };
}
