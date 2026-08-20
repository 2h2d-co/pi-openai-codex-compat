import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import registerApplyPatch, {
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  parsePatch,
  parsePatchDocument,
} from "../../extensions/openai-codex-compat/apply-patch.ts";
import { ApplyPatchDiffComponent } from "../../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { APPLY_PATCH_DETAILS_SCHEMA } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-details-schema.ts";
import { formatApplyPatchRenderText } from "../../extensions/openai-codex-compat/apply-patch-render.ts";
import type { CodexToolBackground } from "../../extensions/openai-codex-compat/config.ts";
import { testTheme } from "../support/test-theme.ts";

export const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

export async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-apply-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

export function requireApplyPatchDetails(value: unknown): ApplyPatchDetails {
  assert.ok(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, value));
  return value;
}

export {
  assert,
  writeFileSync,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  homedir,
  tmpdir,
  join,
  parse,
  test,
  initTheme,
  visibleWidth,
  registerApplyPatch,
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  parsePatch,
  parsePatchDocument,
  ApplyPatchDiffComponent,
  formatApplyPatchRenderText,
  testTheme,
};
export type {
  TestContext,
  ExtensionAPI,
  Theme,
  ToolDefinition,
  ApplyPatchDetails,
  CodexToolBackground,
};
