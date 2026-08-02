import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AppliedPatchChange, ApplyPatchDetails } from "./apply-patch-engine.ts";

type DiffLineKind = "add" | "delete" | "context";

type DiffLine = {
  kind: DiffLineKind;
  lineNumber?: number;
  content: string;
  separator?: boolean;
  highlighted?: string;
};

type DiffPalette = {
  light: boolean;
  addLineBg: string;
  deleteLineBg: string;
  addGutterBg: string;
  deleteGutterBg: string;
  gutterFg: string;
};

const ANSI_RESET_BACKGROUND = "\u001b[49m";
const ANSI_DIM = "\u001b[2m";
const ANSI_NORMAL_INTENSITY = "\u001b[22m";

const DARK_TRUECOLOR_ADD_BG = "\u001b[48;2;33;58;43m";
const DARK_TRUECOLOR_DELETE_BG = "\u001b[48;2;74;34;29m";
const LIGHT_TRUECOLOR_ADD_BG = "\u001b[48;2;218;251;225m";
const LIGHT_TRUECOLOR_DELETE_BG = "\u001b[48;2;255;235;233m";
const LIGHT_TRUECOLOR_ADD_GUTTER_BG = "\u001b[48;2;172;238;187m";
const LIGHT_TRUECOLOR_DELETE_GUTTER_BG = "\u001b[48;2;255;206;203m";
const LIGHT_TRUECOLOR_GUTTER_FG = "\u001b[38;2;31;35;40m";

const DARK_256_ADD_BG = "\u001b[48;5;22m";
const DARK_256_DELETE_BG = "\u001b[48;5;52m";
const LIGHT_256_ADD_BG = "\u001b[48;5;194m";
const LIGHT_256_DELETE_BG = "\u001b[48;5;224m";
const LIGHT_256_ADD_GUTTER_BG = "\u001b[48;5;157m";
const LIGHT_256_DELETE_GUTTER_BG = "\u001b[48;5;217m";
const LIGHT_256_GUTTER_FG = "\u001b[38;5;236m";
const TRUECOLOR_BACKGROUND_PATTERN = new RegExp(String.raw`\u001b\[48;2;(\d+);(\d+);(\d+)m`);
const INDEXED_BACKGROUND_PATTERN = new RegExp(String.raw`\u001b\[48;5;(\d+)m`);
const BACKGROUND_RESET_PATTERN = new RegExp(String.raw`\u001b\[(?:0|49)m`, "g");

function relativePathWithin(basePath: string, targetPath: string): string | undefined {
  const path = relative(resolve(basePath), targetPath);
  if (path === "") return path;
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path;
}

function displayPath(path: string, cwd: string): string {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const cwdRelativePath = relativePathWithin(cwd, absolutePath);
  if (cwdRelativePath !== undefined) return cwdRelativePath || ".";

  const homeRelativePath = relativePathWithin(homedir(), absolutePath);
  if (homeRelativePath !== undefined) return homeRelativePath ? join("~", homeRelativePath) : "~";

  return absolutePath;
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

function sortedChanges(details: ApplyPatchDetails, cwd: string): AppliedPatchChange[] {
  return details.changes.toSorted((left, right) =>
    comparePaths(resolve(cwd, left.path), resolve(cwd, right.path)),
  );
}

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

function backgroundRgb(theme: Theme): [number, number, number] | undefined {
  const ansi = theme.getBgAnsi?.("toolSuccessBg");
  if (!ansi) return undefined;
  const truecolor = ansi.match(TRUECOLOR_BACKGROUND_PATTERN);
  if (truecolor) {
    return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
  }
  const indexed = ansi.match(INDEXED_BACKGROUND_PATTERN);
  return indexed ? xterm256ToRgb(Number(indexed[1])) : undefined;
}

function usesLightPalette(theme: Theme): boolean {
  const rgb = backgroundRgb(theme);
  if (rgb) {
    const red = rgb[0] / 255;
    const green = rgb[1] / 255;
    const blue = rgb[2] / 255;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance >= 0.6;
  }
  return theme.name?.toLowerCase().includes("light") ?? false;
}

function diffPalette(theme: Theme): DiffPalette {
  const light = usesLightPalette(theme);
  const truecolor = theme.getColorMode?.() !== "256color";
  if (truecolor) {
    return {
      light,
      addLineBg: light ? LIGHT_TRUECOLOR_ADD_BG : DARK_TRUECOLOR_ADD_BG,
      deleteLineBg: light ? LIGHT_TRUECOLOR_DELETE_BG : DARK_TRUECOLOR_DELETE_BG,
      addGutterBg: light ? LIGHT_TRUECOLOR_ADD_GUTTER_BG : DARK_TRUECOLOR_ADD_BG,
      deleteGutterBg: light ? LIGHT_TRUECOLOR_DELETE_GUTTER_BG : DARK_TRUECOLOR_DELETE_BG,
      gutterFg: light ? LIGHT_TRUECOLOR_GUTTER_FG : "",
    };
  }
  return {
    light,
    addLineBg: light ? LIGHT_256_ADD_BG : DARK_256_ADD_BG,
    deleteLineBg: light ? LIGHT_256_DELETE_BG : DARK_256_DELETE_BG,
    addGutterBg: light ? LIGHT_256_ADD_GUTTER_BG : DARK_256_ADD_BG,
    deleteGutterBg: light ? LIGHT_256_DELETE_GUTTER_BG : DARK_256_DELETE_BG,
    gutterFg: light ? LIGHT_256_GUTTER_FG : "",
  };
}

function lineBackground(kind: DiffLineKind, palette: DiffPalette): string {
  if (kind === "add") return palette.addLineBg;
  if (kind === "delete") return palette.deleteLineBg;
  return "";
}

function gutterBackground(kind: DiffLineKind, palette: DiffPalette): string {
  if (kind === "add") return palette.addGutterBg;
  if (kind === "delete") return palette.deleteGutterBg;
  return "";
}

function restoreBackgroundAfterResets(text: string, background: string): string {
  if (!background) return text;
  return text.replace(BACKGROUND_RESET_PATTERN, (reset) => `${reset}${background}`);
}

function withBackground(text: string, background: string): string {
  if (!background) return text;
  return `${background}${restoreBackgroundAfterResets(text, background)}${ANSI_RESET_BACKGROUND}`;
}

function parseDisplayDiff(displayDiff: string): DiffLine[] {
  return displayDiff.split("\n").map((line) => {
    if (/^\s+\.\.\.$/.test(line)) {
      return { kind: "context", content: "⋮", separator: true };
    }
    const match = line.match(/^([+\-\s])(\d+)\s(.*)$/);
    if (!match) return { kind: "context", content: line };
    return {
      kind: match[1] === "+" ? "add" : match[1] === "-" ? "delete" : "context",
      lineNumber: Number(match[2]),
      content: match[3] ?? "",
    };
  });
}

function changeDiffLines(change: AppliedPatchChange): DiffLine[] {
  if (change.kind === "add") {
    return change.content
      .replace(/\n$/, "")
      .split("\n")
      .map((content, index) => ({ kind: "add", lineNumber: index + 1, content }));
  }
  if (change.kind === "delete") {
    return change.content
      .replace(/\n$/, "")
      .split("\n")
      .map((content, index) => ({ kind: "delete", lineNumber: index + 1, content }));
  }
  return parseDisplayDiff(change.displayDiff);
}

function highlightDiffLines(lines: DiffLine[], filePath: string): void {
  const language = getLanguageFromPath(filePath);
  if (!language) return;

  let blockStart = 0;
  while (blockStart < lines.length) {
    while (lines[blockStart]?.separator) blockStart += 1;
    if (blockStart >= lines.length) break;
    let blockEnd = blockStart;
    while (blockEnd < lines.length && !lines[blockEnd]?.separator) blockEnd += 1;
    const block = lines.slice(blockStart, blockEnd);
    const highlighted = highlightCode(
      block.map((line) => line.content.replace(/\t/g, "    ")).join("\n"),
      language,
    );
    for (const [index, line] of block.entries()) {
      const highlightedLine = highlighted[index];
      if (highlightedLine !== undefined) line.highlighted = highlightedLine;
    }
    blockStart = blockEnd + 1;
  }
}

function styleContent(line: DiffLine, theme: Theme): string {
  const content = line.highlighted ?? line.content.replace(/\t/g, "    ");
  if (line.highlighted) {
    return line.kind === "delete" ? `${ANSI_DIM}${content}${ANSI_NORMAL_INTENSITY}` : content;
  }
  if (line.kind === "add") return theme.fg("toolDiffAdded", content);
  if (line.kind === "delete") return theme.fg("toolDiffRemoved", content);
  return theme.fg("toolDiffContext", content);
}

function fillLine(line: string, width: number, background: string): string {
  const truncated = truncateToWidth(line, width, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return withBackground(`${truncated}${padding}`, background);
}

function renderDiffLine(
  line: DiffLine,
  width: number,
  lineNumberWidth: number,
  theme: Theme,
  palette: DiffPalette,
): string[] {
  const gutterWidth = Math.max(1, lineNumberWidth);
  if (line.separator) {
    const gutter = " ".repeat(gutterWidth + 2);
    return [fillLine(`${gutter}${theme.fg("dim", line.content)}`, width, "")];
  }

  const contentWidth = Math.max(1, width - gutterWidth - 2);
  const contentLines = wrapTextWithAnsi(styleContent(line, theme), contentWidth);
  const kindBackground = lineBackground(line.kind, palette);

  return contentLines.map((content, index) => {
    const lineNumber =
      index === 0 && line.lineNumber !== undefined
        ? String(line.lineNumber).padStart(gutterWidth)
        : " ".repeat(gutterWidth);
    const sign =
      index === 0 ? (line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ") : " ";
    const rawGutter = `${lineNumber} `;
    const gutter =
      line.kind === "context"
        ? theme.fg("dim", rawGutter)
        : palette.light
          ? `${palette.gutterFg}${rawGutter}\u001b[39m`
          : `${ANSI_DIM}${rawGutter}${ANSI_NORMAL_INTENSITY}`;
    const styledGutter = withBackground(gutter, gutterBackground(line.kind, palette));
    const styledSign =
      line.kind === "add"
        ? theme.fg("toolDiffAdded", sign)
        : line.kind === "delete"
          ? theme.fg("toolDiffRemoved", sign)
          : sign;
    const body = `${styledSign}${content}`;
    const visible = visibleWidth(rawGutter) + visibleWidth(body);
    const padding = " ".repeat(Math.max(0, width - visible));
    return `${styledGutter}${withBackground(`${body}${padding}`, kindBackground)}`;
  });
}

function renderHeader(changes: readonly AppliedPatchChange[], theme: Theme, cwd: string): string {
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  if (changes.length === 1) {
    const change = changes[0]!;
    return `${theme.fg("dim", "• ")}${theme.bold(changeVerb(change))} ${changePath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`;
  }
  const noun = changes.length === 1 ? "file" : "files";
  return `${theme.fg("dim", "• ")}${theme.bold("Edited")} ${changes.length} ${noun} ${countSummary(additions, deletions, theme)}`;
}

function renderChange(
  change: AppliedPatchChange,
  width: number,
  theme: Theme,
  palette: DiffPalette,
): string[] {
  const lines = changeDiffLines(change);
  const languagePath = change.kind === "update" && change.moveTo ? change.moveTo : change.path;
  highlightDiffLines(lines, languagePath);
  const lineNumberWidth = lines.reduce(
    (maximum, line) =>
      line.lineNumber === undefined ? maximum : Math.max(maximum, String(line.lineNumber).length),
    1,
  );
  return lines.flatMap((line) => renderDiffLine(line, width, lineNumberWidth, theme, palette));
}

export function formatApplyPatchRenderText(
  details: ApplyPatchDetails,
  theme: Theme,
  cwd = process.cwd(),
): string {
  const lines: string[] = [];
  const changes = sortedChanges(details, cwd);
  if (changes.length > 0) {
    lines.push(renderHeader(changes, theme, cwd));
    for (const [index, change] of changes.entries()) {
      if (changes.length > 1) {
        lines.push(
          `  ${theme.fg("dim", "└ ")}${changePath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`,
        );
      }
      lines.push(
        ...changeDiffLines(change).map((line) => {
          if (line.separator) return `    ${theme.fg("dim", "⋮")}`;
          const sign = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
          return `    ${sign}${line.lineNumber ?? ""} ${line.content}`;
        }),
      );
      if (index !== changes.length - 1) lines.push("");
    }
  }
  if (details.status === "failed") {
    if (lines.length > 0) lines.push("");
    lines.push(theme.bold(theme.fg("error", "✘ Failed to apply patch")));
  }
  return lines.join("\n");
}

export class ApplyPatchDiffComponent implements Component {
  private readonly details: ApplyPatchDetails;
  private readonly theme: Theme;
  private readonly cwd: string;
  private readonly expanded: boolean;

  constructor(details: ApplyPatchDetails, theme: Theme, cwd: string, expanded: boolean) {
    this.details = details;
    this.theme = theme;
    this.cwd = cwd;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(1, width);
    const changes = sortedChanges(this.details, this.cwd);
    const palette = diffPalette(this.theme);
    const lines: string[] = [];

    if (changes.length > 0) {
      lines.push(...wrapTextWithAnsi(renderHeader(changes, this.theme, this.cwd), effectiveWidth));
      for (const [index, change] of changes.entries()) {
        if (this.expanded && index > 0) lines.push("");
        if (changes.length > 1) {
          const header = `  ${this.theme.fg("dim", "└ ")}${changePath(change, this.cwd)} ${countSummary(change.additions, change.deletions, this.theme)}`;
          lines.push(...wrapTextWithAnsi(header, effectiveWidth));
        }
        if (this.expanded) {
          const inset = Math.min(4, Math.max(0, effectiveWidth - 1));
          const contentWidth = Math.max(1, effectiveWidth - inset);
          lines.push(
            ...renderChange(change, contentWidth, this.theme, palette).map(
              (line) => `${" ".repeat(inset)}${line}`,
            ),
          );
        }
      }
    }

    if (this.details.status === "failed") {
      if (lines.length > 0) lines.push("");
      lines.push(
        truncateToWidth(
          this.theme.bold(this.theme.fg("error", "✘ Failed to apply patch")),
          effectiveWidth,
          "",
        ),
      );
    }

    return lines;
  }

  invalidate(): void {}
}
