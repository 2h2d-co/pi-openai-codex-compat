import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  describeWebRunCall,
  renderWebRunResult,
} from "../extensions/openai-codex-compat/web-run-render.ts";
import type { WebRunCommands } from "../extensions/openai-codex-compat/web-run-schema.ts";

const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "gu");
const SEPARATOR =
  "--------------------------------------------------------------------------------";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getBgAnsi: () => "\u001b[48;2;40;50;40m",
  getColorMode: () => "truecolor",
  name: "dark",
} as unknown as Theme;

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE_PATTERN, "");
}

function renderResult(
  args: WebRunCommands,
  output: string,
  expanded: boolean,
  details: unknown = { results: [] },
): string {
  return stripAnsi(
    renderWebRunResult(
      { content: [{ type: "text", text: output }], details },
      { expanded, isPartial: false },
      theme,
      { args, expanded, isPartial: false, isError: false },
    )
      .render(140)
      .join("\n"),
  );
}

void test("summarizes every item in every web.run action family", () => {
  const description = describeWebRunCall({
    search_query: [{ q: "one" }, { q: "two" }, { q: "three" }],
    image_query: [{ q: "image one" }, { q: "image two" }],
    open: [
      { ref_id: "turn1search0", lineno: null },
      { ref_id: "turn1search1" },
      { ref_id: "turn1search2" },
    ],
    click: [
      { ref_id: "turn1view0", id: 4 },
      { ref_id: "turn1view0", id: 5 },
    ],
    find: [
      { ref_id: "turn1view0", pattern: "alpha" },
      { ref_id: "turn1view0", pattern: "beta" },
    ],
    screenshot: [
      { ref_id: "turn1view1", pageno: 0 },
      { ref_id: "turn1view1", pageno: 2 },
    ],
    finance: [
      { ticker: "AAPL", type: "equity" },
      { ticker: "BTC", type: "crypto" },
    ],
    weather: [{ location: "United States, California, San Francisco", duration: 3 }],
    sports: [
      { fn: "schedule", league: "nba", team: "GSW", num_games: 3 },
      { fn: "standings", league: "epl" },
    ],
    time: [{ utc_offset: "+00:00" }, { utc_offset: "+03:00" }],
  });

  assert.match(description, /search "one", "two" \+1/);
  assert.match(description, /image search "image one", "image two"/);
  assert.match(description, /open turn1search0, turn1search1 \+1/);
  assert.match(description, /click 4 in turn1view0, 5 in turn1view0/);
  assert.match(description, /find "alpha" in turn1view0, "beta" in turn1view0/);
  assert.match(description, /screenshot page 1 of turn1view1, page 3 of turn1view1/);
  assert.match(description, /finance AAPL, BTC/);
  assert.match(description, /weather United States, California, San Francisco/);
  assert.match(description, /NBA schedule for GSW, EPL standings for EPL/);
  assert.match(description, /time \+00:00, \+03:00/);
});

void test("renders image search output as source cards instead of a text blob", () => {
  const output = [
    [
      "Blue square icon (https://www.images.example/blue)",
      "citeturn2image0 # Blue Square",
      "",
      "A clean blue square on a white background.",
    ].join("\n"),
    [
      "Pi symbol (https://another.example/pi)",
      "citeturn2image1 # Pi Symbol",
      "",
      "A white Pi glyph.",
    ].join("\n"),
  ].join(SEPARATOR);
  const args = { image_query: [{ q: "blue Pi icon" }] };

  const collapsed = renderResult(args, output, false);
  assert.match(collapsed, /Found 2 images · images\.example, another\.example/);
  assert.doesNotMatch(collapsed, /clean blue square/);

  const expanded = renderResult(args, output, true);
  assert.match(expanded, /1\. Blue square icon/);
  assert.match(expanded, /turn2image0/);
  assert.match(expanded, /https:\/\/www\.images\.example\/blue/);
  assert.match(expanded, /Blue Square/);
  assert.match(expanded, /A clean blue square/);
  assert.doesNotMatch(expanded, /-{20}/);
});

void test("renders open, click, and find output with page metadata and line gutters", () => {
  const output = [
    "Example documentation (https://example.com/docs)",
    'citeturn3view0 [wordlim: 200] Crawled: today; Content type: text/html; Source: open({"ref_id":"turn3search0"}); Total lines: 42',
    "L20: Introduction",
    "L21: # Quickstart",
    "L22: Install the package.",
  ].join("\n");

  const opened = renderResult({ open: [{ ref_id: "turn3search0", lineno: 20 }] }, output, false);
  assert.match(opened, /Opened Example documentation · example\.com · 42 lines/);

  const clicked = renderResult({ click: [{ ref_id: "turn3view0", id: 7 }] }, output, false);
  assert.match(clicked, /Opened Example documentation · example\.com · 42 lines/);

  const found = renderResult(
    { find: [{ ref_id: "turn3view0", pattern: "Quickstart" }] },
    output,
    false,
  );
  assert.match(found, /Searched Example documentation for "Quickstart" · 42 lines/);

  const expanded = renderResult(
    { find: [{ ref_id: "turn3view0", pattern: "Quickstart" }] },
    output,
    true,
  );
  assert.match(expanded, /Example documentation/);
  assert.match(expanded, /turn3view0/);
  assert.match(expanded, /200-word excerpt/);
  assert.match(expanded, /HTML/);
  assert.match(expanded, /L20\s+│ Introduction/);
  assert.match(expanded, /L21\s+│ Quickstart/);
  assert.doesNotMatch(expanded, /Source: open/);
});

void test("renders PDF screenshots as concise page cards", () => {
  const output = [
    " (https://cdn.example/guide.pdf)",
    "citeturn4view0 ",
    SEPARATOR,
    " (https://cdn.example/guide.pdf)",
    "citeturn4view1 ",
  ].join("\n");
  const args = {
    screenshot: [
      { ref_id: "turn4pdf0", pageno: 0 },
      { ref_id: "turn4pdf0", pageno: 2 },
    ],
  };

  const collapsed = renderResult(args, output, false);
  assert.match(collapsed, /Processed 2 PDF pages 1, 3 · reference only · cdn\.example/);

  const single = renderResult(
    { screenshot: [{ ref_id: "turn4pdf0", pageno: 0 }] },
    output.split(SEPARATOR)[0]!,
    false,
  );
  assert.match(single, /Processed PDF page 1 · reference only · cdn\.example/);
  assert.doesNotMatch(single, /Processed 1 PDF page/);

  const expanded = renderResult(args, output, true);
  assert.match(expanded, /turn4pdf0 · page 1/);
  assert.match(expanded, /turn4view0/);
  assert.match(expanded, /https:\/\/cdn\.example\/guide\.pdf/);
  assert.match(expanded, /turn4pdf0 · page 3/);
});

void test("renders finance, weather, sports, and time as operation-specific cards", () => {
  const financeOutput = [
    "citeturn5finance0 AAPL closed at $213.12, up 1.4%.",
    "citeturn5finance1 BTC is trading at $67,420.",
  ].join(SEPARATOR);
  const financeArgs = {
    finance: [
      { ticker: "AAPL", type: "equity" as const, market: "USA" },
      { ticker: "BTC", type: "crypto" as const, market: "" },
    ],
  };
  assert.match(renderResult(financeArgs, financeOutput, false), /Quotes for AAPL, BTC/);
  const financeExpanded = renderResult(financeArgs, financeOutput, true);
  assert.match(financeExpanded, /1\. AAPL/);
  assert.match(financeExpanded, /turn5finance0/);
  assert.match(financeExpanded, /AAPL closed at \$213\.12/);
  assert.match(financeExpanded, /2\. BTC/);

  const weatherOutput = [
    "citeturn6weather0 San Francisco: 18°C, clear",
    "Monday: 19°C / 12°C · Sunny",
    "Tuesday: 17°C / 11°C · Partly cloudy",
  ].join("\n");
  const weatherArgs = {
    weather: [{ location: "United States, California, San Francisco", duration: 2 }],
  };
  assert.match(
    renderResult(weatherArgs, weatherOutput, false),
    /Forecast for San Francisco · 2 days/,
  );
  const weatherExpanded = renderResult(weatherArgs, weatherOutput, true);
  assert.match(weatherExpanded, /United States, California, San Francisco/);
  assert.match(weatherExpanded, /Monday: 19°C/);

  const sportsOutput = [
    "citeturn7sports0 Golden State Warriors schedule",
    "Date | Opponent | Time",
    "Aug 4 | LAL | 7:00 PM",
    "Aug 6 | SAC | 7:30 PM",
  ].join("\n");
  const sportsArgs = {
    sports: [{ fn: "schedule" as const, league: "nba" as const, team: "GSW", num_games: 2 }],
  };
  assert.match(renderResult(sportsArgs, sportsOutput, false), /NBA schedule · GSW · 2 games/);
  const sportsExpanded = renderResult(sportsArgs, sportsOutput, true);
  assert.match(sportsExpanded, /NBA schedule for GSW/);
  assert.match(sportsExpanded, /Date \| Opponent \| Time/);

  const timeOutput = [
    "citeturn8time0 The time in UTC+00:00 is Aug 3, 2026, 7:46:15 AM",
    "citeturn8time1 The time in UTC+03:00 is Aug 3, 2026, 10:46:15 AM",
  ].join(SEPARATOR);
  const timeArgs = { time: [{ utc_offset: "+00:00" }, { utc_offset: "+03:00" }] };
  assert.match(
    renderResult(timeArgs, timeOutput, false),
    /UTC\+00:00 7:46:15 AM, UTC\+03:00 10:46:15 AM/,
  );
  const timeExpanded = renderResult(timeArgs, timeOutput, true);
  assert.match(timeExpanded, /1\. \+00:00/);
  assert.match(timeExpanded, /turn8time0/);
  assert.match(timeExpanded, /The time in UTC\+00:00/);
});

void test("renders opaque structured result fields as readable labels", () => {
  const result = {
    type: "market_result",
    name: "AAPL",
    ref_id: "turn9finance0",
    price: 213.12,
    change: { amount: 2.95, percent: 1.4 },
    exchanges: ["NASDAQ", "BATS"],
  };
  const expanded = renderResult(
    { finance: [{ ticker: "AAPL", type: "equity" }] },
    "AAPL quote",
    true,
    { results: [result] },
  );

  assert.match(expanded, /1\. AAPL/);
  assert.match(expanded, /Price: 213\.12/);
  assert.match(expanded, /Change › Amount: 2\.95/);
  assert.match(expanded, /Change › Percent: 1\.4/);
  assert.match(expanded, /Exchanges: NASDAQ, BATS/);
  assert.doesNotMatch(expanded, /"price":/);
});

void test("renders empty and unavailable operations as warnings rather than successful results", () => {
  const empty = renderResult(
    { image_query: [{ q: "missing image" }] },
    "Empty search results\nNo results were found for the provided queries",
    false,
  );
  assert.match(empty, /No images found/);
  assert.doesNotMatch(empty, /Found 1 image/);

  const unavailable = renderResult(
    { screenshot: [{ ref_id: "turn10search0", pageno: 0 }] },
    [
      "Internal Error ()",
      "citeturn10view0 [wordlim: 200] Unable to resolve screenshot call",
      "L0: Unable to resolve screenshot call because content is not a PDF",
    ].join("\n"),
    true,
    {
      results: [
        {
          type: "text_result",
          title: "Stale source metadata",
          url: "https://example.com/stale",
        },
      ],
    },
  );
  assert.match(unavailable, /Screenshot unavailable/);
  assert.match(unavailable, /1\. Internal Error/);
  assert.match(unavailable, /Unable to resolve screenshot call/);
  assert.doesNotMatch(unavailable, /Stale source metadata/);
});
