import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type AppliedPatchChange,
  type ApplyPatchDetails,
  type ApplyPatchInstructionDetails,
  type ApplyPatchInstructionStatus,
  applyPatchHasOtherFilesystemChanges,
  applyPatchNeedsInstructionResults,
  applyPatchSummaryPaths,
  coalesceAppliedPatchChangesForRendering,
  formatApplyPatchFailureHeading,
  formatApplyPatchInstructionFeedback,
  formatApplyPatchInstructionStatusLabel,
} from "./apply-patch-engine.ts";
import { usesLightToolPalette, type RenderTheme } from "./codex-tool-surface.ts";

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
  if (change.kind === "move") {
    const path = `${displayPath(change.sourcePath, cwd)} → ${displayPath(change.destinationPath, cwd)}`;
    return change.replacedDestination ? `${path} (replaced destination)` : path;
  }
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
      return change.entryType === "symlink" ? "Deleted symlink" : "Deleted";
    case "move":
      return "Moved";
    case "update":
      return "Edited";
  }
}

function changeListPath(change: AppliedPatchChange, cwd: string): string {
  const path = changePath(change, cwd);
  return change.kind === "delete" && change.entryType === "symlink"
    ? `${path} (deleted symlink)`
    : path;
}

function countSummary(additions: number, deletions: number, theme: RenderTheme): string {
  return `(${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${deletions}`)})`;
}

function comparePaths(left: string, right: string): number {
  if (process.platform === "win32") return left < right ? -1 : left > right ? 1 : 0;
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sortedChanges(details: ApplyPatchDetails, cwd: string): AppliedPatchChange[] {
  return coalesceAppliedPatchChangesForRendering(details.changes, cwd).toSorted((left, right) =>
    comparePaths(
      resolve(cwd, left.kind === "move" ? left.sourcePath : left.path),
      resolve(cwd, right.kind === "move" ? right.sourcePath : right.path),
    ),
  );
}

function diffPalette(theme: RenderTheme): DiffPalette {
  const light = usesLightToolPalette(theme);
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
    const match = line.match(/^([+\-\s])\s*(\d+)\s(.*)$/);
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
    if (change.content === undefined) return [];
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

function styleContent(line: DiffLine, theme: RenderTheme): string {
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
  theme: RenderTheme,
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

function renderHeader(
  changes: readonly AppliedPatchChange[],
  theme: RenderTheme,
  cwd: string,
): string {
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  if (changes.length === 1) {
    const change = changes[0];
    if (!change) throw new Error("A single-change diff has no change to render.");
    return `${theme.fg("dim", "• ")}${theme.bold(changeVerb(change))} ${changePath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`;
  }
  const noun = changes.length === 1 ? "file" : "files";
  return `${theme.fg("dim", "• ")}${theme.bold("Edited")} ${changes.length} ${noun} ${countSummary(additions, deletions, theme)}`;
}

function renderFailedChangeSummary(
  details: ApplyPatchDetails,
  changes: readonly AppliedPatchChange[],
  theme: RenderTheme,
  cwd: string,
): string[] {
  const summary = applyPatchSummaryPaths(details);
  const paths = [
    ...summary.added.map((path) => ({ status: "A", path })),
    ...summary.modified.map((path) => ({ status: "M", path })),
    ...summary.deleted.map((path) => ({ status: "D", path })),
  ];
  if (paths.length === 0) return [];
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const noun = paths.length === 1 ? "file" : "files";
  return [
    `${theme.fg("dim", "• ")}${theme.bold("Changed")} ${paths.length} ${noun} ${countSummary(additions, deletions, theme)}`,
    ...paths.map(
      ({ status, path }) => `  ${theme.fg("dim", "└ ")}${status} ${displayPath(path, cwd)}`,
    ),
  ];
}

function failedResultHasChangedFiles(details: ApplyPatchDetails): boolean {
  const summary = applyPatchSummaryPaths(details);
  return summary.added.length > 0 || summary.modified.length > 0 || summary.deleted.length > 0;
}

function failedResultHasNoChanges(details: ApplyPatchDetails): boolean {
  const hasUnverifiedState = (details.instructions ?? []).some((instruction) =>
    instruction.finalStates?.some((state) => state.state === "not-verified"),
  );
  return (
    !failedResultHasChangedFiles(details) &&
    !applyPatchHasOtherFilesystemChanges(details) &&
    !hasUnverifiedState
  );
}

function renderChange(
  change: AppliedPatchChange,
  width: number,
  theme: RenderTheme,
  palette: DiffPalette,
): string[] {
  const lines = changeDiffLines(change);
  if (change.kind === "move") return [];
  const languagePath = change.kind === "update" && change.moveTo ? change.moveTo : change.path;
  highlightDiffLines(lines, languagePath);
  const lineNumberWidth = lines.reduce(
    (maximum, line) =>
      line.lineNumber === undefined ? maximum : Math.max(maximum, String(line.lineNumber).length),
    1,
  );
  return lines.flatMap((line) => renderDiffLine(line, width, lineNumberWidth, theme, palette));
}

function instructionStatusLabel(status: ApplyPatchInstructionStatus, theme: RenderTheme): string {
  const label = `[${formatApplyPatchInstructionStatusLabel(status)}]`;
  switch (status) {
    case "applied":
      return theme.fg("success", label);
    case "failed":
      return theme.fg("error", label);
    case "dead":
    case "no-op":
    case "not-run":
    case "planned":
      return theme.fg("dim", label);
  }
}

function instructionLabel(instruction: ApplyPatchInstructionDetails, cwd: string): string {
  const verb =
    instruction.kind === "add"
      ? "Add"
      : instruction.kind === "delete"
        ? "Delete"
        : instruction.kind === "move"
          ? "Move"
          : "Update";
  const path = displayPath(instruction.path, cwd);
  if (!instruction.moveTo) return `${verb} ${path}`;
  return instruction.kind === "update"
    ? `Update & Move ${path} → ${displayPath(instruction.moveTo, cwd)}`
    : `${verb} ${path} → ${displayPath(instruction.moveTo, cwd)}`;
}

function instructionChanges(
  details: ApplyPatchDetails,
  instructionIndex: number,
): AppliedPatchChange[] {
  const instruction = details.instructions?.find(
    (candidate) => candidate.index === instructionIndex,
  );
  return (instruction?.changeIndexes ?? []).flatMap((index) => {
    const change = details.changes[index];
    return change && !(instruction?.status === "failed" && change.kind === "move" && !change.exact)
      ? [change]
      : [];
  });
}

function renderInstructionResults(
  details: ApplyPatchDetails,
  theme: RenderTheme,
  cwd: string,
  expanded: boolean,
  width?: number,
): string[] {
  const lines: string[] = [];
  const instructions = details.instructions ?? [];
  if (!applyPatchNeedsInstructionResults(details, cwd)) return lines;
  lines.push(theme.bold("Patch instruction results:"));
  const palette = diffPalette(theme);
  for (const instruction of instructions) {
    const feedback = formatApplyPatchInstructionFeedback(instruction, details, cwd);
    lines.push(
      `  ${instruction.index}. ${instructionStatusLabel(instruction.status, theme)} ${instructionLabel(instruction, cwd)}${feedback ? ` ${theme.fg("dim", `— ${feedback}`)}` : ""}`,
    );
    if (expanded && width !== undefined) {
      const changes = instructionChanges(details, instruction.index);
      const inset = Math.min(4, Math.max(0, width - 1));
      const contentWidth = Math.max(1, width - inset);
      for (const change of changes) {
        lines.push(
          ...renderChange(change, contentWidth, theme, palette).map(
            (line) => `${" ".repeat(inset)}${line}`,
          ),
        );
      }
    } else if (expanded) {
      for (const change of instructionChanges(details, instruction.index)) {
        lines.push(
          ...changeDiffLines(change).map((line) => {
            if (line.separator) return `    ${theme.fg("dim", "⋮")}`;
            const sign = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
            return `    ${sign}${line.lineNumber ?? ""} ${line.content}`;
          }),
        );
      }
    }
  }
  return lines;
}

export function formatApplyPatchRenderText(
  details: ApplyPatchDetails,
  theme: RenderTheme,
  cwd = process.cwd(),
): string {
  const lines: string[] = [];
  const changes = sortedChanges(details, cwd);
  const showInstructionResults = applyPatchNeedsInstructionResults(details, cwd);
  if (details.status === "failed") {
    lines.push(...renderFailedChangeSummary(details, changes, theme, cwd));
  } else if (changes.length > 0) {
    lines.push(renderHeader(changes, theme, cwd));
    for (const [index, change] of changes.entries()) {
      if (changes.length > 1) {
        lines.push(
          `  ${theme.fg("dim", "└ ")}${changeListPath(change, cwd)} ${countSummary(change.additions, change.deletions, theme)}`,
        );
      }
      if (!showInstructionResults) {
        lines.push(
          ...changeDiffLines(change).map((line) => {
            if (line.separator) return `    ${theme.fg("dim", "⋮")}`;
            const sign = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
            return `    ${sign}${line.lineNumber ?? ""} ${line.content}`;
          }),
        );
      }
      if (index !== changes.length - 1) lines.push("");
    }
  }
  if (details?.status === "failed") {
    if (lines.length > 0) lines.push("");
    lines.push(theme.bold(theme.fg("error", "✘ Failed to apply patch")));
    lines.push(
      ...formatApplyPatchFailureHeading(details).map((line) => `  ${theme.fg("dim", line)}`),
    );
    if (failedResultHasNoChanges(details)) lines.push("  No files were changed.");
    else if (
      !failedResultHasChangedFiles(details) &&
      applyPatchHasOtherFilesystemChanges(details)
    ) {
      lines.push("  Filesystem changed.");
    }
  } else {
    if (changes.length === 0) lines.push(theme.bold("Success. No files were changed."));
  }
  if (showInstructionResults) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderInstructionResults(details, theme, cwd, true));
  }
  return lines.join("\n");
}

export class ApplyPatchDiffComponent implements Component {
  private readonly details: ApplyPatchDetails;
  private readonly theme: RenderTheme;
  private readonly cwd: string;
  private readonly expanded: boolean;

  constructor(details: ApplyPatchDetails, theme: RenderTheme, cwd: string, expanded: boolean) {
    this.details = details;
    this.theme = theme;
    this.cwd = cwd;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(1, width);
    const changes = sortedChanges(this.details, this.cwd);
    const showInstructionResults = applyPatchNeedsInstructionResults(this.details, this.cwd);
    const lines: string[] = [];

    if (this.details.status === "failed") {
      for (const line of renderFailedChangeSummary(this.details, changes, this.theme, this.cwd)) {
        lines.push(...wrapTextWithAnsi(line, effectiveWidth));
      }
    } else if (changes.length > 0) {
      lines.push(...wrapTextWithAnsi(renderHeader(changes, this.theme, this.cwd), effectiveWidth));
      for (const [index, change] of changes.entries()) {
        if (this.expanded && index > 0) lines.push("");
        if (changes.length > 1) {
          const header = `  ${this.theme.fg("dim", "└ ")}${changeListPath(change, this.cwd)} ${countSummary(change.additions, change.deletions, this.theme)}`;
          lines.push(...wrapTextWithAnsi(header, effectiveWidth));
        }
        if (this.expanded && !showInstructionResults) {
          const inset = Math.min(4, Math.max(0, effectiveWidth - 1));
          const contentWidth = Math.max(1, effectiveWidth - inset);
          const palette = diffPalette(this.theme);
          lines.push(
            ...renderChange(change, contentWidth, this.theme, palette).map(
              (line) => `${" ".repeat(inset)}${line}`,
            ),
          );
        }
      }
    }

    if (this.details?.status === "failed") {
      if (lines.length > 0) lines.push("");
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.bold(this.theme.fg("error", "✘ Failed to apply patch")),
          effectiveWidth,
        ),
      );
      for (const line of formatApplyPatchFailureHeading(this.details)) {
        lines.push(...wrapTextWithAnsi(`  ${this.theme.fg("dim", line)}`, effectiveWidth));
      }
      if (failedResultHasNoChanges(this.details)) {
        lines.push(...wrapTextWithAnsi("  No files were changed.", effectiveWidth));
      } else if (
        !failedResultHasChangedFiles(this.details) &&
        applyPatchHasOtherFilesystemChanges(this.details)
      ) {
        lines.push(...wrapTextWithAnsi("  Filesystem changed.", effectiveWidth));
      }
    } else if (changes.length === 0) {
      lines.push(
        ...wrapTextWithAnsi(this.theme.bold("Success. No files were changed."), effectiveWidth),
      );
    }

    if (showInstructionResults) {
      if (lines.length > 0) lines.push("");
      for (const line of renderInstructionResults(
        this.details,
        this.theme,
        this.cwd,
        this.expanded,
        effectiveWidth,
      )) {
        lines.push(...wrapTextWithAnsi(line, effectiveWidth));
      }
    }

    return lines;
  }

  invalidate(): void {}
}
