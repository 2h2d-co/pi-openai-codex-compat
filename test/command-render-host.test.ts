import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
  ToolExecutionComponent,
  type ToolRenderers,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import registerCommandTools from "../extensions/openai-codex-compat/command-tools.ts";

function commandComponent(): ToolExecutionComponent {
  let renderer: ToolRenderers | undefined;
  registerCommandTools({
    on: () => () => {},
    registerCommand() {},
    registerTool(tool) {
      if (tool.name === "exec_command") renderer = tool;
    },
  });
  assert.ok(renderer);
  initTheme("dark", false);
  const ui = new TuiMainScreen(new ProcessTerminal());
  ui.requestRender = () => {};
  return new ToolExecutionComponent(
    "exec_command",
    "render-test",
    { cmd: "printf diagnostic", workdir: "/workspace" },
    {},
    renderer,
    ui,
    "/workspace",
  );
}

for (const executionStarted of [false, true]) {
  for (const message of ["Codex error: overloaded", "Operation aborted", "Spawn failed"]) {
    test(`keeps ${message} boxed with executionStarted=${executionStarted}`, () => {
      const component = commandComponent();
      if (executionStarted) component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: message }], isError: true });
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        for (const width of [40, 100]) {
          const lines = component.render(width);
          const plain = lines.map(stripVTControlCharacters);
          const errorRow = plain.findIndex((line) => line.includes(message));
          assert.ok(errorRow > 0);
          assert.equal(plain[errorRow]?.trim(), message);
          assert.ok(plain[errorRow]?.startsWith(" "));
          assert.equal(plain[errorRow - 1]?.trim(), "");
          assert.equal(plain[errorRow + 1]?.trim(), "");
          for (const row of [errorRow - 1, errorRow, errorRow + 1]) {
            assert.ok(lines[row]?.includes("\u001b[48;"));
          }
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
        }
      }
    });
  }
}

test("updates yielded session IDs and clears stale metadata on final errors", () => {
  const component = commandComponent();
  component.markExecutionStarted();
  const rendered = () => component.render(100).map(stripVTControlCharacters).join("\n");
  component.updateResult({
    content: [{ type: "text", text: "Process running" }],
    details: { sessionId: 4321 },
    isError: false,
  });
  assert.match(rendered(), /\[session id: 4321\]/u);
  component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
  assert.match(rendered(), /\[session id: 4321\]/u);
  component.updateResult({
    content: [{ type: "text", text: "Operation aborted" }],
    isError: true,
  });
  assert.doesNotMatch(rendered(), /\[session id:/u);
  assert.match(rendered(), / Operation aborted/u);
});

test("renders successful final output without a session ID", () => {
  const component = commandComponent();
  component.markExecutionStarted();
  component.updateResult({
    content: [{ type: "text", text: "Process running" }],
    details: { sessionId: 4321 },
    isError: false,
  });
  component.updateResult({
    content: [{ type: "text", text: "Output:\nfinished" }],
    details: { exitCode: 0 },
    isError: false,
  });
  const lines = component.render(100).map(stripVTControlCharacters);
  assert.doesNotMatch(lines.join("\n"), /\[session id:/u);
  assert.ok(lines.some((line) => line.trim() === "finished"));
  assert.equal(lines.at(-1)?.trim(), "");
});
