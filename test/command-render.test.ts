import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { ApplyPatchDiffComponent } from "../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import type { ApplyPatchDetails } from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  commandOutputPreviewLines,
  renderCommandResult,
} from "../extensions/openai-codex-compat/command-render.ts";
import {
  CodexToolSurfaceComponent,
  type RenderTheme,
} from "../extensions/openai-codex-compat/codex-tool-surface.ts";

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
    "… (1 earlier lines)",
    "two",
    "three",
    "four",
    "five",
    "",
  ]);
  assert.deepEqual(commandOutputPreviewLines("one\ntwo\nthree\nfour\nfive\nsix", true), [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
  ]);
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
