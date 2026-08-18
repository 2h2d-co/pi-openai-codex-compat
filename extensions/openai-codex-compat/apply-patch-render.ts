import { isString } from "./value-contracts.ts";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type ApplyPatchDetails, previewPatch } from "./apply-patch-engine.ts";
import { ApplyPatchDiffComponent, isApplyPatchDetails } from "./apply-patch-diff-render.ts";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
  type RenderTheme,
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

class ApplyPatchTitleComponent implements Component {
  private readonly text = new Text("", 0, 0);
  private readonly theme: RenderTheme;
  private readonly resolveDebug: ApplyPatchDebugResolver;

  constructor(theme: RenderTheme, resolveDebug: ApplyPatchDebugResolver) {
    this.theme = theme;
    this.resolveDebug = resolveDebug;
  }

  render(width: number): string[] {
    const title = this.resolveDebug() ? "apply_patch (debug)" : "apply_patch";
    this.text.setText(this.theme.fg("toolTitle", this.theme.bold(title)));
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

function modelFeedback(result: ApplyPatchResult): string | undefined {
  const text = result.content.flatMap((item) =>
    item.type === "text" && isString(item.text) ? [item.text] : [],
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
    expanded: boolean,
    resolveDebug: ApplyPatchDebugResolver,
  ) {
    this.ordinary = ordinary;
    this.expanded = expanded;
    this.resolveDebug = resolveDebug;
    const feedback = modelFeedback(result);
    if (feedback !== undefined) {
      this.feedback = new Container();
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
  theme: RenderTheme,
  context: ApplyPatchRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  resolveDebug: ApplyPatchDebugResolver = () => DEFAULT_CONFIG.applyPatchDebug,
): Component {
  const container = new Container();
  container.addChild(new ApplyPatchTitleComponent(theme, resolveDebug));

  if (context.isPartial) {
    const state = context.state;
    const patch = isString(args.patch) ? args.patch : "";
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
          .catch((error: unknown) => {
            if (!(error instanceof Error)) throw error;
          })
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
  theme: RenderTheme,
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
    new ApplyPatchResultComponent(new Text(text, 0, 0), result, context.expanded, resolveDebug),
    theme,
    {
      background: resolveBackground,
      status: "error",
      top: false,
      bottom: true,
    },
  );
}
