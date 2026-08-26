import { Container, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
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

type CommandRenderResult = {
  content: Array<{ type: string; text?: string }>;
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

export function commandOutputPreviewLines(output: string, expanded: boolean): string[] {
  const visibleOutput = output.replace(/(?:\r?\n)+$/u, "");
  if (!visibleOutput) return [];
  if (expanded) return visibleOutput.split("\n");

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

  if (totalLines <= COLLAPSED_OUTPUT_LINE_LIMIT) return visibleOutput.split("\n");

  const tailStart = recentLineStarts[0] ?? 0;
  return [
    `… (${totalLines - COLLAPSED_OUTPUT_LINE_LIMIT} earlier lines)`,
    ...visibleOutput.slice(tailStart).split("\n"),
  ];
}

class CommandResultComponent implements Component {
  private readonly previewLines: string[];
  private readonly theme: RenderTheme;
  private readonly isError: boolean;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(output: string, expanded: boolean, theme: RenderTheme, isError: boolean) {
    this.previewLines = commandOutputPreviewLines(output, expanded);
    this.theme = theme;
    this.isError = isError;
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === effectiveWidth) return this.cachedLines;

    const lines = this.previewLines.map((line) =>
      truncateToWidth(
        this.theme.fg(this.isError ? "error" : "toolOutput", line),
        effectiveWidth,
        "…",
      ),
    );
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
  theme: RenderTheme,
  context: CommandRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const summary = theme.fg("muted", command || "…");
  return new CodexToolSurfaceComponent(new Text(`${title}  ${summary}`, 0, 0), theme, {
    background: resolveBackground,
    status: context.isPartial ? "pending" : context.isError ? "error" : "success",
    top: true,
    bottom: context.isPartial,
  });
}

export function renderCommandResult(
  result: CommandRenderResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: CommandRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  if (options.isPartial) return new Container();
  return new CodexToolSurfaceComponent(
    new CommandResultComponent(textOutput(result), options.expanded, theme, context.isError),
    theme,
    {
      background: resolveBackground,
      status: context.isError ? "error" : "success",
      top: false,
      bottom: true,
    },
  );
}
