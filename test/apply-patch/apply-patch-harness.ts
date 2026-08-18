import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerApplyPatch, {
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  parsePatch,
  parsePatchDocument,
  previewPatch,
} from "../../extensions/openai-codex-compat/apply-patch.ts";
import {
  ApplyPatchDiffComponent,
  isApplyPatchDetails,
} from "../../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { formatApplyPatchRenderText } from "../../extensions/openai-codex-compat/apply-patch-render.ts";
import type { CodexToolBackground } from "../../extensions/openai-codex-compat/config.ts";

export const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
export const ANSI_BACKGROUND_PATTERN = new RegExp(
  String.raw`\u001b\[48;(?:2;\d+;\d+;\d+|5;\d+)m`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

export async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-apply-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

class TestTheme extends Theme {
  constructor() {
    super(
      {
        accent: "#ffffff",
        border: "#ffffff",
        borderAccent: "#ffffff",
        borderMuted: "#ffffff",
        success: "#ffffff",
        error: "#ffffff",
        warning: "#ffffff",
        muted: "#ffffff",
        dim: "#ffffff",
        text: "#ffffff",
        thinkingText: "#ffffff",
        userMessageText: "#ffffff",
        customMessageText: "#ffffff",
        customMessageLabel: "#ffffff",
        toolTitle: "#ffffff",
        toolOutput: "#ffffff",
        mdHeading: "#ffffff",
        mdLink: "#ffffff",
        mdLinkUrl: "#ffffff",
        mdCode: "#ffffff",
        mdCodeBlock: "#ffffff",
        mdCodeBlockBorder: "#ffffff",
        mdQuote: "#ffffff",
        mdQuoteBorder: "#ffffff",
        mdHr: "#ffffff",
        mdListBullet: "#ffffff",
        toolDiffAdded: "#ffffff",
        toolDiffRemoved: "#ffffff",
        toolDiffContext: "#ffffff",
        syntaxComment: "#ffffff",
        syntaxKeyword: "#ffffff",
        syntaxFunction: "#ffffff",
        syntaxVariable: "#ffffff",
        syntaxString: "#ffffff",
        syntaxNumber: "#ffffff",
        syntaxType: "#ffffff",
        syntaxOperator: "#ffffff",
        syntaxPunctuation: "#ffffff",
        thinkingOff: "#ffffff",
        thinkingMinimal: "#ffffff",
        thinkingLow: "#ffffff",
        thinkingMedium: "#ffffff",
        thinkingHigh: "#ffffff",
        thinkingXhigh: "#ffffff",
        thinkingMax: "#ffffff",
        bashMode: "#ffffff",
      },
      {
        selectedBg: "#282832",
        scrollbarThumb: "#282832",
        userMessageBg: "#282832",
        customMessageBg: "#282832",
        toolPendingBg: "#282832",
        toolSuccessBg: "#283228",
        toolErrorBg: "#322828",
      },
      "truecolor",
      { name: "dark" },
    );
  }

  override fg(_color: Parameters<Theme["fg"]>[0], text: string): string {
    return text;
  }

  override bold(text: string): string {
    return text;
  }

  override getBgAnsi(color: Parameters<Theme["getBgAnsi"]>[0]): string {
    return color === "toolPendingBg" ? "\u001b[48;2;40;40;50m" : "\u001b[48;2;40;50;40m";
  }

  override getColorMode(): ReturnType<Theme["getColorMode"]> {
    return "truecolor";
  }
}

export function testTheme(): Theme {
  return new TestTheme();
}

export function requireApplyPatchDetails(value: unknown): ApplyPatchDetails {
  assert.ok(isApplyPatchDetails(value));
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
  ToolExecutionComponent,
  visibleWidth,
  registerApplyPatch,
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  parsePatch,
  parsePatchDocument,
  previewPatch,
  ApplyPatchDiffComponent,
  isApplyPatchDetails,
  formatApplyPatchRenderText,
};
export type {
  TestContext,
  ExtensionAPI,
  Theme,
  ToolDefinition,
  ApplyPatchDetails,
  CodexToolBackground,
};
