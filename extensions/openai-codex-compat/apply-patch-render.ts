import { isAbsolute, relative, resolve } from "node:path";
import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  type ApplyPatchDetails,
  type AppliedPatchChange,
  previewPatch,
} from "./apply-patch-engine.ts";

type ApplyPatchArgs = {
  patch: string;
};

type ApplyPatchRenderState = {
  previewKey?: string;
  previewPending?: boolean;
  preview?: ApplyPatchDetails;
};

type ApplyPatchRenderContext = {
  args: ApplyPatchArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: unknown;
  state: ApplyPatchRenderState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

type ApplyPatchResult = {
  content: Array<{ type: string; text?: string }>;
  details?: ApplyPatchDetails;
};

function displayPath(path: string, cwd: string): string {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return relative(cwd, absolutePath) || path;
}

function changePath(change: AppliedPatchChange, cwd: string): string {
  const path = displayPath(change.path, cwd);
  return change.kind === "update" && change.moveTo
    ? `${path} → ${displayPath(change.moveTo, cwd)}`
    : path;
}

function changeVerb(change: AppliedPatchChange): string {
  switch (change.kind) {
    case "add":
      return "Added";
    case "delete":
      return "Deleted";
    case "update":
      return "Edited";
  }
}

function countSummary(additions: number, deletions: number, theme: Theme): string {
  return `(${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${deletions}`)})`;
}

function comparePaths(left: string, right: string): number {
  if (process.platform === "win32") return left < right ? -1 : left > right ? 1 : 0;
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function indentedDiff(change: AppliedPatchChange): string[] {
  if (!change.displayDiff) return [];
  return renderDiff(change.displayDiff)
    .split("\n")
    .map((line) => `    ${line}`);
}

export function formatApplyPatchRenderText(
  details: ApplyPatchDetails,
  theme: Theme,
  cwd = process.cwd(),
): string {
  const lines: string[] = [];
  const changes = details.changes.toSorted((left, right) =>
    comparePaths(resolve(cwd, left.path), resolve(cwd, right.path)),
  );
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);

  if (changes.length === 1) {
    const change = changes[0]!;
    lines.push(
      `${theme.fg("dim", "• ")}${theme.bold(changeVerb(change))} ${changePath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`,
    );
    lines.push(...indentedDiff(change));
  } else if (changes.length > 1) {
    lines.push(
      `${theme.fg("dim", "• ")}${theme.bold("Edited")} ${changes.length} files ${countSummary(additions, deletions, theme)}`,
    );
    for (const [index, change] of changes.entries()) {
      lines.push(
        `  ${theme.fg("dim", "└ ")}${changePath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`,
      );
      lines.push(...indentedDiff(change));
      if (index !== changes.length - 1) lines.push("");
    }
  }

  if (details.status === "failed") {
    if (lines.length > 0) lines.push("");
    lines.push(theme.bold(theme.fg("error", "✘ Failed to apply patch")));
  }
  return lines.join("\n");
}

export function renderApplyPatchCall(
  args: ApplyPatchArgs,
  theme: Theme,
  context: ApplyPatchRenderContext,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0));

  if (context.isPartial) {
    const state = context.state;
    const patch = typeof args.patch === "string" ? args.patch : "";
    if (context.argsComplete && patch) {
      const previewKey = `${context.cwd}\0${patch}`;
      if (state.previewKey !== previewKey) {
        state.previewKey = previewKey;
        delete state.preview;
        state.previewPending = false;
      }
      if (!state.preview && !state.previewPending) {
        state.previewPending = true;
        void previewPatch(context.cwd, patch)
          .then((preview) => {
            if (state.previewKey === previewKey) state.preview = preview;
          })
          .catch(() => {})
          .finally(() => {
            if (state.previewKey === previewKey) {
              state.previewPending = false;
              context.invalidate();
            }
          });
      }
    }

    const previewText = state.preview
      ? formatApplyPatchRenderText(state.preview, theme, context.cwd)
      : "";
    if (previewText) container.addChild(new Text(previewText, 0, 0));
  }

  return container;
}

export function renderApplyPatchResult(
  result: ApplyPatchResult,
  options: { isPartial: boolean },
  theme: Theme,
  context: ApplyPatchRenderContext,
): Text | Container {
  if (options.isPartial) return new Container();

  const details = result.details;
  const renderDetails =
    details?.status === "failed" && context.state.preview
      ? {
          ...context.state.preview,
          status: "failed" as const,
          ...(details.error !== undefined ? { error: details.error } : {}),
        }
      : details;
  let text = renderDetails ? formatApplyPatchRenderText(renderDetails, theme, context.cwd) : "";
  if (!text && context.isError) {
    text = theme.bold(theme.fg("error", "✘ Failed to apply patch"));
  }
  if (!text) return new Container();

  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  component.setText(text);
  return component;
}
