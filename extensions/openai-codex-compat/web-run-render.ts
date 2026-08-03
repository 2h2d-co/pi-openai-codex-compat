import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  CodexToolSurfaceComponent,
  type CodexToolBackgroundResolver,
} from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import {
  blockPlainText,
  outputDomains,
  outputLineRange,
  parseWebRunOutput,
  type WebRunOutputBlock,
  type WebRunOutputLine,
} from "./web-run-output.ts";
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
type WebRunAction =
  | "search"
  | "image"
  | "open"
  | "click"
  | "find"
  | "screenshot"
  | "finance"
  | "weather"
  | "sports"
  | "time";
type WebRunOutputState = "empty" | "failure";

const STRUCTURED_RESULT_KEYS = new Set([
  "caption",
  "description",
  "domain",
  "height",
  "image_url",
  "name",
  "ref_id",
  "snippet",
  "source_url",
  "thumbnail_url",
  "title",
  "type",
  "url",
  "width",
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function quotePreview(value: string, maximum = 90): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  const preview =
    singleLine.length > maximum ? `${singleLine.slice(0, Math.max(0, maximum - 1))}…` : singleLine;
  return `"${preview}"`;
}

function textPreview(value: string, maximum = 60): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > maximum
    ? `${singleLine.slice(0, Math.max(0, maximum - 1))}…`
    : singleLine;
}

function itemCount(value: readonly unknown[] | null | undefined): number {
  return value?.length ?? 0;
}

function firstItem<T>(value: readonly T[] | null | undefined): T | undefined {
  return value?.[0] ?? undefined;
}

function countDescription(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function previewItems<T>(
  items: readonly T[] | null | undefined,
  format: (item: T) => string,
  maximum = 2,
): string | undefined {
  if (!items || items.length === 0) return undefined;
  const visible = items.slice(0, maximum).map(format).join(", ");
  const remaining = items.length - maximum;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

function queryDescription(
  kind: "search" | "image search",
  queries: readonly { q: string }[] | null | undefined,
): string | undefined {
  const preview = previewItems(queries, (query) => quotePreview(query.q));
  return preview ? `${kind} ${preview}` : undefined;
}

function sportsDescription(item: NonNullable<WebRunCommands["sports"]>[number]): string {
  const subject = item.team
    ? item.opponent
      ? `${item.team} vs ${item.opponent}`
      : item.team
    : item.league.toUpperCase();
  return `${item.league.toUpperCase()} ${item.fn} for ${subject}`;
}

export function describeWebRunCall(args: WebRunCommands): string {
  const actions: string[] = [];
  const search = queryDescription("search", args.search_query);
  if (search) actions.push(search);
  const imageSearch = queryDescription("image search", args.image_query);
  if (imageSearch) actions.push(imageSearch);

  const opened = previewItems(
    args.open,
    (item) => `${item.ref_id}${item.lineno == null ? "" : `:${item.lineno}`}`,
  );
  if (opened) actions.push(`open ${opened}`);
  const clicked = previewItems(args.click, (item) => `${item.id} in ${item.ref_id}`);
  if (clicked) actions.push(`click ${clicked}`);
  const found = previewItems(
    args.find,
    (item) => `${quotePreview(item.pattern)} in ${item.ref_id}`,
  );
  if (found) actions.push(`find ${found}`);
  const screenshots = previewItems(
    args.screenshot,
    (item) => `page ${item.pageno + 1} of ${item.ref_id}`,
  );
  if (screenshots) actions.push(`screenshot ${screenshots}`);

  const tickers = previewItems(args.finance, (item) => item.ticker);
  if (tickers) actions.push(`finance ${tickers}`);
  const locations = previewItems(args.weather, (item) => item.location);
  if (locations) actions.push(`weather ${locations}`);
  const sports = previewItems(args.sports, sportsDescription);
  if (sports) actions.push(sports);
  const offsets = previewItems(args.time, (item) => item.utc_offset);
  if (offsets) actions.push(`time ${offsets}`);

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

function domainFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return displayDomain(new URL(value).hostname);
  } catch {
    return undefined;
  }
}

function displayDomain(value: string): string {
  return value.replace(/^www\./u, "");
}

function resultDomains(results: readonly JsonRecord[]): string[] {
  return [
    ...new Set(
      results.flatMap((item) => {
        const domain = stringField(item, "domain");
        const url = stringField(item, "url") ?? stringField(item, "source_url");
        return domain ? [displayDomain(domain)] : domainFromUrl(url) ? [domainFromUrl(url)!] : [];
      }),
    ),
  ];
}

function actionKinds(args: WebRunCommands): WebRunAction[] {
  const kinds: WebRunAction[] = [];
  if (itemCount(args.search_query) > 0) kinds.push("search");
  if (itemCount(args.image_query) > 0) kinds.push("image");
  if (itemCount(args.open) > 0) kinds.push("open");
  if (itemCount(args.click) > 0) kinds.push("click");
  if (itemCount(args.find) > 0) kinds.push("find");
  if (itemCount(args.screenshot) > 0) kinds.push("screenshot");
  if (itemCount(args.finance) > 0) kinds.push("finance");
  if (itemCount(args.weather) > 0) kinds.push("weather");
  if (itemCount(args.sports) > 0) kinds.push("sports");
  if (itemCount(args.time) > 0) kinds.push("time");
  return kinds;
}

function detailLine(parts: Array<string | undefined>): string {
  return [...new Set(parts.filter((part): part is string => Boolean(part)))].join(" · ");
}

function domainSummary(domains: readonly string[]): string {
  if (domains.length === 0) return "";
  return domains.length <= 3
    ? ` · ${domains.join(", ")}`
    : ` · ${domains.slice(0, 3).join(", ")} +${domains.length - 3}`;
}

function structuredResultSummary(results: readonly JsonRecord[]): string {
  const allText = results.every((item) => item["type"] === "text_result");
  const allImages = results.every((item) => item["type"] === "image_result");
  const noun = allText ? "source" : allImages ? "image" : "result";
  return `Found ${countDescription(results.length, noun)}${domainSummary(resultDomains(results))}`;
}

function outputState(output: string): WebRunOutputState | undefined {
  const prefix = output.trimStart().slice(0, 500);
  if (/^(?:Empty search results|No results were found)\b/iu.test(prefix)) return "empty";
  if (/^(?:Internal Error|Found no tool response)\b/iu.test(prefix)) return "failure";
  return undefined;
}

function actionLabel(action: WebRunAction | undefined): string {
  switch (action) {
    case "search":
      return "Search";
    case "image":
      return "Image search";
    case "open":
      return "Page";
    case "click":
      return "Link";
    case "find":
      return "Page search";
    case "screenshot":
      return "Screenshot";
    case "finance":
      return "Market data";
    case "weather":
      return "Weather";
    case "sports":
      return "Sports";
    case "time":
      return "Time";
    default:
      return "Web request";
  }
}

function blockTitle(blocks: readonly WebRunOutputBlock[]): string | undefined {
  return blocks.map((block) => block.title).find(Boolean);
}

function blockMetadataFact(
  blocks: readonly WebRunOutputBlock[],
  pattern: RegExp,
): string | undefined {
  return blocks.flatMap((block) => block.metadata).find((item) => pattern.test(item));
}

function locationPreview(location: string): string {
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? location;
}

function timeSummary(blocks: readonly WebRunOutputBlock[]): string | undefined {
  const entries = blocks.flatMap((block) => {
    const match = blockPlainText(block).match(/The time in (UTC[+-]\d{2}:\d{2}) is (.+?)(?:\s*)$/u);
    if (!match) return [];
    const clock = match[2]!.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)$/u)?.[1] ?? match[2]!;
    return [`${match[1]} ${clock.replace(/\s+/gu, " ")}`];
  });
  return previewItems(entries, (entry) => entry);
}

function actionResultSummary(
  action: WebRunAction,
  args: WebRunCommands,
  blocks: readonly WebRunOutputBlock[],
): string {
  const title = blockTitle(blocks);
  const compactTitle = title ? textPreview(title) : undefined;
  const domains = [...new Set(outputDomains(blocks).map(displayDomain))];
  const domain = domains[0];
  const domainDetail = compactTitle === domain ? undefined : domain;
  const lineRange = outputLineRange(blocks);
  const lineFact =
    blockMetadataFact(blocks, /^\d+ lines$/u) ??
    (lineRange
      ? lineRange.first === lineRange.last
        ? `line ${lineRange.first}`
        : `lines ${lineRange.first}–${lineRange.last}`
      : undefined);

  switch (action) {
    case "search":
      return `Found ${countDescription(blocks.length, "source")}${domainSummary(domains)}`;
    case "image":
      return `Found ${countDescription(blocks.length, "image")}${domainSummary(domains)}`;
    case "open":
      return detailLine([
        `Opened ${compactTitle ?? firstItem(args.open)?.ref_id ?? "page"}`,
        domainDetail,
        lineFact,
      ]);
    case "click":
      return detailLine([
        `Opened ${compactTitle ?? `link ${firstItem(args.click)?.id ?? ""}`.trim()}`,
        domainDetail,
        lineFact,
      ]);
    case "find": {
      const item = firstItem(args.find);
      return detailLine([
        `Searched ${compactTitle ?? item?.ref_id ?? "page"}${
          item ? ` for ${quotePreview(item.pattern)}` : ""
        }`,
        lineFact,
      ]);
    }
    case "screenshot": {
      const screenshots = args.screenshot ?? [];
      const pages = previewItems(screenshots, (item) => String(item.pageno + 1));
      const capture =
        screenshots.length === 1
          ? `Processed PDF page${pages ? ` ${pages}` : ""}`
          : `Processed ${countDescription(screenshots.length, "PDF page")}${
              pages ? ` ${pages}` : ""
            }`;
      return detailLine([capture, "reference only", compactTitle, domain]);
    }
    case "finance":
      return `Quotes for ${previewItems(args.finance, (item) => item.ticker) ?? "requested assets"}`;
    case "weather": {
      const weather = args.weather ?? [];
      const locations = previewItems(weather, (item) => locationPreview(item.location));
      const days = weather.length === 1 ? weather[0]?.duration : undefined;
      return detailLine([
        `Forecast for ${locations ?? "requested locations"}`,
        days == null ? undefined : countDescription(days, "day"),
      ]);
    }
    case "sports": {
      const sports = firstItem(args.sports);
      return sports
        ? `${sports.league.toUpperCase()} ${sports.fn}${
            sports.team ? ` · ${sports.team}` : ""
          }${sports.num_games ? ` · ${countDescription(sports.num_games, "game")}` : ""}`
        : "Sports results";
    }
    case "time":
      return timeSummary(blocks) ?? `${countDescription(itemCount(args.time), "time zone")}`;
  }
}

function resultSummary(
  args: WebRunCommands,
  results: readonly JsonRecord[],
  blocks: readonly WebRunOutputBlock[],
  state: WebRunOutputState | undefined,
): string {
  const actions = actionKinds(args);
  const action = actions.length === 1 ? actions[0] : undefined;
  if (state === "empty") return `No ${action === "image" ? "images" : "results"} found`;
  if (state === "failure") return `${actionLabel(action)} unavailable`;
  if (results.length > 0) return structuredResultSummary(results);
  if (action) return actionResultSummary(action, args, blocks);
  if (actions.length > 1) {
    return `Completed ${countDescription(actions.length, "web action")}`;
  }
  const firstText = blocks.flatMap((block) => block.lines).find((line) => line.text)?.text;
  return firstText ? `Completed · ${firstText}` : "Completed";
}

function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

function humanizeKey(key: string): string {
  return key.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return undefined;
}

function flattenFields(
  value: unknown,
  label: string,
  fields: Array<{ label: string; value: string }>,
): void {
  const scalar = scalarText(value);
  if (scalar !== undefined) {
    fields.push({ label, value: scalar });
    return;
  }
  if (Array.isArray(value)) {
    const scalars = value.map(scalarText);
    if (scalars.every((item) => item !== undefined)) {
      fields.push({ label, value: scalars.join(", ") });
      return;
    }
    for (const [index, item] of value.entries()) {
      flattenFields(item, `${label} ${index + 1}`, fields);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      flattenFields(item, `${label} › ${humanizeKey(key)}`, fields);
    }
  }
}

function additionalFields(result: JsonRecord): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(result)) {
    if (!STRUCTURED_RESULT_KEYS.has(key)) {
      flattenFields(value, humanizeKey(key), fields);
    }
  }
  return fields;
}

function formatStructuredResult(result: JsonRecord, index: number, theme: Theme): string[] {
  const type = stringField(result, "type");
  const title =
    stringField(result, "title") ??
    stringField(result, "name") ??
    type?.replaceAll("_", " ") ??
    `Result ${index + 1}`;
  const domain = stringField(result, "domain");
  const reference = stringField(result, "ref_id");
  const url = stringField(result, "url") ?? stringField(result, "source_url");
  const imageUrl = stringField(result, "image_url") ?? stringField(result, "thumbnail_url");
  const snippet =
    stringField(result, "snippet") ??
    stringField(result, "description") ??
    stringField(result, "caption");
  const width = result["width"];
  const height = result["height"];
  const dimensions =
    typeof width === "number" && typeof height === "number" ? `${width}×${height}` : undefined;
  const lines = [`${theme.fg("dim", `${index + 1}.`)} ${theme.bold(title)}`];
  const metadata = detailLine([domain, reference, dimensions, type?.replaceAll("_", " ")]);
  if (metadata) lines.push(`   ${theme.fg("muted", metadata)}`);
  if (url) lines.push(`   ${theme.fg("accent", url)}`);
  if (imageUrl && imageUrl !== url) {
    lines.push(`   ${theme.fg("muted", "Image")}  ${theme.fg("accent", imageUrl)}`);
  }
  if (snippet) lines.push(`   ${theme.fg("toolOutput", snippet)}`);
  for (const field of additionalFields(result)) {
    lines.push(`   ${theme.fg("muted", `${field.label}:`)} ${theme.fg("toolOutput", field.value)}`);
  }
  return lines;
}

function operationLabel(
  args: WebRunCommands,
  action: WebRunAction | undefined,
  index: number,
): string {
  switch (action) {
    case "search":
      return args.search_query?.[index]?.q ?? `Source ${index + 1}`;
    case "image":
      return args.image_query?.[index]?.q ?? `Image ${index + 1}`;
    case "open":
      return args.open?.[index]?.ref_id ?? `Page ${index + 1}`;
    case "click": {
      const item = args.click?.[index];
      return item ? `Link ${item.id} from ${item.ref_id}` : `Link ${index + 1}`;
    }
    case "find": {
      const item = args.find?.[index];
      return item ? `Find ${quotePreview(item.pattern)}` : `Match ${index + 1}`;
    }
    case "screenshot": {
      const item = args.screenshot?.[index];
      return item ? `${item.ref_id} · page ${item.pageno + 1}` : `Screenshot ${index + 1}`;
    }
    case "finance":
      return args.finance?.[index]?.ticker ?? `Quote ${index + 1}`;
    case "weather":
      return args.weather?.[index]?.location ?? `Forecast ${index + 1}`;
    case "sports": {
      const item = args.sports?.[index];
      return item ? sportsDescription(item) : `Sports result ${index + 1}`;
    }
    case "time":
      return args.time?.[index]?.utc_offset ?? `Time ${index + 1}`;
    default:
      return `Result ${index + 1}`;
  }
}

function sourceGutter(line: WebRunOutputLine, width: number, theme: Theme): string {
  if (line.line === undefined) return "";
  const page =
    line.page === undefined
      ? ""
      : line.pageEnd === undefined || line.pageEnd === line.page
        ? ` P${line.page + 1}`
        : ` P${line.page + 1}–${line.pageEnd + 1}`;
  return theme.fg("dim", `${`L${line.line}${page}`.padStart(width)} │ `);
}

function formatOutputLine(line: WebRunOutputLine, gutterWidth: number, theme: Theme): string {
  const gutter =
    line.line === undefined
      ? " ".repeat(gutterWidth + (gutterWidth > 0 ? 3 : 0))
      : sourceGutter(line, gutterWidth, theme);
  if (line.heading !== undefined) {
    return `${gutter}${theme.bold(theme.fg("toolOutput", line.text))}`;
  }
  if (/^https?:\/\//u.test(line.text)) {
    return `${gutter}${theme.fg("accent", line.text)}`;
  }
  return `${gutter}${theme.fg("toolOutput", line.text)}`;
}

function formatOutputBlock(
  block: WebRunOutputBlock,
  index: number,
  label: string,
  theme: Theme,
): string[] {
  const title = block.title ?? label;
  const domain = domainFromUrl(block.url);
  const references = block.references.join(", ");
  const metadata = block.metadata.filter((item) => !item.startsWith("Source:"));
  const contextLabel = block.title && block.title !== label ? label : undefined;
  const lines = [`${theme.fg("dim", `${index + 1}.`)} ${theme.bold(title)}`];
  const detail = detailLine([contextLabel, domain, references, ...metadata]);
  if (detail) lines.push(`   ${theme.fg("muted", detail)}`);
  if (block.url) lines.push(`   ${theme.fg("accent", block.url)}`);

  const gutterWidth = block.lines.reduce((maximum, line) => {
    if (line.line === undefined) return maximum;
    const page =
      line.page === undefined
        ? ""
        : line.pageEnd === undefined || line.pageEnd === line.page
          ? ` P${line.page + 1}`
          : ` P${line.page + 1}–${line.pageEnd + 1}`;
    return Math.max(maximum, `L${line.line}${page}`.length);
  }, 0);
  const body = block.lines.map((line) => formatOutputLine(line, gutterWidth, theme));
  if (body.some((line) => line.trim().length > 0)) lines.push(...body.map((line) => `   ${line}`));
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
    const blocks = parseWebRunOutput(output);
    const state = outputState(output);
    const summary = resultSummary(this.args, records, blocks, state);
    const lines = [
      `${this.theme.fg("dim", "• ")}${this.theme.bold(
        state ? this.theme.fg("warning", summary) : summary,
      )}`,
    ];
    if (!this.expanded) return wrapLines(lines, width);

    if (records.length > 0 && state === undefined) {
      for (const [index, record] of records.entries()) {
        lines.push("", ...formatStructuredResult(record, index, this.theme));
      }
    } else {
      const actions = actionKinds(this.args);
      const action = actions.length === 1 ? actions[0] : undefined;
      for (const [index, block] of blocks.entries()) {
        lines.push(
          "",
          ...formatOutputBlock(block, index, operationLabel(this.args, action, index), this.theme),
        );
      }
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
