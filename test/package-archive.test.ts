import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { packageArchive } from "./support/package-archive.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "codex-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return temporary;
}

/** A small real gzip tarball with one member, so `tar -tzf` lists it. */
async function syntheticArchive(directory: string, name = "candidate.tgz"): Promise<string> {
  const contents = join(directory, "package");
  await mkdir(contents);
  await writeFile(join(contents, "package.json"), '{"name":"synthetic"}');
  const archive = join(directory, name);
  execFileSync("tar", ["-czf", archive, "-C", directory, "package/package.json"]);
  await rm(contents, { recursive: true, force: true });
  return archive;
}

test("uses a supplied absolute candidate without packing the working directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = await syntheticArchive(temporary);
  // This directory has no package.json, so an accidental npm pack would fail.
  const archive = await packageArchive(temporary, temporary, candidate);
  assert.equal(archive.path, await realpath(candidate));
  assert.deepEqual(archive.files, ["package/package.json"]);
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("resolves a relative candidate against the working directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = await syntheticArchive(temporary);
  const supplied = relative(process.cwd(), candidate);
  assert.notEqual(supplied, candidate);
  const archive = await packageArchive(temporary, temporary, supplied);
  assert.equal(archive.path, await realpath(candidate));
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("rejects an empty, missing, directory, or invalid candidate without falling back", async (t) => {
  const temporary = await temporaryDirectory(t);
  await assert.rejects(packageArchive(temporary, temporary, ""), /must not be empty/);
  await assert.rejects(packageArchive(temporary, temporary, join(temporary, "missing.tgz")), {
    code: "ENOENT",
  });
  const directory = join(temporary, "archive.tgz");
  await mkdir(directory);
  await assert.rejects(packageArchive(temporary, temporary, directory), /not a regular file/);
  const invalid = join(temporary, "invalid.tgz");
  await writeFile(invalid, "not a tarball");
  await assert.rejects(packageArchive(temporary, temporary, invalid), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /tar/);
    return true;
  });
  // No fallback pack ran: only the inputs created above exist.
  assert.deepEqual((await readdir(temporary)).sort(), ["archive.tgz", "invalid.tgz"]);
});

test("packs the worktree only when no candidate is supplied", async (t) => {
  const temporary = await temporaryDirectory(t);
  const root = join(temporary, "root");
  const output = join(temporary, "output");
  await mkdir(root);
  await mkdir(output);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "synthetic-live-test", version: "1.0.0" }),
  );
  const archive = await packageArchive(root, output, undefined);
  assert.equal(archive.path, join(output, "synthetic-live-test-1.0.0.tgz"));
  assert.deepEqual(archive.files, ["package/package.json"]);
});
