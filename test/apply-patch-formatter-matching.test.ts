import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Language, Parser } from "web-tree-sitter";
import {
  applyPatch,
  ApplyPatchVerificationError,
  parsePatch,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import { setApplyPatchStructuralRuntimeForTesting } from "../extensions/openai-codex-compat/apply-patch-matcher.ts";

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

test("retains context, addition, and deletion roles while parsing update hunks", () => {
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

test("retries parser initialization and grammar loading after transient failures", async (t) => {
  const cwd = await workspace(t);
  const source = "const result = combine(alpha, beta);\n";
  const patch = updatePatch(
    "retry.js",
    ["const result = combine(", "  alpha,", "  beta", ");"],
    ["const result = merge(", "  alpha,", "  beta", ");"],
  );

  await writeFile(join(cwd, "retry.js"), source);
  let initializationAttempts = 0;
  const restoreInitialization = setApplyPatchStructuralRuntimeForTesting({
    async initializeParser() {
      initializationAttempts += 1;
      if (initializationAttempts === 1) throw new Error("injected parser initialization failure");
      await Parser.init();
    },
  });
  try {
    await assert.rejects(applyPatch(cwd, patch), ApplyPatchVerificationError);
    assert.equal(initializationAttempts, 1);
    assert.equal(await readFile(join(cwd, "retry.js"), "utf8"), source);
    await applyPatch(cwd, patch);
    assert.equal(initializationAttempts, 2);
    assert.equal(
      await readFile(join(cwd, "retry.js"), "utf8"),
      "const result = merge(\n  alpha,\n  beta\n);\n",
    );
  } finally {
    restoreInitialization();
  }

  await writeFile(join(cwd, "retry-language.js"), source);
  const languagePatch = updatePatch(
    "retry-language.js",
    ["const result = combine(", "  alpha,", "  beta", ");"],
    ["const result = merge(", "  alpha,", "  beta", ");"],
  );
  let languageAttempts = 0;
  const restoreLanguage = setApplyPatchStructuralRuntimeForTesting({
    async loadLanguage(path) {
      languageAttempts += 1;
      if (languageAttempts === 1) throw new Error("injected grammar loading failure");
      return Language.load(path);
    },
  });
  try {
    await assert.rejects(applyPatch(cwd, languagePatch), ApplyPatchVerificationError);
    assert.equal(languageAttempts, 1);
    assert.equal(await readFile(join(cwd, "retry-language.js"), "utf8"), source);
    await applyPatch(cwd, languagePatch);
    assert.equal(languageAttempts, 2);
    assert.equal(
      await readFile(join(cwd, "retry-language.js"), "utf8"),
      "const result = merge(\n  alpha,\n  beta\n);\n",
    );
  } finally {
    restoreLanguage();
  }
});

test("uses packaged Tree-sitter grammars to recover formatter-reflowed edits", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "sample.js",
      current: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta", ");"],
      expected: "const result = merge(\n  alpha,\n  beta\n);\n",
    },
    {
      path: "sample.jsx",
      current: 'const view = <Panel title="old"><Item /></Panel>;\n',
      oldLines: ["const view = <Panel", '  title="old"', ">", "  <Item />", "</Panel>;"],
      newLines: ["const view = <Panel", '  title="new"', ">", "  <Item />", "</Panel>;"],
      expected: 'const view = <Panel\n  title="new"\n>\n  <Item />\n</Panel>;\n',
    },
    {
      path: "sample.ts",
      current: "const result: string = combine(alpha, beta);\n",
      oldLines: ["const result: string = combine(", "  alpha,", "  beta", ");"],
      newLines: ["const result: string = merge(", "  alpha,", "  beta", ");"],
      expected: "const result: string = merge(\n  alpha,\n  beta\n);\n",
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
      expected: 'const view: JSX.Element = <Panel\n  title="new"\n>\n  <Item />\n</Panel>;\n',
    },
    {
      path: "sample.py",
      current: "result = combine(alpha, beta)\n",
      oldLines: ["result = combine(", "    alpha,", "    beta", ")"],
      newLines: ["result = merge(", "    alpha,", "    beta", ")"],
      expected: "result = merge(\n    alpha,\n    beta\n)\n",
    },
    {
      path: "sample.go",
      current: "package sample\n\nfunc run() {\n\tresult := alpha + beta\n\t_ = result\n}\n",
      oldLines: ["\tresult := alpha +", "\t\tbeta"],
      newLines: ["\tresult := alpha +", "\t\tgamma"],
      expected: "package sample\n\nfunc run() {\n\tresult := alpha +\n\t\tgamma\n\t_ = result\n}\n",
    },
    {
      path: "Sample.java",
      current:
        "class Sample {\n    void run() {\n        var result = combine(alpha, beta);\n    }\n}\n",
      oldLines: [
        "        var result = combine(",
        "            alpha,",
        "            beta",
        "        );",
      ],
      newLines: [
        "        var result = merge(",
        "            alpha,",
        "            beta",
        "        );",
      ],
      expected:
        "class Sample {\n    void run() {\n        var result = merge(\n            alpha,\n            beta\n        );\n    }\n}\n",
    },
    {
      path: "Sample.scala",
      current: "object Sample {\n  val result = combine(alpha, beta)\n}\n",
      oldLines: ["  val result = combine(", "    alpha,", "    beta", "  )"],
      newLines: ["  val result = merge(", "    alpha,", "    beta", "  )"],
      expected: "object Sample {\n  val result = merge(\n    alpha,\n    beta\n  )\n}\n",
    },
  ] as const;

  for (const fixture of fixtures) {
    const path = join(cwd, fixture.path);
    await writeFile(path, fixture.current);
    await applyPatch(cwd, updatePatch(fixture.path, fixture.oldLines, fixture.newLines));
    assert.equal(await readFile(path, "utf8"), fixture.expected, fixture.path);
  }
});

test("accepts only a unique formatter-tolerant final file", async (t) => {
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

test("rejects insertions with multiple eligible boundaries", async (t) => {
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

test("does not ignore comments, literals, or unsupported-language reflow", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "comment.ts",
      content: "const result = combine(alpha /* keep */, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta", ");"],
    },
    {
      path: "literal.ts",
      content: 'const result = format("current", value);\n',
      oldLines: ['const result = format("expected",', "  value", ");"],
      newLines: ['const result = format("updated",', "  value", ");"],
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
      oldLines: ["const result = combine(", "  alpha,", "  beta", ");"],
      newLines: ["const result = merge(", "  alpha,", "  beta", ");"],
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

test("treats structurally recovered replacement lines as opaque instructions", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "opaque.ts"), "const result = combine(alpha, beta);\n");

  await applyPatch(
    cwd,
    updatePatch(
      "opaque.ts",
      ["const result = combine(", "  alpha,", "  beta", ");"],
      ["const result = merge(", "  alpha,"],
    ),
  );

  assert.equal(await readFile(join(cwd, "opaque.ts"), "utf8"), "const result = merge(\n  alpha,\n");
});

test("applies explicit punctuation additions and deletions from replacement lines", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "punctuation.ts"), "const result = combine(alpha, beta);\n");

  await applyPatch(
    cwd,
    updatePatch(
      "punctuation.ts",
      ["const result = combine(", "  alpha,", "  beta", ");"],
      ["const result = combine(", "  alpha,", "  beta,", ");"],
    ),
  );

  assert.equal(
    await readFile(join(cwd, "punctuation.ts"), "utf8"),
    "const result = combine(\n  alpha,\n  beta,\n);\n",
  );

  await writeFile(join(cwd, "punctuation-removal.ts"), "const result = combine(alpha, beta,);\n");
  await applyPatch(
    cwd,
    updatePatch(
      "punctuation-removal.ts",
      ["const result = combine(", "  alpha,", "  beta,", ");"],
      ["const result = combine(", "  alpha,", "  beta", ");"],
    ),
  );
  assert.equal(
    await readFile(join(cwd, "punctuation-removal.ts"), "utf8"),
    "const result = combine(\n  alpha,\n  beta\n);\n",
  );
});

test("requires exact old-side punctuation during structural recovery", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "punctuation.js",
      content: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = replacement;"],
    },
    {
      path: "punctuation.jsx",
      content: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = replacement;"],
    },
    {
      path: "punctuation.ts",
      content: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = replacement;"],
    },
    {
      path: "punctuation.tsx",
      content: "const result = combine(alpha, beta);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta,", ");"],
      newLines: ["const result = replacement;"],
    },
    {
      path: "punctuation.py",
      content: "result = combine(alpha, beta)\n",
      oldLines: ["result = combine(", "    alpha,", "    beta,", ")"],
      newLines: ["result = replacement"],
    },
    {
      path: "punctuation.go",
      content:
        "package sample\n\nfunc run() {\n\tresult := combine(alpha, beta)\n\t_ = result\n}\n",
      oldLines: ["\tresult := combine(", "\t\talpha,", "\t\tbeta,", "\t)"],
      newLines: ["\tresult := replacement"],
    },
    {
      path: "Punctuation.java",
      content: "class Punctuation {\n  int[] values = {1};\n}\n",
      oldLines: ["  int[] values = {", "    1,", "  };"],
      newLines: ["  int[] values = replacement;"],
    },
    {
      path: "Punctuation.scala",
      content: "object Punctuation {\n  val result = combine(alpha, beta)\n}\n",
      oldLines: ["  val result = combine(", "    alpha,", "    beta,", "  )"],
      newLines: ["  val result = replacement"],
    },
    {
      path: "additional-punctuation.ts",
      content: "const result = combine(alpha, beta,);\n",
      oldLines: ["const result = combine(", "  alpha,", "  beta", ");"],
      newLines: ["const result = replacement;"],
    },
  ] as const;

  for (const fixture of fixtures) {
    const path = join(cwd, fixture.path);
    await writeFile(path, fixture.content);
    await assert.rejects(
      applyPatch(cwd, updatePatch(fixture.path, fixture.oldLines, fixture.newLines)),
      /Failed to find expected lines/u,
      fixture.path,
    );
    assert.equal(await readFile(path, "utf8"), fixture.content);
  }
});
