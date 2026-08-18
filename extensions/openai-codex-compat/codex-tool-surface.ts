import type { Theme as FrameworkTheme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CodexToolBackground } from "./config.ts";

export type CodexToolSurfaceStatus = "pending" | "success" | "error";
export type CodexToolBackgroundResolver = () => CodexToolBackground;
export interface RenderTheme {
  fg: FrameworkTheme["fg"];
  bold: FrameworkTheme["bold"];
  getBgAnsi?: FrameworkTheme["getBgAnsi"];
  getColorMode?: FrameworkTheme["getColorMode"];
  name?: string;
}
type ThemeBg =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

const ANSI_RESET_BACKGROUND = "\u001b[49m";
const DARK_256_SURFACE_BG = "\u001b[48;5;234m";
const LIGHT_256_SURFACE_BG = "\u001b[48;5;255m";
const TRUECOLOR_BACKGROUND_PATTERN = new RegExp(String.raw`\u001b\[48;2;(\d+);(\d+);(\d+)m`);
const INDEXED_BACKGROUND_PATTERN = new RegExp(String.raw`\u001b\[48;5;(\d+)m`);
const BACKGROUND_RESET_PATTERN = new RegExp(String.raw`\u001b\[(?:0|49)m`, "g");

function xtermChannel(index: number): number {
  return index === 0 ? 0 : 55 + index * 40;
}

function xterm256ToRgb(index: number): [number, number, number] {
  if (index < 16) {
    const standard: Array<[number, number, number]> = [
      [0, 0, 0],
      [128, 0, 0],
      [0, 128, 0],
      [128, 128, 0],
      [0, 0, 128],
      [128, 0, 128],
      [0, 128, 128],
      [192, 192, 192],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ];
    return standard[index] ?? [0, 0, 0];
  }
  if (index < 232) {
    const offset = index - 16;
    return [
      xtermChannel(Math.floor(offset / 36)),
      xtermChannel(Math.floor((offset % 36) / 6)),
      xtermChannel(offset % 6),
    ];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

function backgroundRgb(
  theme: RenderTheme,
  background: ThemeBg,
): [number, number, number] | undefined {
  const ansi = theme.getBgAnsi?.(background);
  if (!ansi) return undefined;
  const truecolor = ansi.match(TRUECOLOR_BACKGROUND_PATTERN);
  if (truecolor) {
    return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
  }
  const indexed = ansi.match(INDEXED_BACKGROUND_PATTERN);
  return indexed ? xterm256ToRgb(Number(indexed[1])) : undefined;
}

export function usesLightToolPalette(theme: RenderTheme): boolean {
  const rgb = backgroundRgb(theme, "toolSuccessBg");
  if (rgb) {
    const red = rgb[0] / 255;
    const green = rgb[1] / 255;
    const blue = rgb[2] / 255;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance >= 0.6;
  }
  return theme.name?.toLowerCase().includes("light") ?? false;
}

function blendRgb(
  overlay: [number, number, number],
  background: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    Math.round(overlay[0] * alpha + background[0] * (1 - alpha)),
    Math.round(overlay[1] * alpha + background[1] * (1 - alpha)),
    Math.round(overlay[2] * alpha + background[2] * (1 - alpha)),
  ];
}

function subtleBackground(theme: RenderTheme): string {
  const light = usesLightToolPalette(theme);
  if (theme.getColorMode?.() === "256color") {
    return light ? LIGHT_256_SURFACE_BG : DARK_256_SURFACE_BG;
  }

  const base =
    backgroundRgb(theme, "toolPendingBg") ??
    (light ? ([232, 232, 240] as const) : ([40, 40, 50] as const));
  const overlay: [number, number, number] = light ? [255, 255, 255] : [0, 0, 0];
  const alpha = light ? 0.55 : 0.35;
  const [red, green, blue] = blendRgb(overlay, base, alpha);
  return `\u001b[48;2;${red};${green};${blue}m`;
}

function statusBackground(theme: RenderTheme, status: CodexToolSurfaceStatus): string {
  const token: ThemeBg =
    status === "pending" ? "toolPendingBg" : status === "error" ? "toolErrorBg" : "toolSuccessBg";
  return theme.getBgAnsi?.(token) ?? "";
}

function surfaceBackground(
  theme: RenderTheme,
  style: CodexToolBackground,
  status: CodexToolSurfaceStatus,
): string {
  if (style === "none") return "";
  return style === "status" ? statusBackground(theme, status) : subtleBackground(theme);
}

function restoreBackgroundAfterResets(text: string, background: string): string {
  if (!background) return text;
  return text.replace(BACKGROUND_RESET_PATTERN, (reset) => `${reset}${background}`);
}

function withBackground(text: string, background: string): string {
  if (!background) return text;
  return `${background}${restoreBackgroundAfterResets(text, background)}${ANSI_RESET_BACKGROUND}`;
}

function fillLine(line: string, width: number, background: string): string {
  const truncated = truncateToWidth(line, width, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return withBackground(`${truncated}${padding}`, background);
}

export class CodexToolSurfaceComponent implements Component {
  private readonly component: Component;
  private readonly theme: RenderTheme;
  private readonly resolveBackground: CodexToolBackgroundResolver;
  private readonly status: CodexToolSurfaceStatus;
  private readonly topPadding: boolean;
  private readonly bottomPadding: boolean;

  constructor(
    component: Component,
    theme: RenderTheme,
    options: {
      background: CodexToolBackgroundResolver;
      status: CodexToolSurfaceStatus;
      top: boolean;
      bottom: boolean;
    },
  ) {
    this.component = component;
    this.theme = theme;
    this.resolveBackground = options.background;
    this.status = options.status;
    this.topPadding = options.top;
    this.bottomPadding = options.bottom;
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(1, width);
    const background = surfaceBackground(this.theme, this.resolveBackground(), this.status);
    const horizontalPadding = effectiveWidth > 2 ? 1 : 0;
    const contentWidth = Math.max(1, effectiveWidth - horizontalPadding * 2);
    const lines = this.component
      .render(contentWidth)
      .map((line) =>
        fillLine(`${" ".repeat(horizontalPadding)}${line}`, effectiveWidth, background),
      );
    const blankLine = fillLine("", effectiveWidth, background);
    if (this.topPadding) lines.unshift(blankLine);
    if (this.bottomPadding) lines.push(blankLine);
    return lines;
  }

  invalidate(): void {
    this.component.invalidate();
  }
}
