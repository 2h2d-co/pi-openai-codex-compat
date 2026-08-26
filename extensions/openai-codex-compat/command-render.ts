import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
  type RenderTheme,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";

type CommandRenderContext = {
  isError: boolean;
  isPartial: boolean;
};

type CommandCallRenderContext = CommandRenderContext & {
  executionStarted: boolean;
};

type CommandRenderResult = {
  content: Array<{ type: string; text?: string }>;
};

type CommandOutputPreviewLine = {
  text: string;
  sourceLine?: number;
};

function textOutput(result: CommandRenderResult): string {
  return result.content
    .filter(
      (item): item is { type: string; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

const COLLAPSED_OUTPUT_LINE_LIMIT = 5;

function visibleCommandOutput(output: string): string {
  return output.replace(/(?:\r?\n)+$/u, "");
}

function commandOutputPreviewFromVisibleOutput(
  visibleOutput: string,
  expanded: boolean,
): CommandOutputPreviewLine[] {
  if (!visibleOutput) return [];
  if (expanded) {
    return visibleOutput.split("\n").map((text, sourceLine) => ({ sourceLine, text }));
  }

  let totalLines = 1;
  const recentLineStarts = [0];
  for (let index = 0; index < visibleOutput.length; index++) {
    if (visibleOutput.charCodeAt(index) !== 10) continue;
    totalLines++;
    recentLineStarts.push(index + 1);
    if (recentLineStarts.length > COLLAPSED_OUTPUT_LINE_LIMIT) {
      recentLineStarts.shift();
    }
  }

  if (totalLines <= COLLAPSED_OUTPUT_LINE_LIMIT) {
    return visibleOutput.split("\n").map((text, sourceLine) => ({ sourceLine, text }));
  }

  const tailStart = recentLineStarts[0] ?? 0;
  const retainedStartLine = totalLines - COLLAPSED_OUTPUT_LINE_LIMIT;
  return [
    { text: `… (${retainedStartLine} earlier lines)` },
    ...visibleOutput
      .slice(tailStart)
      .split("\n")
      .map((text, index) => ({ sourceLine: retainedStartLine + index, text })),
  ];
}

function commandOutputPreview(output: string, expanded: boolean): CommandOutputPreviewLine[] {
  return commandOutputPreviewFromVisibleOutput(visibleCommandOutput(output), expanded);
}

export function commandOutputPreviewLines(output: string, expanded: boolean): string[] {
  return commandOutputPreview(output, expanded).map((line) => line.text);
}

function commandOutputBodyStartLine(visibleOutput: string): number | undefined {
  const embeddedMarker = visibleOutput.indexOf("\nOutput:");
  const markerStart = visibleOutput.startsWith("Output:")
    ? 0
    : embeddedMarker === -1
      ? -1
      : embeddedMarker + 1;
  if (markerStart === -1) return undefined;
  const markerEnd = markerStart + "Output:".length;
  if (!["", "\n"].includes(visibleOutput[markerEnd] ?? "")) return undefined;

  let markerLine = 0;
  for (let index = 0; index < markerStart; index++) {
    if (visibleOutput.charCodeAt(index) === 10) markerLine++;
  }
  return markerLine + 1;
}

class CommandResultComponent implements Component {
  private readonly previewLines: CommandOutputPreviewLine[];
  private readonly theme: RenderTheme;
  private readonly isError: boolean;
  private readonly outputBodyStartLine: number | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    visibleOutput: string,
    expanded: boolean,
    theme: RenderTheme,
    isError: boolean,
    isPartial: boolean,
  ) {
    this.previewLines = commandOutputPreviewFromVisibleOutput(visibleOutput, expanded);
    this.theme = theme;
    this.isError = isError;
    this.outputBodyStartLine = isPartial ? 0 : commandOutputBodyStartLine(visibleOutput);
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === effectiveWidth) return this.cachedLines;

    const lines = this.previewLines.map((line) => {
      const isOutput =
        line.sourceLine !== undefined &&
        (this.outputBodyStartLine === undefined || line.sourceLine >= this.outputBodyStartLine);
      const color =
        line.sourceLine === undefined ? "dim" : this.isError ? "error" : isOutput ? "muted" : "dim";
      return truncateToWidth(this.theme.fg(color, line.text), effectiveWidth, "…");
    });
    this.cachedWidth = effectiveWidth;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function renderCommandCall(
  toolName: string,
  command: string,
  yieldDuration: string | undefined,
  theme: RenderTheme,
  context: CommandCallRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  const title = theme.fg("warning", theme.bold(toolName));
  const yieldLabel = yieldDuration ? `  ${theme.fg("muted", `[yield: ${yieldDuration}]`)}` : "";
  const summary = theme.fg("text", command || "…");
  return new CodexToolSurfaceComponent(new Text(`${title}${yieldLabel}  ${summary}`, 0, 0), theme, {
    background: resolveBackground,
    status: context.isPartial ? "pending" : context.isError ? "error" : "success",
    top: true,
    bottom: context.isPartial && !context.executionStarted,
  });
}

export function renderCommandResult(
  result: CommandRenderResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: CommandRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  const output = visibleCommandOutput(textOutput(result));
  return new CodexToolSurfaceComponent(
    new CommandResultComponent(output, options.expanded, theme, context.isError, options.isPartial),
    theme,
    {
      background: resolveBackground,
      status: context.isPartial ? "pending" : context.isError ? "error" : "success",
      top: output.length > 0,
      bottom: true,
    },
  );
}
