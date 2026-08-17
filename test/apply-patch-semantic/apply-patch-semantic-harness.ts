import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
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
  previewPatch,
} from "../../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  ApplyPatchDiffComponent,
  isApplyPatchDetails,
} from "../../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import type { FormatterMatchFailureDetails } from "../../extensions/openai-codex-compat/apply-patch-matcher.ts";
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

export function deferred(): { promise: Promise<void>; resolve: () => void } {
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
  if (typeof path === "string") return basename(path);
  if (Buffer.isBuffer(path)) return basename(path.toString());
  if (path instanceof URL) return basename(path.pathname);
  return "";
}

export {
  assert,
  execFile,
  writeFileSync,
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
  previewPatch,
  ApplyPatchDiffComponent,
  isApplyPatchDetails,
  formatApplyPatchRenderText,
};
export type { TestContext, Theme, ApplyPatchDetails, FormatterMatchFailureDetails };
