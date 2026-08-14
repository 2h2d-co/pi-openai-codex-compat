import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyPatch,
  ApplyPatchVerificationError,
  parsePatch,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-formatter-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function updatePatch(
  path: string,
  oldLines: readonly string[],
  newLines: readonly string[],
): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "*** End Patch",
  ].join("\n");
}

void test("retains context, addition, and deletion roles while parsing update hunks", () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: sample.ts
@@
 before
-old
+new
 after
*** End Patch`)[0];

  assert.equal(operation?.kind, "update");
  if (operation?.kind !== "update") return;
  assert.deepEqual(operation.chunks[0]?.lines, [
    { kind: "context", text: "before" },
    { kind: "delete", text: "old" },
    { kind: "add", text: "new" },
    { kind: "context", text: "after" },
  ]);
});

void test("uses packaged Tree-sitter grammars to recover formatter-reflowed edits", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "sample.js",
      current: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta,", ");"],
      expected: "const result = merge(alpha, beta);\n",
    },
    {
      path: "sample.jsx",
      current: 'const view = <Panel title="old"><Item /></Panel>;\n',
      oldLines: ["const view = <Panel", '  title="old"', ">", "  <Item />", "</Panel>;"],
      newLines: ["const view = <Panel", '  title="new"', ">", "  <Item />", "</Panel>;"],
      expected: 'const view = <Panel title="new"><Item /></Panel>;\n',
    },
    {
      path: "sample.ts",
      current: "const result: string = combine(alpha, beta);\n",
      oldLines: ["const result: string = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result: string = merge(", "  alpha,", "  beta,", ");"],
      expected: "const result: string = merge(alpha, beta);\n",
    },
    {
      path: "sample.tsx",
      current: 'const view: JSX.Element = <Panel title="old"><Item /></Panel>;\n',
      oldLines: [
        "const view: JSX.Element = <Panel",
        '  title="old"',
        ">",
        "  <Item />",
        "</Panel>;",
      ],
      newLines: [
        "const view: JSX.Element = <Panel",
        '  title="new"',
        ">",
        "  <Item />",
        "</Panel>;",
      ],
      expected: 'const view: JSX.Element = <Panel title="new"><Item /></Panel>;\n',
    },
    {
      path: "sample.py",
      current: "result = combine(alpha, beta)\n",
      oldLines: ["result = combine(", "    alpha,", "    beta,", ")"],
      newLines: ["result = merge(", "    alpha,", "    beta,", ")"],
      expected: "result = merge(alpha, beta)\n",
    },
    {
      path: "sample.go",
      current: "package sample\n\nfunc run() { result := combine(alpha, beta); _ = result }\n",
      oldLines: ["result := combine(", "\talpha,", "\tbeta,", ")"],
      newLines: ["result := merge(", "\talpha,", "\tbeta,", ")"],
      expected: "package sample\n\nfunc run() { result := merge(alpha, beta); _ = result }\n",
    },
    {
      path: "Sample.java",
      current: "class Sample { void run() { var result = combine(alpha, beta); } }\n",
      oldLines: ["var result = combine(", "    alpha,", "    beta", ");"],
      newLines: ["var result = merge(", "    alpha,", "    beta", ");"],
      expected: "class Sample { void run() { var result = merge(alpha, beta); } }\n",
    },
    {
      path: "Sample.scala",
      current: "object Sample { val result = combine(alpha, beta) }\n",
      oldLines: ["val result = combine(", "  alpha,", "  beta", ")"],
      newLines: ["val result = merge(", "  alpha,", "  beta", ")"],
      expected: "object Sample { val result = merge(alpha, beta) }\n",
    },
  ] as const;

  for (const fixture of fixtures) {
    const path = join(cwd, fixture.path);
    await writeFile(path, fixture.current);
    await applyPatch(cwd, updatePatch(fixture.path, fixture.oldLines, fixture.newLines));
    assert.equal(await readFile(path, "utf8"), fixture.expected, fixture.path);
  }
});

void test("accepts only a unique formatter-tolerant final file", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "same-output.txt"), "alpha\n\n\nomega\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: same-output.txt
@@
 stale context
-
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "same-output.txt"), "utf8"), "alpha\n\nomega\n");

  await writeFile(join(cwd, "ambiguous.txt"), "first\ntarget\nextra\nsecond\ntarget\nextra\n");
  const before = await readFile(join(cwd, "ambiguous.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: ambiguous.txt
@@
 stale before
-target
+changed
 stale after
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.match(error.message, /candidate mappings produce different files/);
      return true;
    },
  );
  assert.deepEqual(await readFile(join(cwd, "ambiguous.txt")), before);
});

void test("rejects insertions with multiple eligible boundaries", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "unique.txt"), "anchor\nbefore\nformatter-added\nafter\n");
  const uniqueBefore = await readFile(join(cwd, "unique.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: unique.txt
@@
 anchor
 before
+inserted
 after
*** End Patch`,
    ),
    /candidate mappings produce different files/u,
  );
  assert.deepEqual(await readFile(join(cwd, "unique.txt")), uniqueBefore);

  await writeFile(
    join(cwd, "repeated.txt"),
    "before\nformatter-added\nafter\nbefore\nformatter-added\nafter\n",
  );
  const before = await readFile(join(cwd, "repeated.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: repeated.txt
@@
 before
+inserted
 after
*** End Patch`,
    ),
    /candidate mappings produce different files/,
  );
  assert.deepEqual(await readFile(join(cwd, "repeated.txt")), before);
});

void test("does not ignore comments, literals, or unsupported-language reflow", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "comment.ts",
      content: "const result = combine(alpha /* keep */, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta,", ");"],
    },
    {
      path: "literal.ts",
      content: 'const result = format("current", value);\n',
      oldLines: ['const result = format("expected",', "  value,", ");"],
      newLines: ['const result = format("updated",', "  value,", ");"],
    },
    {
      path: "unsupported.txt",
      content: "result = combine(alpha, beta)\n",
      oldLines: ["result = combine(", "  alpha,", "  beta,", ")"],
      newLines: ["result = merge(", "  alpha,", "  beta,", ")"],
    },
    {
      path: "malformed-source.ts",
      content: "const broken = ;\nconst result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta,", ");"],
    },
    {
      path: "malformed-replacement.ts",
      content: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta,"],
    },
  ] as const;

  for (const fixture of fixtures) {
    const path = join(cwd, fixture.path);
    await writeFile(path, fixture.content);
    await assert.rejects(
      applyPatch(cwd, updatePatch(fixture.path, fixture.oldLines, fixture.newLines)),
      /Failed to find expected lines/,
      fixture.path,
    );
    assert.equal(await readFile(path, "utf8"), fixture.content);
  }
  assert.equal((await lstat(join(cwd, "comment.ts"))).isFile(), true);
});
