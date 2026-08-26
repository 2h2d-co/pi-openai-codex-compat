import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  decodeKittyPrintable,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { UnifiedExecProcessInfo } from "./command-runtime.ts";

const OUTPUT_PAGE_LINES = 10;
const LIVE_REFRESH_MS = 250;

export type BackgroundProcessBrowserAction =
  | { type: "close" }
  | { type: "inspect"; sessionId: number }
  | { type: "stop"; sessionId: number }
  | { type: "stop-all" };

export type BackgroundProcessDetailsAction = "close" | "stop";
type BackgroundProcessBrowserTheme = Pick<Theme, "bold" | "fg">;

export function singleLineCommand(command: string): string {
  const line = command.replaceAll(/\s+/gu, " ").trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function formatBackgroundProcesses(processes: readonly UnifiedExecProcessInfo[]): string {
  if (processes.length === 0) return "No background terminals running.";

  const maximum = 16;
  const lines = ["Background terminals"];
  for (const process of processes.slice(0, maximum)) {
    lines.push(
      `• session ${process.sessionId} · pid ${process.pid} · ${process.tty ? "PTY" : "pipes"} · ${singleLineCommand(process.command)}`,
      `  cwd: ${process.cwd}`,
    );
  }
  const remaining = processes.length - maximum;
  if (remaining > 0) lines.push(`... and ${remaining} more running`);
  return lines.join("\n");
}

function selectedSessionId(list: SelectList): number | undefined {
  const item = list.getSelectedItem();
  if (!item) return undefined;
  const sessionId = Number(item.value);
  return Number.isSafeInteger(sessionId) ? sessionId : undefined;
}

export function createBackgroundProcessBrowser(
  processes: readonly UnifiedExecProcessInfo[],
  theme: BackgroundProcessBrowserTheme,
  done: (action: BackgroundProcessBrowserAction) => void,
  requestRender: () => void,
): Component {
  const items: SelectItem[] = processes.map((process) => ({
    value: String(process.sessionId),
    label: `session ${process.sessionId} · ${process.tty ? "PTY" : "pipes"} · ${singleLineCommand(process.command)}`,
    description: `pid ${process.pid} · ${process.cwd}`,
  }));
  const list = new SelectList(items, Math.min(items.length, 12), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  list.onSelect = (item) => done({ type: "inspect", sessionId: Number(item.value) });
  list.onCancel = () => done({ type: "close" });

  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Background terminals")), 1, 0));
  container.addChild(list);
  container.addChild(
    new Text(
      [
        `${theme.fg("accent", "enter")} ${theme.fg("dim", "recent output")}`,
        `${theme.fg("accent", "ctrl+x")} ${theme.fg("dim", "stop selected")}`,
        `${theme.fg("accent", "ctrl+s")} ${theme.fg("dim", "stop all")}`,
        `${theme.fg("accent", "esc/q")} ${theme.fg("dim", "close")}`,
      ].join(" · "),
      1,
      0,
    ),
  );
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

  return {
    render: (width) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput(data) {
      if (matchesKey(data, Key.ctrl("x"))) {
        const sessionId = selectedSessionId(list);
        if (sessionId !== undefined) done({ type: "stop", sessionId });
        return;
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        done({ type: "stop-all" });
        return;
      }
      const printable = decodeKittyPrintable(data) ?? data;
      if (printable === "q" || matchesKey(data, Key.escape)) {
        done({ type: "close" });
        return;
      }
      list.handleInput(data);
      requestRender();
    },
  };
}

class BackgroundProcessDetails implements Component {
  private readonly observeProcess: () => UnifiedExecProcessInfo;
  private readonly theme: BackgroundProcessBrowserTheme;
  private readonly done: (action: BackgroundProcessDetailsAction) => void;
  private readonly requestRender: () => void;
  private scrollOffset = 0;
  private maximumScrollOffset = 0;
  private followingEnd = true;
  private readonly refreshTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(
    observeProcess: () => UnifiedExecProcessInfo,
    theme: BackgroundProcessBrowserTheme,
    done: (action: BackgroundProcessDetailsAction) => void,
    requestRender: () => void,
  ) {
    this.observeProcess = observeProcess;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.refreshTimer = setInterval(() => {
      if (!this.disposed) this.requestRender();
    }, LIVE_REFRESH_MS);
    this.refreshTimer.unref();
  }

  render(width: number): string[] {
    const process = this.observeProcess();
    const innerWidth = Math.max(1, width - 2);
    const output = stripTerminalSequences(process.recentOutput)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .trimEnd();
    const outputLines =
      output.length === 0
        ? [this.theme.fg("dim", "No output captured yet.")]
        : wrapTextWithAnsi(output, innerWidth);
    this.maximumScrollOffset = Math.max(0, outputLines.length - OUTPUT_PAGE_LINES);
    this.scrollOffset = this.followingEnd
      ? this.maximumScrollOffset
      : Math.min(this.maximumScrollOffset, Math.max(0, this.scrollOffset));
    const visibleOutput = outputLines.slice(
      this.scrollOffset,
      this.scrollOffset + OUTPUT_PAGE_LINES,
    );
    const above = this.scrollOffset;
    const below = Math.max(0, outputLines.length - this.scrollOffset - visibleOutput.length);
    const status = process.running
      ? this.theme.fg("warning", "running")
      : this.theme.fg(
          process.exitCode === 0 ? "success" : "error",
          process.exitCode === undefined ? "stopped" : `exited ${process.exitCode}`,
        );
    const line = (text: string): string => truncateToWidth(` ${text}`, width, "");

    const lines = [
      ...new DynamicBorder((text: string) => this.theme.fg("accent", text)).render(width),
      line(
        this.theme.fg(
          "accent",
          this.theme.bold(`Session ${process.sessionId} · ${process.tty ? "PTY" : "pipes"}`),
        ),
      ),
      line(`${status} · pid ${process.pid}`),
      line(this.theme.fg("muted", `cwd: ${process.cwd}`)),
      line(this.theme.fg("muted", `command: ${singleLineCommand(process.command)}`)),
      line(this.theme.fg("accent", this.theme.bold("Recent output"))),
      ...visibleOutput.map((outputLine) => truncateToWidth(outputLine, width, "")),
    ];
    for (let index = visibleOutput.length; index < OUTPUT_PAGE_LINES; index++) lines.push("");
    lines.push(
      line(this.theme.fg("dim", `↑ ${above} lines · ↓ ${below} lines`)),
      line(
        [
          `${this.theme.fg("accent", "↑↓/pgup/pgdn")} ${this.theme.fg("dim", "scroll")}`,
          `${this.theme.fg("accent", "ctrl+x")} ${this.theme.fg("dim", "stop terminal")}`,
          `${this.theme.fg("accent", "esc/q")} ${this.theme.fg("dim", "back")}`,
        ].join(" · "),
      ),
      ...new DynamicBorder((text: string) => this.theme.fg("accent", text)).render(width),
    );
    return lines;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("x"))) {
      this.done("stop");
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === "q" || matchesKey(data, Key.escape)) {
      this.done("close");
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.followingEnd = false;
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(this.maximumScrollOffset, this.scrollOffset + 1);
      this.followingEnd = this.scrollOffset === this.maximumScrollOffset;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - OUTPUT_PAGE_LINES);
      this.followingEnd = false;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.maximumScrollOffset, this.scrollOffset + OUTPUT_PAGE_LINES);
      this.followingEnd = this.scrollOffset === this.maximumScrollOffset;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.followingEnd = false;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = this.maximumScrollOffset;
      this.followingEnd = true;
    } else {
      return;
    }
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
  }
}

export function createBackgroundProcessDetails(
  observeProcess: () => UnifiedExecProcessInfo,
  theme: BackgroundProcessBrowserTheme,
  done: (action: BackgroundProcessDetailsAction) => void,
  requestRender: () => void,
): Component & { dispose: () => void } {
  return new BackgroundProcessDetails(observeProcess, theme, done, requestRender);
}
