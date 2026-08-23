import { isString } from "../../extensions/openai-codex-compat/value-contracts.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createServer } from "node:net";
import test, { type TestContext } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchSummary,
  parsePatch,
  parsePatchDocument,
} from "../../extensions/openai-codex-compat/apply-patch-engine.ts";
import type { SemanticPlan } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-filesystem-model.ts";
import { resolveOperations } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-operation-semantics.ts";
import { SemanticPlanner } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-semantic-planner.ts";
import { ApplyPatchDiffComponent } from "../../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { formatApplyPatchRenderText } from "../../extensions/openai-codex-compat/apply-patch-render.ts";

export const execFileAsync = promisify(execFile);

export async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-semantic-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

export async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

export function patch(...operations: string[]): string {
  return `*** Begin Patch\n${operations.join("")}*** End Patch`;
}

export async function buildSemanticPlan(cwd: string, patchDocument: string): Promise<SemanticPlan> {
  const parsed = parsePatchDocument(patchDocument);
  const operations = resolveOperations(cwd, parsed.operations);
  return new SemanticPlanner(operations).plan();
}

export interface DeferredSignal {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function filesystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

export function pathLikeBasename(path: unknown): string {
  if (isString(path)) return basename(path);
  if (Buffer.isBuffer(path)) return basename(path.toString());
  if (path instanceof URL) return basename(path.pathname);
  return "";
}

export {
  assert,
  execFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
  tmpdir,
  basename,
  join,
  delay,
  promisify,
  createServer,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchSummary,
  parsePatch,
  ApplyPatchDiffComponent,
  formatApplyPatchRenderText,
};
export type { TestContext, Theme, ApplyPatchDetails };
