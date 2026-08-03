import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import type { WebRunCommands } from "./web-run-schema.ts";

export type WebRunDetails = {
  results?: unknown[];
};

type WebRunRenderContext = {
  args: WebRunCommands;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
};

type WebRunResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quotePreview(value: string, maximum = 90): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  const preview =
    singleLine.length > maximum ? `${singleLine.slice(0, Math.max(0, maximum - 1))}…` : singleLine;
  return `"${preview}"`;
}

function itemCount(value: readonly unknown[] | undefined): number {
  return value?.length ?? 0;
}

function firstItem<T>(value: readonly T[] | undefined): T | undefined {
  return value?.[0];
}

function countDescription(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function queryDescription(
  kind: "search" | "image search",
  queries: readonly { q: string }[] | undefined,
): string | undefined {
  if (!queries || queries.length === 0) return undefined;
  if (queries.length === 1) return `${kind} ${quotePreview(queries[0]!.q)}`;
  return `${kind} ${countDescription(queries.length, "query", "queries")}`;
}

export function describeWebRunCall(args: WebRunCommands): string {
  const actions: string[] = [];
  const search = queryDescription("search", args.search_query);
  if (search) actions.push(search);
  const imageSearch = queryDescription("image search", args.image_query);
  if (imageSearch) actions.push(imageSearch);

  const open = firstItem(args.open);
  if (open) {
    actions.push(`open ${open.ref_id}${open.lineno === undefined ? "" : `:${open.lineno}`}`);
  }
  const click = firstItem(args.click);
  if (click) actions.push(`click ${click.id} in ${click.ref_id}`);
  const find = firstItem(args.find);
  if (find) actions.push(`find ${quotePreview(find.pattern)} in ${find.ref_id}`);
  const screenshot = firstItem(args.screenshot);
  if (screenshot) actions.push(`screenshot page ${screenshot.pageno + 1} of ${screenshot.ref_id}`);

  if (itemCount(args.finance) > 0) {
    const tickers = args.finance!.map((item) => item.ticker).join(", ");
    actions.push(`finance ${tickers}`);
  }
  if (itemCount(args.weather) > 0) {
    actions.push(`weather ${args.weather!.map((item) => item.location).join(", ")}`);
  }
  if (itemCount(args.sports) > 0) {
    const item = args.sports![0]!;
    actions.push(`${item.league.toUpperCase()} ${item.fn}${item.team ? ` for ${item.team}` : ""}`);
  }
  if (itemCount(args.time) > 0) {
    actions.push(`time ${args.time!.map((item) => item.utc_offset).join(", ")}`);
  }

  return actions.length > 0 ? actions.join(" · ") : "search";
}

function textOutput(result: WebRunResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function resultDetails(value: unknown): WebRunDetails | undefined {
  if (!isRecord(value)) return undefined;
  const results = value["results"];
  if (results !== undefined && !Array.isArray(results)) return undefined;
  return Array.isArray(results) ? { results } : {};
}

function resultRecords(details: WebRunDetails | undefined): JsonRecord[] {
  return (details?.results ?? []).filter(isRecord);
}

function resultDomains(results: readonly JsonRecord[]): string[] {
  return [
    ...new Set(
      results
        .map((item) => item["domain"])
        .filter((domain): domain is string => typeof domain === "string" && domain.length > 0),
    ),
  ];
}

function resultSummary(
  args: WebRunCommands,
  results: readonly JsonRecord[],
  output: string,
): string {
  if (results.length > 0) {
    const allText = results.every((item) => item["type"] === "text_result");
    const allImages = results.every((item) => item["type"] === "image_result");
    const noun = allText ? "source" : allImages ? "image" : "result";
    const domains = resultDomains(results);
    const domainSummary =
      domains.length === 0
        ? ""
        : domains.length <= 3
          ? ` · ${domains.join(", ")}`
          : ` · ${domains.slice(0, 3).join(", ")} +${domains.length - 3}`;
    return `Found ${countDescription(results.length, noun)}${domainSummary}`;
  }

  const opened = firstItem(args.open);
  if (opened) return `Opened ${opened.ref_id}`;
  const clicked = firstItem(args.click);
  if (clicked) return `Opened link ${clicked.id} from ${clicked.ref_id}`;
  const found = firstItem(args.find);
  if (found) return `Searched ${found.ref_id} for ${quotePreview(found.pattern)}`;
  const screenshot = firstItem(args.screenshot);
  if (screenshot) return `Captured page ${screenshot.pageno + 1} of ${screenshot.ref_id}`;
  if (itemCount(args.finance) > 0) return "Retrieved market data";
  if (itemCount(args.weather) > 0) return "Retrieved weather data";
  if (itemCount(args.sports) > 0) return "Retrieved sports data";
  if (itemCount(args.time) > 0) return "Retrieved time data";
  if (itemCount(args.image_query) > 0) return "Image search completed";
  if (itemCount(args.search_query) > 0) return "Web search completed";

  const firstLine = output
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? `Completed · ${firstLine}` : "Completed";
}

function detailLine(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

function formatStructuredResult(result: JsonRecord, index: number, theme: Theme): string[] {
  const title =
    typeof result["title"] === "string"
      ? result["title"]
      : typeof result["name"] === "string"
        ? result["name"]
        : typeof result["type"] === "string"
          ? result["type"].replaceAll("_", " ")
          : `Result ${index + 1}`;
  const domain = typeof result["domain"] === "string" ? result["domain"] : undefined;
  const reference = typeof result["ref_id"] === "string" ? result["ref_id"] : undefined;
  const url = typeof result["url"] === "string" ? result["url"] : undefined;
  const snippet = typeof result["snippet"] === "string" ? result["snippet"] : undefined;
  const lines = [`${theme.fg("dim", `${index + 1}.`)} ${theme.bold(title)}`];
  const metadata = detailLine([domain, reference]);
  if (metadata) lines.push(`   ${theme.fg("muted", metadata)}`);
  if (url) lines.push(`   ${theme.fg("accent", url)}`);
  if (snippet) lines.push(`   ${theme.fg("toolOutput", snippet)}`);

  if (!url && !snippet) {
    const knownKeys = new Set(["title", "name", "type", "domain", "ref_id"]);
    const remainder = Object.fromEntries(
      Object.entries(result).filter(([key]) => !knownKeys.has(key)),
    );
    if (Object.keys(remainder).length > 0) {
      lines.push(
        ...JSON.stringify(remainder, null, 2)
          .split("\n")
          .map((line) => `   ${theme.fg("toolOutput", line)}`),
      );
    }
  }
  return lines;
}

class WebRunResultComponent implements Component {
  private readonly args: WebRunCommands;
  private readonly result: WebRunResult;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly isError: boolean;

  constructor(
    args: WebRunCommands,
    result: WebRunResult,
    expanded: boolean,
    theme: Theme,
    isError: boolean,
  ) {
    this.args = args;
    this.result = result;
    this.expanded = expanded;
    this.theme = theme;
    this.isError = isError;
  }

  render(width: number): string[] {
    const output = textOutput(this.result);
    if (this.isError) {
      const lines = [this.theme.bold(this.theme.fg("error", "✘ web.run failed"))];
      if (this.expanded && output) {
        lines.push("", ...output.split("\n").map((line) => this.theme.fg("error", line)));
      }
      return wrapLines(lines, width);
    }

    const records = resultRecords(resultDetails(this.result.details));
    const lines = [
      `${this.theme.fg("dim", "• ")}${this.theme.bold(resultSummary(this.args, records, output))}`,
    ];
    if (!this.expanded) return wrapLines(lines, width);

    if (records.length > 0) {
      for (const [index, record] of records.entries()) {
        lines.push("", ...formatStructuredResult(record, index, this.theme));
      }
    } else if (output) {
      lines.push("", ...output.split("\n").map((line) => this.theme.fg("toolOutput", line)));
    }
    return wrapLines(lines, width);
  }

  invalidate(): void {}
}

export function renderWebRunCall(
  args: WebRunCommands,
  theme: Theme,
  context: WebRunRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  const title = theme.fg("toolTitle", theme.bold(WEB_RUN_TOOL_NAME));
  const summary = theme.fg("muted", describeWebRunCall(args));
  return new CodexToolSurfaceComponent(new Text(`${title}  ${summary}`, 0, 0), theme, {
    background: resolveBackground,
    status: context.isPartial ? "pending" : context.isError ? "error" : "success",
    top: true,
    bottom: context.isPartial,
  });
}

export function renderWebRunResult(
  result: WebRunResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: WebRunRenderContext,
  resolveBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
): Component {
  if (options.isPartial) return new Container();
  return new CodexToolSurfaceComponent(
    new WebRunResultComponent(context.args, result, options.expanded, theme, context.isError),
    theme,
    {
      background: resolveBackground,
      status: context.isError ? "error" : "success",
      top: false,
      bottom: true,
    },
  );
}
