import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type ApplyPatchDetails, previewPatch } from "./apply-patch-engine.ts";
import { ApplyPatchDiffComponent, isApplyPatchDetails } from "./apply-patch-diff-render.ts";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";

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

export type ApplyPatchDebugResolver = () => boolean;

function modelFeedback(result: ApplyPatchResult): string | undefined {
  const text = result.content.flatMap((item) =>
    item.type === "text" && typeof item.text === "string" ? [item.text] : [],
  );
  return text.length > 0 ? text.join("\n") : undefined;
}

class ApplyPatchResultComponent implements Component {
  private readonly ordinary: Component;
  private readonly feedback: Container | undefined;
  private readonly expanded: boolean;
  private readonly resolveDebug: ApplyPatchDebugResolver;

  constructor(
    ordinary: Component,
    result: ApplyPatchResult,
    theme: Theme,
    expanded: boolean,
    resolveDebug: ApplyPatchDebugResolver,
  ) {
    this.ordinary = ordinary;
    this.expanded = expanded;
    this.resolveDebug = resolveDebug;
    const feedback = modelFeedback(result);
    if (feedback !== undefined) {
      this.feedback = new Container();
      this.feedback.addChild(new Text(theme.bold("Model feedback:"), 0, 0));
      this.feedback.addChild(new Text(feedback, 0, 0));
    }
  }

  render(width: number): string[] {
    return !this.expanded && this.resolveDebug() && this.feedback
      ? this.feedback.render(width)
      : this.ordinary.render(width);
  }

  invalidate(): void {
    this.ordinary.invalidate();
    this.feedback?.invalidate();
  }
}

export function renderApplyPatchCall(
  args: ApplyPatchArgs,
  theme: Theme,
  context: ApplyPatchRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
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

  return new CodexToolSurfaceComponent(container, theme, {
    background: resolveBackground,
    status: context.isPartial ? "pending" : context.isError ? "error" : "success",
    top: true,
    bottom: context.isPartial,
  });
}

export function renderApplyPatchResult(
  result: ApplyPatchResult,
  options: { isPartial: boolean },
  theme: Theme,
  context: ApplyPatchRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  resolveDebug: ApplyPatchDebugResolver = () => DEFAULT_CONFIG.applyPatchDebug,
): Component {
  if (options.isPartial) return new Container();

  const details = isApplyPatchDetails(result.details) ? result.details : undefined;

  if (details) {
    return new CodexToolSurfaceComponent(
      new ApplyPatchResultComponent(
        new ApplyPatchDiffComponent(details, theme, context.cwd, context.expanded),
        result,
        theme,
        context.expanded,
        resolveDebug,
      ),
      theme,
      {
        background: resolveBackground,
        status: context.isError ? "error" : "success",
        top: false,
        bottom: true,
      },
    );
  }
  const text = context.isError ? theme.bold(theme.fg("error", "✘ Failed to apply patch")) : "";
  if (!text) return new Container();
  return new CodexToolSurfaceComponent(
    new ApplyPatchResultComponent(
      new Text(text, 0, 0),
      result,
      theme,
      context.expanded,
      resolveDebug,
    ),
    theme,
    {
      background: resolveBackground,
      status: "error",
      top: false,
      bottom: true,
    },
  );
}
