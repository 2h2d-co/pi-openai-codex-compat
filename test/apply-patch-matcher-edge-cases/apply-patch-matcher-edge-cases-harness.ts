import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyPatch,
  ApplyPatchVerificationError,
} from "../../extensions/openai-codex-compat/apply-patch-engine.ts";

export async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-matcher-edges-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

export async function rejectWithoutWrite(
  cwd: string,
  path: string,
  content: string,
  patch: string,
  pattern: RegExp,
): Promise<void> {
  await writeFile(join(cwd, path), content);
  const before = await readFile(join(cwd, path));
  await assert.rejects(applyPatch(cwd, patch), pattern, path);
  assert.deepEqual(await readFile(join(cwd, path)), before);
}

export {
  assert,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  tmpdir,
  join,
  test,
  applyPatch,
  ApplyPatchVerificationError,
};
export type { TestContext };
