import { isString } from "./value-contracts.ts";
import { Container, type Component, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
  type RenderTheme,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { ImageGenerationParameters } from "./image-generation-schema.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "./namespaced-tools.ts";

export const IMAGE_GENERATION_DETAILS_SCHEMA = {
  type: "object",
  properties: {
    operation: { enum: ["generate", "edit"] },
    revisedPrompt: { type: "string" },
    savedPath: { type: "string" },
    saveError: { type: "string" },
  },
  required: ["operation", "revisedPrompt"],
} as const;

export type ImageGenerationDetails = Static<typeof IMAGE_GENERATION_DETAILS_SCHEMA>;

type ImageGenerationRenderContext = {
  args: ImageGenerationParameters;
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

function imageCount(args: ImageGenerationParameters): number | undefined {
  const paths = args.referenced_image_paths ?? [];
  if (paths.length > 0) return paths.length;
  return args.num_last_images_to_include ?? undefined;
}

function describeImageCall(args: ImageGenerationParameters): string {
  const count = imageCount(args);
  const operation =
    count === undefined ? "generate" : `edit ${count} ${count === 1 ? "image" : "images"}`;
  return `${operation} ${promptPreview(args.prompt)}`;
}

function textOutput(result: ImageGenerationResult): string {
  return result.content
    .filter((item) => item.type === "text" && isString(item.text))
    .map((item) => item.text)
    .join("\n");
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

class ImageGenerationResultComponent implements Component {
  private readonly result: ImageGenerationResult;
  private readonly expanded: boolean;
  private readonly theme: RenderTheme;
  private readonly isError: boolean;

  constructor(
    result: ImageGenerationResult,
    expanded: boolean,
    theme: RenderTheme,
    isError: boolean,
  ) {
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

    if (!Value.Check(IMAGE_GENERATION_DETAILS_SCHEMA, this.result.details)) {
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
  args: ImageGenerationParameters,
  theme: RenderTheme,
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
  theme: RenderTheme,
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
