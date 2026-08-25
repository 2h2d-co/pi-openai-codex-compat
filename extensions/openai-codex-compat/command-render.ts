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

function previewLines(output: string, expanded: boolean): string[] {
  const lines = output.split("\n");
  if (expanded || lines.length <= 5) return lines;
  return [`… (${lines.length - 5} earlier lines)`, ...lines.slice(-5)];
}

class CommandResultComponent implements Component {
  private readonly output: string;
  private readonly expanded: boolean;
  private readonly theme: RenderTheme;
  private readonly isError: boolean;

  constructor(output: string, expanded: boolean, theme: RenderTheme, isError: boolean) {
    this.output = output;
    this.expanded = expanded;
    this.theme = theme;
    this.isError = isError;
  }

  render(width: number): string[] {
    return previewLines(this.output, this.expanded).map((line) =>
      truncateToWidth(
        this.theme.fg(this.isError ? "error" : "toolOutput", line),
        Math.max(1, width),
        "…",
      ),
    );
  }

  invalidate(): void {}
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
