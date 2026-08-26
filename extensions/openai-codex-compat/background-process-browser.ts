import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  decodeKittyPrintable,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import type { UnifiedExecProcessInfo } from "./command-runtime.ts";

export type BackgroundProcessBrowserAction = "close" | "stop";
type BackgroundProcessBrowserTheme = Pick<Theme, "bold" | "fg">;

function singleLineCommand(command: string): string {
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
  list.onSelect = () => done("close");
  list.onCancel = () => done("close");

  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Background terminals")), 1, 0));
  container.addChild(list);
  container.addChild(
    new Text(
      `${theme.fg("accent", "s")} ${theme.fg("dim", "stop all")} · ${theme.fg("accent", "enter/esc/q")} ${theme.fg("dim", "close")}`,
      1,
      0,
    ),
  );
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

  return {
    render: (width) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput(data) {
      const printable = decodeKittyPrintable(data) ?? data;
      if (printable === "s") {
        done("stop");
        return;
      }
      if (printable === "q" || matchesKey(data, Key.escape)) {
        done("close");
        return;
      }
      list.handleInput(data);
      requestRender();
    },
  };
}
