import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type ApplyPatchDetails, previewPatch } from "./apply-patch-engine.ts";
import { ApplyPatchDiffComponent, isApplyPatchDetails } from "./apply-patch-diff-render.ts";

export { formatApplyPatchRenderText } from "./apply-patch-diff-render.ts";

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
  details?: unknown;
};

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

    if (isApplyPatchDetails(state.preview)) {
      container.addChild(
        new ApplyPatchDiffComponent(state.preview, theme, context.cwd, context.expanded),
      );
    }
  }

  return container;
}

export function renderApplyPatchResult(
  result: ApplyPatchResult,
  options: { isPartial: boolean },
  theme: Theme,
  context: ApplyPatchRenderContext,
): Component {
  if (options.isPartial) return new Container();

  const details = isApplyPatchDetails(result.details) ? result.details : undefined;
  const preview = isApplyPatchDetails(context.state.preview) ? context.state.preview : undefined;
  const renderDetails =
    details?.status === "failed" && preview
      ? {
          ...preview,
          status: "failed" as const,
          ...(details.error !== undefined ? { error: details.error } : {}),
        }
      : details;

  if (renderDetails) {
    return new ApplyPatchDiffComponent(renderDetails, theme, context.cwd, context.expanded);
  }
  const text = context.isError ? theme.bold(theme.fg("error", "✘ Failed to apply patch")) : "";
  if (!text) return new Container();
  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  component.setText(text);
  return component;
}
