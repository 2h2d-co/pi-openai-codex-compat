import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { ApplyPatchDiffComponent } from "../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import type { ApplyPatchDetails } from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  renderApplyPatchCall,
  renderApplyPatchResult,
} from "../extensions/openai-codex-compat/apply-patch-render.ts";
import {
  commandOutputPreviewLines,
  renderCommandCall,
  renderCommandResult,
} from "../extensions/openai-codex-compat/command-render.ts";
import {
  CodexToolSurfaceComponent,
  type RenderTheme,
} from "../extensions/openai-codex-compat/codex-tool-surface.ts";
import { renderImageGenerationResult } from "../extensions/openai-codex-compat/image-generation-render.ts";
import { renderWebRunResult } from "../extensions/openai-codex-compat/web-run-render.ts";

const plainTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("builds collapsed command output from only the retained tail", () => {
  const output = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");

  assert.deepEqual(commandOutputPreviewLines(output, false), [
    "… (995 earlier lines)",
    "line 996",
    "line 997",
    "line 998",
    "line 999",
    "line 1000",
  ]);
  assert.deepEqual(commandOutputPreviewLines("one\ntwo\nthree\nfour\nfive", false), [
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  assert.deepEqual(commandOutputPreviewLines("one\ntwo\nthree\nfour\nfive\n", false), [
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  assert.deepEqual(commandOutputPreviewLines("one\ntwo\nthree\nfour\nfive\n\n", false), [
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);
  assert.deepEqual(commandOutputPreviewLines("\n\n", false), []);
  assert.deepEqual(commandOutputPreviewLines("one\ntwo\nthree\nfour\nfive\nsix", true), [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
  ]);
});

test("normalizes command carriage returns before rendering", () => {
  assert.deepEqual(commandOutputPreviewLines("one\r\ntwo\r\n", true), ["one", "two"]);
  assert.deepEqual(commandOutputPreviewLines("one\rtwo\rthree", true), ["one", "two", "three"]);

  const rendered = renderCommandResult(
    {
      content: [
        {
          type: "text",
          text: 'Chunk ID: failure\nOutput:\n{\r\n  "message": "Not Found",\r\n  "status": "404"\r\n}gh: Not Found (HTTP 404)\n',
        },
      ],
    },
    { expanded: false, isPartial: false },
    plainTheme,
    { isError: false, isPartial: false },
    () => "none",
  ).render(80);

  assert.ok(rendered.every((line) => !line.includes("\r")));
  assert.ok(rendered.some((line) => line.includes('"message": "Not Found"')));
  assert.ok(rendered.some((line) => line.includes("}gh: Not Found (HTTP 404)")));
});

test("renders a yielded exec_command session ID before its output", () => {
  const rendered = renderCommandResult(
    {
      content: [
        {
          type: "text",
          text: "Chunk ID: abc123\nWall time: 1.0000 seconds\nProcess running with session ID 4321\nOriginal token count: 2\nOutput:\nready\n",
        },
      ],
    },
    { expanded: false, isPartial: false },
    plainTheme,
    { isError: false, isPartial: false },
    () => "none",
    { sessionId: 4_321 },
  )
    .render(80)
    .map((line) => line.trim())
    .filter(Boolean);

  assert.equal(rendered[0], "[session id: 4321]");
  assert.equal(rendered.at(-1), "ready");
});

test("balances command and apply_patch surface padding", () => {
  const commandCall = renderCommandCall(
    "exec_command",
    "printf output",
    undefined,
    undefined,
    plainTheme,
    { executionStarted: true, isError: false, isPartial: false },
    () => "none",
  ).render(40);
  const commandResult = renderCommandResult(
    { content: [{ type: "text", text: "output\n" }] },
    { expanded: false, isPartial: false },
    plainTheme,
    { isError: false, isPartial: false },
    () => "none",
  ).render(40);
  const applyPatchCall = renderApplyPatchCall(
    { patch: "*** Begin Patch\n*** End Patch\n" },
    plainTheme,
    {
      cwd: process.cwd(),
      expanded: false,
      isError: false,
      isPartial: false,
    },
    () => "none",
  ).render(40);
  const applyPatchResult = renderApplyPatchResult(
    {
      content: [{ type: "text", text: "Success. No files were changed.\n" }],
      details: {
        status: "completed",
        exact: true,
        changes: [],
        added: [],
        modified: [],
        deleted: [],
      },
    },
    { isPartial: false },
    plainTheme,
    {
      cwd: process.cwd(),
      expanded: false,
      isError: false,
      isPartial: false,
    },
    () => "none",
    () => true,
  ).render(40);

  const leadingBlankLines = (lines: string[]): number => {
    return lines.findIndex((line) => line.trim() !== "");
  };
  const trailingBlankLines = (lines: string[]): number => {
    return lines.findLastIndex((line) => line.trim() !== "") === -1
      ? lines.length
      : lines.length - 1 - lines.findLastIndex((line) => line.trim() !== "");
  };

  assert.equal(leadingBlankLines(commandCall), 1);
  assert.equal(leadingBlankLines(commandResult), 1);
  assert.equal(trailingBlankLines(commandResult), 1);
  assert.equal(leadingBlankLines(applyPatchCall), 1);
  assert.equal(leadingBlankLines(applyPatchResult), 1);
  assert.equal(trailingBlankLines(applyPatchResult), 1);
});

test("renders partial command output with balanced running padding", () => {
  const pendingCall = renderCommandCall(
    "exec_command",
    "stream output",
    "250ms",
    "/workspace",
    plainTheme,
    { executionStarted: false, isError: false, isPartial: true },
    () => "none",
  ).render(80);
  const runningCall = renderCommandCall(
    "exec_command",
    "stream output",
    "250ms",
    "/workspace",
    plainTheme,
    { executionStarted: true, isError: false, isPartial: true },
    () => "none",
  ).render(80);
  const emptyUpdate = renderCommandResult(
    { content: [] },
    { expanded: false, isPartial: true },
    plainTheme,
    { isError: false, isPartial: true },
    () => "none",
  ).render(80);
  const outputUpdate = renderCommandResult(
    { content: [{ type: "text", text: "first\nsecond\n" }] },
    { expanded: false, isPartial: true },
    plainTheme,
    { isError: false, isPartial: true },
    () => "none",
  ).render(80);

  assert.deepEqual(
    pendingCall.map((line) => line.trim()),
    ["", "exec_command  [yield: 250ms]  [workdir: /workspace]", "", "stream output", ""],
  );
  assert.deepEqual(
    [...runningCall, ...emptyUpdate].map((line) => line.trim()),
    ["", "exec_command  [yield: 250ms]  [workdir: /workspace]", "", "stream output", ""],
  );
  assert.deepEqual(
    [...runningCall, ...outputUpdate].map((line) => line.trim()),
    [
      "",
      "exec_command  [yield: 250ms]  [workdir: /workspace]",
      "",
      "stream output",
      "",
      "first",
      "second",
      "",
    ],
  );
});

test("emphasizes command calls while muting their output and metadata", () => {
  const colors = new Map<string, string>();
  const theme: RenderTheme = {
    fg: (color, text) => {
      colors.set(text, color);
      return text;
    },
    bold: (text) => text,
  };
  renderCommandCall(
    "exec_command",
    "highlighted command",
    "30s",
    "/workspace",
    theme,
    { executionStarted: true, isError: false, isPartial: true },
    () => "none",
  ).render(80);
  assert.equal(colors.get("exec_command"), "accent");
  assert.equal(colors.get("[yield: 30s]"), "muted");
  assert.equal(colors.get("[workdir: /workspace]"), "muted");
  assert.equal(colors.get("highlighted command"), "text");

  colors.clear();
  renderApplyPatchCall(
    { patch: "*** Begin Patch\n*** End Patch\n" },
    theme,
    {
      cwd: process.cwd(),
      expanded: false,
      isError: false,
      isPartial: false,
    },
    () => "none",
  ).render(80);
  assert.equal(colors.get("apply_patch"), "accent");

  colors.clear();
  renderCommandResult(
    {
      content: [
        {
          type: "text",
          text: "Chunk ID: abc123\nWall time: 1.0000 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nbright output\n",
        },
      ],
    },
    { expanded: true, isPartial: false },
    theme,
    { isError: false, isPartial: false },
    () => "none",
  ).render(80);

  assert.equal(colors.get("Chunk ID: abc123"), "dim");
  assert.equal(colors.get("Output:"), "dim");
  assert.equal(colors.get("bright output"), "muted");

  colors.clear();
  renderCommandResult(
    { content: [{ type: "text", text: "waiting" }] },
    { expanded: false, isPartial: false },
    theme,
    { isError: false, isPartial: false },
    () => "none",
    { sessionId: 4_321 },
  ).render(80);
  assert.equal(colors.get("[session id: 4321]"), "dim");

  colors.clear();
  renderCommandResult(
    { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\n" }] },
    { expanded: false, isPartial: true },
    theme,
    { isError: false, isPartial: true },
    () => "none",
  ).render(80);
  assert.equal(colors.get("… (1 earlier lines)"), "dim");
  assert.equal(colors.get("six"), "muted");
});

test("caches completed command rendering by width until invalidated", () => {
  let foregroundCalls = 0;
  const theme: RenderTheme = {
    fg: (_color, text) => {
      foregroundCalls++;
      return text;
    },
    bold: (text) => text,
  };
  const component = renderCommandResult(
    {
      content: [
        {
          type: "text",
          text: Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"),
        },
      ],
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: false, isPartial: false },
    () => "none",
  );

  const first = component.render(40);
  const callsAfterFirstRender = foregroundCalls;
  const second = component.render(40);
  assert.strictEqual(second, first);
  assert.equal(foregroundCalls, callsAfterFirstRender);

  const resized = component.render(32);
  assert.notStrictEqual(resized, first);
  assert.ok(foregroundCalls > callsAfterFirstRender);

  component.invalidate();
  const afterInvalidation = component.render(32);
  assert.notStrictEqual(afterInvalidation, resized);
  assert.deepEqual(afterInvalidation, resized);
});

test("reuses tool surface output while detecting child and background changes", () => {
  let text = "first";
  let background: "none" | "status" = "none";
  let invalidations = 0;
  const child: Component = {
    render: () => [text],
    invalidate: () => {
      invalidations++;
    },
  };
  const theme: RenderTheme = {
    ...plainTheme,
    getBgAnsi: () => "\u001b[48;5;22m",
  };
  const surface = new CodexToolSurfaceComponent(child, theme, {
    background: () => background,
    status: "success",
    top: false,
    bottom: false,
  });

  const first = surface.render(20);
  assert.strictEqual(surface.render(20), first);

  text = "second";
  const changedChild = surface.render(20);
  assert.notStrictEqual(changedChild, first);
  assert.match(changedChild.join("\n"), /second/u);

  background = "status";
  const changedBackground = surface.render(20);
  assert.notStrictEqual(changedBackground, changedChild);
  assert.ok(changedBackground.join("\n").includes("\u001b[48;5;22m"));

  surface.invalidate();
  assert.equal(invalidations, 1);
  assert.notStrictEqual(surface.render(20), changedBackground);
});

test("caches static apply_patch diff rendering by width", () => {
  const details: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
  };
  const component = new ApplyPatchDiffComponent(details, plainTheme, process.cwd(), false);

  const first = component.render(80);
  assert.strictEqual(component.render(80), first);

  const resized = component.render(60);
  assert.notStrictEqual(resized, first);

  component.invalidate();
  const afterInvalidation = component.render(60);
  assert.notStrictEqual(afterInvalidation, resized);
  assert.deepEqual(afterInvalidation, resized);
});

test("caches immutable extension child renderers until width, debug, or theme changes", () => {
  let foregroundCalls = 0;
  const theme: RenderTheme = {
    fg: (_color, text) => {
      foregroundCalls++;
      return text;
    },
    bold: (text) => text,
  };
  const assertCached = (component: Component): void => {
    component.render(80);
    const callsAfterFirstRender = foregroundCalls;
    component.render(80);
    assert.equal(foregroundCalls, callsAfterFirstRender);
    component.invalidate();
    component.render(80);
    assert.ok(foregroundCalls > callsAfterFirstRender);
  };

  assertCached(
    renderImageGenerationResult(
      {
        content: [{ type: "text", text: "generated" }],
        details: { operation: "generate", revisedPrompt: "A blue square" },
      },
      { expanded: false, isPartial: false },
      theme,
      {
        args: { prompt: "A blue square" },
        expanded: false,
        isError: false,
        isPartial: false,
      },
      () => "none",
    ),
  );
  assertCached(
    renderWebRunResult(
      {
        content: [{ type: "text", text: "No results" }],
        details: { results: [] },
      },
      { expanded: false, isPartial: false },
      theme,
      {
        args: { search_query: [{ q: "Pi" }] },
        expanded: false,
        isError: false,
        isPartial: false,
      },
      () => "none",
    ),
  );

  let debug = false;
  const applyPatch = renderApplyPatchCall(
    { patch: "*** Begin Patch\n*** End Patch\n" },
    theme,
    {
      cwd: process.cwd(),
      expanded: false,
      isError: false,
      isPartial: false,
    },
    () => "none",
    () => debug,
  );
  const ordinary = applyPatch.render(80);
  const callsAfterOrdinaryRender = foregroundCalls;
  assert.strictEqual(applyPatch.render(80), ordinary);
  assert.equal(foregroundCalls, callsAfterOrdinaryRender);

  debug = true;
  const debugLines = applyPatch.render(80);
  assert.notStrictEqual(debugLines, ordinary);
  assert.match(debugLines.join("\n"), /apply_patch \(debug\)/u);
});
