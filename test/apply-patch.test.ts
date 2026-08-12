import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerApplyPatch, {
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  parsePatch,
  parsePatchDocument,
  previewPatch,
} from "../extensions/openai-codex-compat/apply-patch.ts";
import { ApplyPatchDiffComponent } from "../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { formatApplyPatchRenderText } from "../extensions/openai-codex-compat/apply-patch-render.ts";
import type { CodexToolBackground } from "../extensions/openai-codex-compat/config.ts";

const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_BACKGROUND_PATTERN = new RegExp(String.raw`\u001b\[48;(?:2;\d+;\d+;\d+|5;\d+)m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-apply-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

void test("renders paths relative to cwd, home-abbreviated, or absolute", async (t) => {
  const cwd = await workspace(t);
  const localPath = join(cwd, "nested", "local.ts");
  const homePath = join(homedir(), ".pi-codex-render-home.ts");
  const externalPath = join(parse(cwd).root, "pi-codex-render-external.ts");
  const details: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [
      {
        kind: "add",
        path: localPath,
        content: "local\n",
        displayDiff: "+1 local",
        additions: 1,
        deletions: 0,
      },
      {
        kind: "update",
        path: homePath,
        moveTo: externalPath,
        oldContent: "before\n",
        newContent: "after\n",
        displayDiff: "-1 before\n+1 after",
        additions: 1,
        deletions: 1,
      },
    ],
    added: [localPath],
    modified: [externalPath],
    deleted: [],
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const rendered = formatApplyPatchRenderText(details, theme, cwd);

  assert.ok(rendered.includes(join("nested", "local.ts")));
  assert.ok(rendered.includes(`${join("~", ".pi-codex-render-home.ts")} → ${externalPath}`));
});

void test("applies add, update, and delete hunks with Codex result details", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/current.txt"), "alpha\ntarget\nomega\n");
  await writeFile(join(cwd, "obsolete.txt"), "remove me\n");

  const patch = `*** Begin Patch
*** Add File: src/added.txt
+created
*** Update File: src/current.txt
@@ target
-omega
+replacement
*** Delete File: obsolete.txt
*** End Patch`;
  assert.deepEqual(
    parsePatch(patch).map((operation) => operation.kind),
    ["add", "update", "delete"],
  );

  const details = await applyPatch(cwd, patch);
  assert.deepEqual(details.added, ["src/added.txt"]);
  assert.deepEqual(details.modified, ["src/current.txt"]);
  assert.deepEqual(details.deleted, ["obsolete.txt"]);
  assert.equal(details.status, "completed");
  assert.equal(details.exact, true);
  assert.deepEqual(
    details.changes.map((change) => change.kind),
    ["add", "update", "delete"],
  );
  assert.equal(await readFile(join(cwd, "src/added.txt"), "utf8"), "created\n");
  assert.equal(
    await readFile(join(cwd, "src/current.txt"), "utf8"),
    "alpha\ntarget\nreplacement\n",
  );
  await assert.rejects(readFile(join(cwd, "obsolete.txt"), "utf8"), { code: "ENOENT" });
});

void test("renders repeated operations on one path as one final-state diff", async (t) => {
  const cwd = await workspace(t);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  await writeFile(join(cwd, "replaced.txt"), "shared\nold\n");

  const replacementPatch = `*** Begin Patch
*** Delete File: replaced.txt
*** Add File: replaced.txt
+shared
+new
+extra
*** End Patch`;
  const replacementPreview = await previewPatch(cwd, replacementPatch);
  assert.equal(replacementPreview.changes.length, 1);
  assert.equal(replacementPreview.changes[0]?.kind, "update");
  assert.match(
    formatApplyPatchRenderText(replacementPreview, theme, cwd),
    /^• Edited replaced\.txt \(\+2 -1\)/,
  );

  const replacement = await applyPatch(cwd, replacementPatch);

  assert.deepEqual(
    replacement.changes.map((change) => change.kind),
    ["delete", "add"],
  );
  const replacementText = formatApplyPatchRenderText(replacement, theme, cwd);
  assert.match(replacementText, /^• Edited replaced\.txt \(\+2 -1\)/);
  assert.doesNotMatch(replacementText, /Edited 2 files/);
  assert.match(replacementText, /-2 old/);
  assert.match(replacementText, /\+2 new/);

  await writeFile(join(cwd, "updated.txt"), "first\nsecond\nthird\n");
  const repeatedUpdate = await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: updated.txt
@@
-first
+FIRST
*** Update File: updated.txt
@@
-second
+SECOND
*** End Patch`,
  );

  assert.equal(repeatedUpdate.changes.length, 2);
  const repeatedUpdateText = formatApplyPatchRenderText(repeatedUpdate, theme, cwd);
  assert.match(repeatedUpdateText, /^• Edited updated\.txt \(\+2 -2\)/);
  assert.doesNotMatch(repeatedUpdateText, /Edited 2 files/);
  assert.match(repeatedUpdateText, /-1 first/);
  assert.match(repeatedUpdateText, /\+1 FIRST/);
  assert.match(repeatedUpdateText, /-2 second/);
  assert.match(repeatedUpdateText, /\+2 SECOND/);
});

void test("matches Codex overwrite semantics for add and move", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "duplicate.txt"), "old content\n");
  await mkdir(join(cwd, "old"), { recursive: true });
  await mkdir(join(cwd, "renamed"), { recursive: true });
  await writeFile(join(cwd, "old/name.txt"), "from\n");
  await writeFile(join(cwd, "renamed/name.txt"), "existing\n");

  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-from
+new
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "duplicate.txt"), "utf8"), "new content\n");
  assert.equal(await readFile(join(cwd, "renamed/name.txt"), "utf8"), "new\n");
  await assert.rejects(readFile(join(cwd, "old/name.txt"), "utf8"), { code: "ENOENT" });
  assert.deepEqual(details.added, ["duplicate.txt"]);
  assert.deepEqual(details.modified, ["renamed/name.txt"]);
  assert.equal(details.changes[0]?.kind, "add");
  assert.equal(
    details.changes[0]?.kind === "add" ? details.changes[0].overwrittenContent : undefined,
    "old content\n",
  );
  assert.deepEqual(details.changes[1], {
    kind: "update",
    path: "old/name.txt",
    moveTo: "renamed/name.txt",
    oldContent: "from\n",
    newContent: "new\n",
    overwrittenMoveContent: "existing\n",
    displayDiff: "-1 from\n+1 new",
    additions: 1,
    deletions: 1,
  });
});

void test("matches Codex lenient parsing around markers, heredocs, and blank context", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "file.txt"), "one\n\ntwo\n");

  const wrapped = `<<'EOF'
 *** Begin Patch
  *** Update File: file.txt
@@
 one

-two
+three
 *** End Patch
EOF`;
  const parsed = parsePatchDocument(wrapped);
  assert.equal(parsed.patch.trimStart().startsWith("*** Begin Patch"), true);
  assert.equal(parsed.operations[0]?.kind, "update");
  assert.equal(
    parsePatch("\u0085*** Begin Patch\n*** Add File: spaced.txt\n+ok\n*** End Patch\u0085")[0]
      ?.path,
    "spaced.txt",
  );
  assert.throws(
    () => parsePatch("\ufeff*** Begin Patch\n*** Add File: bom.txt\n+no\n*** End Patch"),
    /first line/,
  );
  assert.throws(() => parsePatch(""), /last line/);

  await applyPatch(cwd, wrapped);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "one\n\nthree\n");

  assert.throws(
    () =>
      parsePatch(`*** Begin Patch
*** Add File: one.txt
+one

*** Add File: two.txt
+two
*** End Patch`),
    /is not a valid hunk header/,
  );
  await assert.rejects(
    applyPatch(cwd, "*** Begin Patch\n*** End Patch"),
    /patch rejected: empty patch/,
  );
});

void test("matches Codex fuzzy Unicode and strict end-of-file matching", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "unicode.txt"), "“hello” — world\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: unicode.txt
@@
-"hello" - world
+"hello" - updated
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "unicode.txt"), "utf8"), '"hello" - updated\n');

  await writeFile(join(cwd, "rust-whitespace.txt"), "target\u0085\n");
  await applyPatch(
    cwd,
    "*** Begin Patch\n*** Update File: rust-whitespace.txt\n@@\n-target\n+matched\n*** End Patch",
  );
  assert.equal(await readFile(join(cwd, "rust-whitespace.txt"), "utf8"), "matched\n");

  await writeFile(join(cwd, "tail.txt"), "target\nnot-the-end\n");
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: tail.txt
@@
-target
+changed
*** End of File
*** End Patch`,
    ),
    /Failed to find expected lines/,
  );
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "target\nnot-the-end\n");

  await writeFile(join(cwd, "context.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: context.txt
@@
-four
+changed
*** End Patch`,
  );
  const change = details.changes[0];
  assert.equal(change?.kind, "update");
  if (change?.kind === "update") {
    assert.match(change.displayDiff, / 3 three/);
    assert.match(change.displayDiff, / 5 five/);
    assert.doesNotMatch(change.displayDiff, / 1 one/);
    assert.doesNotMatch(change.displayDiff, / 7 seven/);
  }
});

void test("prevalidates all hunks but preserves committed-prefix history after runtime failure", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "current.txt"), "original\n");
  let executionStarted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+should not be written
*** Update File: missing.txt
@@
-missing
+replacement
*** End Patch`,
      undefined,
      {
        onExecutionStart() {
          executionStarted = true;
        },
      },
    ),
    /apply_patch verification failed/,
  );
  assert.equal(executionStarted, false);
  await assert.rejects(readFile(join(cwd, "created.txt"), "utf8"), { code: "ENOENT" });

  const duplicatePatch = `*** Begin Patch
*** Update File: current.txt
@@
-original
+first
*** Update File: current.txt
@@
-original
+second
*** End Patch`;
  await assert.rejects(previewPatch(cwd, duplicatePatch), /Failed to find expected lines/);
  const verificationLifecycle: string[] = [];
  await assert.rejects(
    applyPatch(cwd, duplicatePatch, undefined, {
      onExecutionStart() {
        verificationLifecycle.push("execution-start");
      },
    }),
    /Failed to find expected lines/,
  );
  assert.equal(verificationLifecycle.length, 0);
  assert.equal(await readFile(join(cwd, "current.txt"), "utf8"), "original\n");

  await writeFile(join(cwd, "first.txt"), "first before\n");
  await writeFile(join(cwd, "second.txt"), "second before\n");
  const runtimeFailurePatch = `*** Begin Patch
*** Update File: first.txt
@@
-first before
+first after
*** Update File: second.txt
@@
-second before
+second after
*** End Patch`;
  const lifecycle: string[] = [];
  await assert.rejects(
    applyPatch(cwd, runtimeFailurePatch, undefined, {
      onExecutionStart() {
        lifecycle.push("execution-start");
      },
      onProgress() {
        lifecycle.push("progress");
        writeFileSync(join(cwd, "second.txt"), "external change\n");
      },
    }),
    (error: unknown) => {
      if (!(error instanceof ApplyPatchExecutionError)) return false;
      assert.equal(error.details.status, "failed");
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.changes[0]?.kind, "update");
      assert.equal(error.details.failure?.phase, "execution");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["applied", "failed"],
      );
      return true;
    },
  );
  assert.deepEqual(lifecycle, ["execution-start", "progress"]);
  assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first after\n");
  assert.equal(await readFile(join(cwd, "second.txt"), "utf8"), "external change\n");
});

void test("reports parse and preflight failures by instruction", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "existing.txt"), "keep\n");

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: broken.txt
this line is invalid
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.equal(error.details.failure?.phase, "parse");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ kind, path, status }) => ({ kind, path, status })),
        [
          { kind: "add", path: "created.txt", status: "not-run" },
          { kind: "update", path: "broken.txt", status: "failed" },
        ],
      );
      return true;
    },
  );
  await assert.rejects(readFile(join(cwd, "created.txt")), { code: "ENOENT" });

  let preflightDetails: ApplyPatchDetails | undefined;
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: missing.txt
@@
-missing
+replacement
*** Delete File: existing.txt
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      preflightDetails = error.details;
      assert.equal(error.details.failure?.phase, "preflight");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ kind, path, status }) => ({ kind, path, status })),
        [
          { kind: "add", path: "created.txt", status: "not-run" },
          { kind: "update", path: "missing.txt", status: "failed" },
          { kind: "delete", path: "existing.txt", status: "not-run" },
        ],
      );
      return true;
    },
  );
  assert.ok(preflightDetails);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const rendered = formatApplyPatchRenderText(preflightDetails, theme, cwd);
  assert.match(rendered, /Preflight · 3 instructions · 1 failed · 2 not run/);
  assert.match(rendered, /✘ 2\. Update missing\.txt — failed/);
  assert.match(rendered, /Reason: Failed to read file to update missing\.txt/);
  await assert.rejects(readFile(join(cwd, "created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "keep\n");
});

void test("rejects invalid UTF-8 like Codex", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "binary.txt"), Buffer.from([0xff, 0x0a]));
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: binary.txt
@@
+appended
*** End Patch`,
    ),
    /encoded data was not valid/,
  );
});

void test("matches Codex unrestricted path and symlink semantics", async (t) => {
  const root = await workspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  const absolutePath = join(root, "absolute.txt");
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git/config"), "old config\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(join(outside, "secret.txt"), join(cwd, "outside.txt"));

  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Add File: ../relative.txt
+relative
*** Add File: ${absolutePath}
+absolute
*** Add File: .git/config
+new config
*** Update File: outside.txt
@@
-secret
+exposed
*** End Patch`,
  );

  assert.equal(await readFile(join(root, "relative.txt"), "utf8"), "relative\n");
  assert.equal(await readFile(absolutePath, "utf8"), "absolute\n");
  assert.equal(await readFile(join(cwd, ".git/config"), "utf8"), "new config\n");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "exposed\n");
  assert.equal(details.exact, false);
});

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
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
    on(event: string, handler: typeof toolResultHandler) {
      if (event === "tool_result") toolResultHandler = handler;
    },
  } as unknown as ExtensionAPI;

  let toolBackground: CodexToolBackground = "subtle";
  registerApplyPatch(pi, () => toolBackground);
  assert.equal(registered?.name, "apply_patch");
  assert.equal(
    registered?.promptSnippet,
    "Apply freeform patches to add, update, move, or delete files",
  );
  assert.deepEqual(registered?.promptGuidelines, [
    "Use `apply_patch` for local file edits.",
    "Do not create or edit files with `cat` or other shell write tricks.",
    "Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
  ]);
  assert.equal(registered?.executionMode, "sequential");
  assert.equal(registered?.renderShell, "self");
  assert.deepEqual(registered?.constrainedSampling, {
    type: "grammar",
    variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
  });

  const result = await registered!.execute(
    "success-call",
    { patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch" },
    undefined,
    undefined,
    { cwd } as never,
  );
  const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(
    resultText,
    /^Exit code: 0\nWall time: \d+(?:\.\d+)? seconds\nOutput:\nSuccess\. Updated the following files:\nA rendered\.txt\n$/,
  );
  assert.equal((result.details as ApplyPatchDetails).changes[0]?.kind, "add");

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    getBgAnsi: (color: string) =>
      color === "toolPendingBg" ? "\u001b[48;2;40;40;50m" : "\u001b[48;2;40;50;40m",
    getColorMode: () => "truecolor",
    name: "dark",
  } as unknown as Theme;
  const callComponent = registered!.renderCall!(
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

  const component = registered!.renderResult!(
    result,
    { expanded: false, isPartial: false },
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
  const renderedResult = component.render(120).join("\n");
  assert.match(renderedResult, /• Added rendered\.txt \(\+1 -0\)/);
  assert.ok(!renderedResult.includes("\u001b[48;2;33;58;43m"));
  assert.ok(renderedResult.includes("\u001b[48;2;26;26;33m"));
  assert.doesNotMatch(stripAnsi(renderedResult), /1 \+hello/);

  const shellComponent = new ToolExecutionComponent(
    "apply_patch",
    "success-call",
    { patch: "*** Begin Patch\n*** Add File: rendered.txt\n+hello\n*** End Patch" },
    { showImages: false },
    registered,
    { requestRender() {} } as never,
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

  shellComponent.setExpanded(true);
  const expandedShellRender = shellComponent.render(120).join("\n");
  const expandedShellText = stripAnsi(expandedShellRender);
  assert.match(expandedShellText, /1 \+hello/);
  assert.ok(new Set(expandedShellRender.match(ANSI_BACKGROUND_PATTERN) ?? []).size >= 2);

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
  const failedResult = await registered!.execute(
    "failed-call",
    {
      patch: failedPatch,
    },
    undefined,
    undefined,
    { cwd } as never,
  );
  assert.equal((failedResult.details as ApplyPatchDetails).status, "completed");
  await writeFile(join(cwd, "partial-first.txt"), "before\n");
  await writeFile(join(cwd, "partial-second.txt"), "before\n");
  await assert.rejects(
    registered!.execute(
      "failed-call",
      {
        patch: failedPatch,
      },
      undefined,
      (partial) => {
        if ((partial.details as ApplyPatchDetails).changes.length === 1) {
          writeFileSync(join(cwd, "partial-second.txt"), "external\n");
        }
      },
      { cwd } as never,
    ),
    /^Error: Exit code: 1/,
  );
  const patchedResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "failed-call",
  });
  assert.equal(patchedResult?.details.status, "failed");
  assert.equal(patchedResult?.details.changes.length, 1);
  assert.equal(patchedResult?.details.failure?.phase, "execution");
  assert.deepEqual(
    patchedResult?.details.instructions?.map(({ status }) => status),
    ["applied", "failed"],
  );
  assert.match(
    formatApplyPatchRenderText(patchedResult!.details, theme, cwd),
    /Execution · 2 instructions · 1 applied · 1 failed/,
  );
  const failedComponent = registered!.renderResult!(
    { content: [], details: patchedResult!.details },
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
  assert.match(failedText, /Execution · 2 instructions · 1 applied · 1 failed/);
  assert.match(failedText, /✘ 2\. Update partial-second\.txt — failed/);
  assert.match(failedText, /Reason: Filesystem changed after apply_patch preflight/);

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
    registered!.execute("verification-call", { patch: verificationPatch }, undefined, undefined, {
      cwd,
    } as never),
    /apply_patch verification failed/,
  );
  const verificationResult = toolResultHandler?.({
    toolName: "apply_patch",
    toolCallId: "verification-call",
  });
  assert.equal(verificationResult?.details.failure?.phase, "preflight");
  assert.deepEqual(
    verificationResult?.details.instructions?.map(({ status }) => status),
    ["not-run", "failed", "not-run"],
  );
  const verificationComponent = registered!.renderResult!(
    { content: [], details: verificationResult!.details },
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
  assert.match(verificationText, /Preflight · 3 instructions · 1 failed · 2 not run/);
  assert.match(verificationText, /✘ 2\. Update verification-missing\.txt — failed/);
  assert.doesNotMatch(verificationText, /1\. Add verification-created/);
  assert.match(verificationText, /Reason: Failed to read file to update/);

  const expandedVerificationComponent = registered!.renderResult!(
    { content: [], details: verificationResult!.details },
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
  assert.match(expandedVerificationText, /– 1\. Add verification-created\.txt — not run/);
  assert.match(expandedVerificationText, /– 3\. Delete verification-existing\.txt — not run/);
  await assert.rejects(readFile(join(cwd, "verification-created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "verification-existing.txt"), "utf8"), "keep\n");

  const genericFailureComponent = registered!.renderResult!(
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
});
