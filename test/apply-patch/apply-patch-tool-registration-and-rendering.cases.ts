import { tuiFixture } from "../support/pi-fixtures.ts";
import { extensionContextFixture } from "../support/pi-fixtures.ts";
import { extensionApiFixture } from "../support/pi-fixtures.ts";
import {
  assert,
  writeFileSync,
  readFile,
  writeFile,
  join,
  test,
  initTheme,
  ToolExecutionComponent,
  visibleWidth,
  registerApplyPatch,
  APPLY_PATCH_LARK_GRAMMAR,
  ApplyPatchDiffComponent,
  formatApplyPatchRenderText,
  ANSI_BACKGROUND_PATTERN,
  stripAnsi,
  testTheme,
  requireApplyPatchDetails,
  workspace,
  type ToolDefinition,
  type ApplyPatchDetails,
  type CodexToolBackground,
} from "./apply-patch-harness.ts";

void test("registers the Codex freeform tool with model, UI, and failed-history parity", async (t) => {
  initTheme("dark", false);
  const cwd = await workspace(t);
  let registered: ToolDefinition | undefined;
  let toolResultHandler:
    | ((event: {
        toolName: string;
        toolCallId: string;
      }) => { details: ApplyPatchDetails } | undefined)
    | undefined;
  const pi = extensionApiFixture({
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
    on(event: string, handler: typeof toolResultHandler) {
      if (event === "tool_result") toolResultHandler = handler;
    },
  });

  let toolBackground: CodexToolBackground = "subtle";
  let applyPatchDebug = false;
  registerApplyPatch(
    pi,
    () => toolBackground,
    () => applyPatchDebug,
  );
  assert.ok(registered);
  const tool = registered;
  const renderCall = tool.renderCall;
  const renderResult = tool.renderResult;
  assert.ok(renderCall);
  assert.ok(renderResult);
  assert.equal(tool.name, "apply_patch");
  assert.equal(tool.promptSnippet, "Apply freeform patches to add, update, move, or delete files");
  assert.deepEqual(tool.promptGuidelines, [
    "Use `apply_patch` for local file edits.",
    "Do not create or edit files with `cat` or other shell write tricks.",
    "Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
  ]);
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.renderShell, "self");
  assert.deepEqual(tool.constrainedSampling, {
    type: "grammar",
    variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
  });

  const result = await tool.execute(
    "success-call",
    { patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch" },
    undefined,
    undefined,
    extensionContextFixture({ cwd }),
  );
  const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(
    resultText,
    /^Exit code: 0\nWall time: \d+(?:\.\d+)? seconds\nOutput:\nSuccess\. Updated the following files:\nA rendered\.txt\n$/,
  );
  assert.equal(requireApplyPatchDetails(result.details).changes[0]?.kind, "add");

  const theme = testTheme();
  const callComponent = renderCall(
    { patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch" },
    theme,
    {
      args: {
        patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch",
      },
      toolCallId: "success-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
    },
  );
  const renderedCall = callComponent.render(120).join("\n");
  assert.equal(stripAnsi(renderedCall).trim(), "apply_patch");
  assert.equal(renderedCall.split("\n").length, 2);
  assert.ok(renderedCall.includes("\u001b[48;2;26;26;33m"));
  toolBackground = "none";
  assert.equal(callComponent.render(120).join("\n").includes("\u001b[48"), false);
  toolBackground = "status";
  assert.ok(callComponent.render(120).join("\n").includes("\u001b[48;2;40;50;40m"));
  toolBackground = "subtle";

  const component = renderResult(result, { expanded: false, isPartial: false }, theme, {
    args: {
      patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch",
    },
    toolCallId: "success-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  });
  const renderedResult = component.render(120).join("\n");
  assert.match(renderedResult, /• Added rendered\.txt \(\+1 -0\)/);
  assert.doesNotMatch(stripAnsi(renderedResult), /Patch instruction results:/);
  assert.ok(!renderedResult.includes("\u001b[48;2;33;58;43m"));
  assert.ok(renderedResult.includes("\u001b[48;2;26;26;33m"));
  assert.doesNotMatch(stripAnsi(renderedResult), /1 \+hello/);

  const shellComponent = new ToolExecutionComponent(
    "apply_patch",
    "success-call",
    { patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch" },
    { showImages: false },
    tool,
    tuiFixture({ requestRender() {} }),
    cwd,
  );
  shellComponent.markExecutionStarted();
  shellComponent.setArgsComplete();
  shellComponent.updateResult({ ...result, isError: false });
  const shellRender = shellComponent.render(120).join("\n");
  const shellText = stripAnsi(shellRender);
  assert.match(shellText, /apply_patch/);
  assert.match(shellText, /• Added rendered\.txt \(\+1 -0\)/);
  assert.doesNotMatch(shellText, /1 \+hello/);
  assert.doesNotMatch(shellText, /Exit code:/);
  assert.ok(!shellRender.includes("\u001b[48;2;40;50;40m"));
  assert.ok((shellRender.match(ANSI_BACKGROUND_PATTERN) ?? []).length > 0);
  assert.ok(shellComponent.render(120).every((line) => visibleWidth(line) <= 120));

  applyPatchDebug = true;
  const debugShellText = stripAnsi(shellComponent.render(120).join("\n"));
  assert.match(debugShellText, /apply_patch \(debug\)\s+Exit code: 0/u);
  assert.doesNotMatch(debugShellText, /Model feedback:/u);
  assert.doesNotMatch(debugShellText, /Patch instruction results:/u);
  assert.doesNotMatch(debugShellText, /• Added rendered\.txt/u);

  shellComponent.setExpanded(true);
  const expandedShellRender = shellComponent.render(120).join("\n");
  const expandedShellText = stripAnsi(expandedShellRender);
  assert.match(expandedShellText, /apply_patch \(debug\)/u);
  assert.doesNotMatch(expandedShellText, /Model feedback:/u);
  assert.match(expandedShellText, /• Added rendered\.txt/u);
  assert.match(expandedShellText, /1 \+hello/);
  assert.ok(new Set(expandedShellRender.match(ANSI_BACKGROUND_PATTERN) ?? []).size >= 2);
  applyPatchDebug = false;

  const sortedText = formatApplyPatchRenderText(
    {
      status: "completed",
      exact: true,
      changes: [
        {
          kind: "add",
          path: "z.txt",
          content: "z\n",
          displayDiff: "+1 z",
          additions: 1,
          deletions: 0,
        },
        {
          kind: "add",
          path: "./a.txt",
          content: "a\n",
          displayDiff: "+1 a",
          additions: 1,
          deletions: 0,
        },
      ],
      added: ["z.txt", "./a.txt"],
      modified: [],
      deleted: [],
    },
    theme,
    cwd,
  );
  assert.ok(sortedText.indexOf("a.txt") < sortedText.indexOf("z.txt"));
  assert.doesNotMatch(sortedText, /Proposed/);

  const richDetails: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [
      {
        kind: "update",
        path: "old.ts",
        moveTo: "new.ts",
        oldContent: "const before = true;\n",
        newContent: "const after = true;\n",
        displayDiff: "-1 const before = true;\n+1 const after = true;",
        additions: 1,
        deletions: 1,
      },
      {
        kind: "delete",
        path: "obsolete.txt",
        entryType: "regular-file",
        content: "remove\n",
        displayDiff: "-1 remove",
        additions: 0,
        deletions: 1,
      },
    ],
    added: [],
    modified: ["new.ts"],
    deleted: ["obsolete.txt"],
  };
  const collapsedRichLines = new ApplyPatchDiffComponent(richDetails, theme, cwd, false).render(80);
  const collapsedRichText = stripAnsi(collapsedRichLines.join("\n"));
  assert.match(collapsedRichText, /• Edited 2 files \(\+1 -2\)/);
  assert.match(collapsedRichText, /old\.ts → new\.ts \(\+1 -1\)/);
  assert.match(collapsedRichText, /obsolete\.txt \(\+0 -1\)/);
  assert.doesNotMatch(collapsedRichText, /const before/);
  assert.doesNotMatch(collapsedRichText, /remove/);

  const richLines = new ApplyPatchDiffComponent(richDetails, theme, cwd, true).render(80);
  const richText = stripAnsi(richLines.join("\n"));
  assert.match(richText, /• Edited 2 files \(\+1 -2\)/);
  assert.match(richText, /old\.ts → new\.ts \(\+1 -1\)/);
  assert.match(richText, /1 -const before = true;/);
  assert.match(richText, /1 \+const after = true;/);
  assert.match(richText, /obsolete\.txt \(\+0 -1\)/);
  assert.match(richText, /1 -remove/);
  assert.ok(richLines.every((line) => visibleWidth(line) <= 80));

  const paddedLineDetails: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [
      {
        kind: "update",
        path: "before.ts",
        moveTo: "after.ts",
        oldContent: "",
        newContent: "",
        displayDiff: [
          "  72 if (state.preview) {",
          "- 73 oldCall();",
          "+ 73 firstNewCall();",
          "+ 74 secondNewCall();",
          "+ 75 thirdNewCall();",
          "     ...",
          "  98 if (renderDetails) {",
          "- 99 return oldResult;",
          "+101 return newResult;",
          " 100 }",
        ].join("\n"),
        additions: 4,
        deletions: 2,
      },
    ],
    added: [],
    modified: ["after.ts"],
    deleted: [],
  };
  const paddedLines = new ApplyPatchDiffComponent(paddedLineDetails, theme, cwd, true).render(120);
  const paddedAddedLines = paddedLines.filter((line) => line.includes("\u001b[48;2;33;58;43m"));
  const paddedDeletedLines = paddedLines.filter((line) => line.includes("\u001b[48;2;74;34;29m"));
  assert.deepEqual(
    paddedAddedLines.map((line) => stripAnsi(line).trim()),
    [
      "73 +firstNewCall();",
      "74 +secondNewCall();",
      "75 +thirdNewCall();",
      "101 +return newResult;",
    ],
  );
  assert.deepEqual(
    paddedDeletedLines.map((line) => stripAnsi(line).trim()),
    ["73 -oldCall();", "99 -return oldResult;"],
  );

  await writeFile(join(cwd, "partial-first.txt"), "before\n");
  await writeFile(join(cwd, "partial-second.txt"), "before\n");
  const failedPatch = `*** Begin Patch
*** Update File: partial-first.txt
@@
-before
+after
*** Update File: partial-second.txt
@@
-before
+again
*** End Patch`;
  const failedResult = await tool.execute(
    "failed-call",
    {
      patch: failedPatch,
    },
    undefined,
    undefined,
    extensionContextFixture({ cwd }),
  );
  assert.equal(requireApplyPatchDetails(failedResult.details).status, "completed");
  await writeFile(join(cwd, "partial-first.txt"), "before\n");
  await writeFile(join(cwd, "partial-second.txt"), "before\n");
  let failedModelFeedback = "";
  await assert.rejects(
    tool.execute(
      "failed-call",
      {
        patch: failedPatch,
      },
      undefined,
      (partial) => {
        if (requireApplyPatchDetails(partial.details).changes.length === 1) {
          writeFileSync(join(cwd, "partial-second.txt"), "external\n");
        }
      },
      extensionContextFixture({ cwd }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      failedModelFeedback = error.message;
      assert.match(error.message, /^Exit code: 1/u);
      assert.match(error.message, /Patch failed at instruction 2 of 2\./u);
      assert.match(error.message, /Files changed:\nM partial-first\.txt/u);
      assert.match(error.message, /1\. \[APPLIED\] Update partial-first\.txt/u);
      assert.match(error.message, /2\. \[FAILED\] Update partial-second\.txt/u);
      assert.match(error.message, /Filesystem changed after validation/u);
      assert.match(
        error.message,
        /The content at partial-second\.txt matches neither the requested content nor the previously observed content/u,
      );
      assert.doesNotMatch(error.message, /Committed prefix|exact|inexact|earlier change/u);
      assert.doesNotMatch(error.message, /[✓✘○↷→—]/u);
      return true;
    },
  );
  const patchedResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "failed-call",
  });
  assert.ok(patchedResult);
  assert.equal(patchedResult?.details.status, "failed");
  assert.equal(patchedResult?.details.changes.length, 1);
  assert.equal(patchedResult?.details.failure?.phase, "execution");
  assert.deepEqual(
    patchedResult?.details.instructions?.map(({ status }) => status),
    ["applied", "failed"],
  );
  assert.match(
    formatApplyPatchRenderText(patchedResult.details, theme, cwd),
    /Patch failed at instruction 2 of 2\./,
  );
  const failedComponent = renderResult(
    { content: [], details: patchedResult.details },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: failedPatch },
      toolCallId: "failed-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: true,
    },
  );
  const failedText = failedComponent.render(120).join("\n");
  assert.doesNotMatch(failedText, /again/);
  assert.match(failedText, /✘ Failed to apply patch/);
  assert.match(failedText, /Patch failed at instruction 2 of 2\./);
  assert.match(
    failedText,
    /2\. \[FAILED\] Update partial-second\.txt — Filesystem changed after validation/,
  );
  assert.doesNotMatch(failedText, /Committed prefix|exact|inexact|Preflight/);

  applyPatchDebug = true;
  const failedDebugComponent = renderResult(
    {
      content: [{ type: "text", text: failedModelFeedback }],
      details: patchedResult.details,
    },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: failedPatch },
      toolCallId: "failed-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: true,
    },
  );
  const failedDebugText = stripAnsi(failedDebugComponent.render(240).join("\n"));
  assert.match(failedDebugText, /^\s*Exit code: 1/u);
  assert.doesNotMatch(failedDebugText, /Model feedback:/u);
  assert.match(failedDebugText, /Patch failed at instruction 2 of 2\./u);
  assert.match(failedDebugText, /1\. \[APPLIED\] Update partial-first\.txt/u);
  assert.match(failedDebugText, /2\. \[FAILED\] Update partial-second\.txt/u);
  assert.doesNotMatch(failedDebugText, /✘ Failed to apply patch/u);
  applyPatchDebug = false;

  await writeFile(join(cwd, "cancel-first.txt"), "before\n");
  await writeFile(join(cwd, "cancel-second.txt"), "before\n");
  const cancellationController = new AbortController();
  const cancellationPatch = `*** Begin Patch
*** Update File: cancel-first.txt
@@
-before
+after
*** Update File: cancel-second.txt
@@
-before
+after
*** End Patch`;
  await assert.rejects(
    tool.execute(
      "cancelled-call",
      { patch: cancellationPatch },
      cancellationController.signal,
      (partial) => {
        if (requireApplyPatchDetails(partial.details).changes.length === 1) {
          cancellationController.abort();
        }
      },
      extensionContextFixture({ cwd }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Patch failed at instruction 2 of 2/u);
      assert.match(error.message, /Files changed:\nM cancel-first\.txt/u);
      assert.match(error.message, /1\. \[APPLIED\] Update cancel-first\.txt/u);
      assert.match(
        error.message,
        /2\. \[FAILED\] Update cancel-second\.txt - apply_patch was cancelled; cancel-second\.txt is unchanged\./u,
      );
      return true;
    },
  );
  const cancellationResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "cancelled-call",
  });
  assert.deepEqual(
    cancellationResult?.details.instructions?.map(({ status }) => status),
    ["applied", "failed"],
  );
  assert.equal(await readFile(join(cwd, "cancel-first.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "cancel-second.txt"), "utf8"), "before\n");

  await writeFile(join(cwd, "verification-existing.txt"), "keep\n");
  const verificationPatch = `*** Begin Patch
*** Add File: verification-created.txt
+created
*** Update File: verification-missing.txt
@@
-missing
+replacement
*** Delete File: verification-existing.txt
*** End Patch`;
  await assert.rejects(
    tool.execute(
      "verification-call",
      { patch: verificationPatch },
      undefined,
      undefined,
      extensionContextFixture({
        cwd,
      }),
    ),
    /Patch failed at instruction 2 of 3/,
  );
  const verificationResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "verification-call",
  });
  assert.ok(verificationResult);
  assert.equal(verificationResult?.details.failure?.phase, "preflight");
  assert.deepEqual(
    verificationResult?.details.instructions?.map(({ status }) => status),
    ["not-run", "failed", "not-run"],
  );
  const verificationComponent = renderResult(
    { content: [], details: verificationResult.details },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: verificationPatch },
      toolCallId: "verification-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: true,
    },
  );
  const verificationText = stripAnsi(verificationComponent.render(120).join("\n"));
  assert.match(verificationText, /Patch failed at instruction 2 of 3\./);
  assert.match(
    verificationText,
    /2\. \[FAILED\] Update verification-missing\.txt — Read failed: path does not exist\./,
  );
  assert.match(
    verificationText,
    /1\. \[NOT RUN\] Add verification-created\.txt — Instruction 2 failed\./,
  );
  assert.match(
    verificationText,
    /3\. \[NOT RUN\] Delete verification-existing\.txt — Instruction 2 failed\./,
  );

  const expandedVerificationComponent = renderResult(
    { content: [], details: verificationResult.details },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: verificationPatch },
      toolCallId: "verification-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: true,
    },
  );
  const expandedVerificationText = stripAnsi(expandedVerificationComponent.render(120).join("\n"));
  assert.match(
    expandedVerificationText,
    /1\. \[NOT RUN\] Add verification-created\.txt — Instruction 2 failed\./,
  );
  assert.match(
    expandedVerificationText,
    /3\. \[NOT RUN\] Delete verification-existing\.txt — Instruction 2 failed\./,
  );
  await assert.rejects(readFile(join(cwd, "verification-created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "verification-existing.txt"), "utf8"), "keep\n");

  await writeFile(
    join(cwd, "ordered.md"),
    ["## Earlier", "", "Earlier anchor.", "", "## Later", "", "Later anchor.", ""].join("\n"),
  );
  const reverseOrderedPatch = `*** Begin Patch
*** Update File: ordered.md
@@
 Later anchor.
+
+Later addition.
@@
 Earlier anchor.
+
+Earlier addition.
*** End Patch`;
  await assert.rejects(
    tool.execute(
      "matcher-call",
      { patch: reverseOrderedPatch },
      undefined,
      undefined,
      extensionContextFixture({
        cwd,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Patch failed at instruction 1 of 1\./u);
      assert.match(error.message, /No files were changed\./u);
      assert.match(
        error.message,
        /1\. \[FAILED\] Update ordered\.md - The requested changes match in reverse source-file order at line 4 and line 8\. Use apply_patch again with the requested changes in source-file order if needed\./u,
      );
      assert.doesNotMatch(error.message, /Later anchor|Earlier anchor|Matcher diagnostics/u);
      return true;
    },
  );
  const matcherResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "matcher-call",
  });
  assert.ok(matcherResult);
  assert.equal(matcherResult?.details.failure?.matcher?.reason, "no-ordered-mapping");
  const matcherComponent = renderResult(
    { content: [], details: matcherResult.details },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: reverseOrderedPatch },
      toolCallId: "matcher-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: true,
    },
  );
  const matcherText = stripAnsi(matcherComponent.render(120).join("\n"));
  assert.match(
    matcherText,
    /1\. \[FAILED\] Update ordered\.md — The requested changes match in reverse source-file order at line 4 and line 8\. Use\s+apply_patch again with the requested changes in source-file order if needed\./u,
  );
  assert.doesNotMatch(
    matcherText,
    /Matcher:|Candidates:|Previous group:|Later anchor|Earlier anchor/u,
  );

  const genericFailureComponent = renderResult(
    { content: [], details: {} },
    { expanded: true, isPartial: false },
    theme,
    {
      args: { patch: "invalid" },
      toolCallId: "generic-failure-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: true,
    },
  );
  assert.doesNotThrow(() => genericFailureComponent.render(120));
  assert.match(genericFailureComponent.render(120).join("\n"), /✘ Failed to apply patch/);

  applyPatchDebug = true;
  const genericDebugComponent = renderResult(
    {
      content: [{ type: "text", text: "Unexpected apply_patch failure." }],
      details: {},
    },
    { expanded: false, isPartial: false },
    theme,
    {
      args: { patch: "invalid" },
      toolCallId: "generic-debug-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: true,
    },
  );
  const genericDebugText = stripAnsi(genericDebugComponent.render(120).join("\n"));
  assert.match(genericDebugText, /^\s*Unexpected apply_patch failure\./u);
  assert.doesNotMatch(genericDebugText, /Model feedback:/u);
  assert.doesNotMatch(genericDebugText, /✘ Failed to apply patch/u);
});
