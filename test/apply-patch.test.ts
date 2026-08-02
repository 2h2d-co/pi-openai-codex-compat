import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  parsePatch,
  parsePatchDocument,
  previewPatch,
} from "../extensions/openai-codex-compat/apply-patch.ts";
import { ApplyPatchDiffComponent } from "../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { formatApplyPatchRenderText } from "../extensions/openai-codex-compat/apply-patch-render.ts";

const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-apply-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

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
  const preview = await previewPatch(cwd, duplicatePatch);
  assert.equal(preview.changes.length, 1);
  assert.equal(
    preview.changes[0]?.kind === "update" ? preview.changes[0].newContent : undefined,
    "second\n",
  );
  const lifecycle: string[] = [];
  await assert.rejects(
    applyPatch(cwd, duplicatePatch, undefined, {
      onExecutionStart() {
        lifecycle.push("execution-start");
      },
      onProgress() {
        lifecycle.push("progress");
      },
    }),
    (error: unknown) => {
      if (!(error instanceof ApplyPatchExecutionError)) return false;
      assert.equal(error.details.status, "failed");
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.changes[0]?.kind, "update");
      return true;
    },
  );
  assert.deepEqual(lifecycle, ["execution-start", "progress"]);
  assert.equal(await readFile(join(cwd, "current.txt"), "utf8"), "first\n");
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

  registerApplyPatch(pi);
  assert.equal(registered?.name, "apply_patch");
  assert.equal(registered?.executionMode, "sequential");
  assert.equal(registered?.renderShell, undefined);
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
    getBgAnsi: () => "\u001b[48;2;40;50;40m",
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
  assert.equal(callComponent.render(120).join("\n").trimEnd(), "apply_patch");

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
  assert.ok(renderedResult.includes("\u001b[48;2;33;58;43m"));
  assert.match(stripAnsi(renderedResult), /1 \+hello/);

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
  const shellText = stripAnsi(shellComponent.render(120).join("\n"));
  assert.match(shellText, /apply_patch/);
  assert.match(shellText, /• Added rendered\.txt \(\+1 -0\)/);
  assert.match(shellText, /1 \+hello/);
  assert.doesNotMatch(shellText, /Exit code:/);

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
  const richLines = new ApplyPatchDiffComponent(richDetails, theme, cwd).render(80);
  const richText = stripAnsi(richLines.join("\n"));
  assert.match(richText, /• Edited 2 files \(\+1 -2\)/);
  assert.match(richText, /old\.ts → new\.ts \(\+1 -1\)/);
  assert.match(richText, /1 -const before = true;/);
  assert.match(richText, /1 \+const after = true;/);
  assert.match(richText, /obsolete\.txt \(\+0 -1\)/);
  assert.match(richText, /1 -remove/);
  assert.ok(richLines.every((line) => visibleWidth(line) <= 80));

  await writeFile(join(cwd, "partial.txt"), "before\n");
  const failedPatch = `*** Begin Patch
*** Update File: partial.txt
@@
-before
+after
*** Update File: partial.txt
@@
-before
+again
*** End Patch`;
  const failedPreview = await previewPatch(cwd, failedPatch);
  await assert.rejects(
    registered!.execute(
      "failed-call",
      {
        patch: failedPatch,
      },
      undefined,
      undefined,
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
  assert.match(
    formatApplyPatchRenderText(patchedResult!.details, theme, cwd),
    /✘ Failed to apply patch/,
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
      state: { preview: failedPreview },
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
  assert.match(failedText, /again/);
  assert.match(failedText, /✘ Failed to apply patch/);
});
