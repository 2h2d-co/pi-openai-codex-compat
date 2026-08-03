import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "./namespaced-tools.ts";

export type ImageGenerationDetails = {
  operation: "generate" | "edit";
  revisedPrompt: string;
  savedPath?: string;
  saveError?: string;
};

type ImageGenerationArgs = {
  prompt: string;
  referenced_image_paths?: string[] | null;
  num_last_images_to_include?: number | null;
};

type ImageGenerationRenderContext = {
  args: ImageGenerationArgs;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
};

type ImageGenerationResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

function promptPreview(prompt: string, maximum = 250): string {
  const singleLine = prompt.replace(/\s+/gu, " ").trim();
  const preview =
    singleLine.length > maximum ? `${singleLine.slice(0, Math.max(0, maximum - 1))}…` : singleLine;
  return `"${preview}"`;
}

function imageCount(args: ImageGenerationArgs): number | undefined {
  const paths = args.referenced_image_paths ?? [];
  if (paths.length > 0) return paths.length;
  return args.num_last_images_to_include ?? undefined;
}

function describeImageCall(args: ImageGenerationArgs): string {
  const count = imageCount(args);
  const operation =
    count === undefined ? "generate" : `edit ${count} ${count === 1 ? "image" : "images"}`;
  return `${operation} ${promptPreview(args.prompt)}`;
}

function isImageGenerationDetails(value: unknown): value is ImageGenerationDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Partial<ImageGenerationDetails>;
  return (
    (details.operation === "generate" || details.operation === "edit") &&
    typeof details.revisedPrompt === "string" &&
    (details.savedPath === undefined || typeof details.savedPath === "string") &&
    (details.saveError === undefined || typeof details.saveError === "string")
  );
}

function textOutput(result: ImageGenerationResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

class ImageGenerationResultComponent implements Component {
  private readonly result: ImageGenerationResult;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly isError: boolean;

  constructor(result: ImageGenerationResult, expanded: boolean, theme: Theme, isError: boolean) {
    this.result = result;
    this.expanded = expanded;
    this.theme = theme;
    this.isError = isError;
  }

  render(width: number): string[] {
    const output = textOutput(this.result);
    if (this.isError) {
      const lines = [this.theme.bold(this.theme.fg("error", "✘ Image generation failed"))];
      if (this.expanded && output) {
        lines.push("", ...output.split("\n").map((line) => this.theme.fg("error", line)));
      }
      return wrapLines(lines, width);
    }

    if (!isImageGenerationDetails(this.result.details)) {
      return wrapLines([this.theme.fg("warning", "Image result metadata unavailable")], width);
    }
    const details = this.result.details;
    const verb = details.operation === "edit" ? "Edited" : "Generated";
    const lines = [
      `${this.theme.fg("dim", "• ")}${this.theme.bold(`${verb} image`)}${
        details.savedPath ? `  ${this.theme.fg("accent", details.savedPath)}` : ""
      }`,
    ];
    if (details.saveError) {
      lines.push(this.theme.fg("warning", `  Could not save image: ${details.saveError}`));
    }
    if (this.expanded) {
      lines.push(
        "",
        `${this.theme.fg("muted", "Prompt")}  ${this.theme.fg("toolOutput", details.revisedPrompt)}`,
      );
      if (details.savedPath) {
        lines.push(
          `${this.theme.fg("muted", "Saved")}   ${this.theme.fg("accent", details.savedPath)}`,
        );
      }
    }
    return wrapLines(lines, width);
  }

  invalidate(): void {}
}

export function renderImageGenerationCall(
  args: ImageGenerationArgs,
  theme: Theme,
  context: ImageGenerationRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  const title = theme.fg("toolTitle", theme.bold(IMAGE_GENERATION_TOOL_NAME));
  const summary = theme.fg("muted", describeImageCall(args));
  return new CodexToolSurfaceComponent(new Text(`${title}  ${summary}`, 0, 0), theme, {
    background: resolveBackground,
    status: context.isPartial ? "pending" : context.isError ? "error" : "success",
    top: true,
    bottom: context.isPartial,
  });
}

export function renderImageGenerationResult(
  result: ImageGenerationResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ImageGenerationRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  if (options.isPartial) {
    return new Container();
  }
  return new CodexToolSurfaceComponent(
    new ImageGenerationResultComponent(result, options.expanded, theme, context.isError),
    theme,
    {
      background: resolveBackground,
      status: context.isError ? "error" : "success",
      top: false,
      bottom: true,
    },
  );
}
