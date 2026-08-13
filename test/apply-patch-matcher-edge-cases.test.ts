import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyPatch,
  ApplyPatchVerificationError,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-matcher-edges-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function rejectWithoutWrite(
  cwd: string,
  path: string,
  content: string,
  patch: string,
  pattern: RegExp,
): Promise<void> {
  await writeFile(join(cwd, path), content);
  const before = await readFile(join(cwd, path));
  await assert.rejects(applyPatch(cwd, patch), pattern, path);
  assert.deepEqual(await readFile(join(cwd, path)), before);
}

void test("recovers reflowed code inside a typed Markdown fence", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "README.md"),
    ["# API", "", "```ts", 'const value = new URL("@scope/pkg", import.meta.url);', "```", ""].join(
      "\n",
    ),
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: README.md
@@
 \`\`\`ts
-const value = new URL(
-  "@scope/pkg",
-  import.meta.url,
-);
+const value = new URL(
+  import.meta.resolve("@scope/pkg"),
+);
 \`\`\`
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "README.md"), "utf8"),
    [
      "# API",
      "",
      "```ts",
      "const value = new URL(",
      '  import.meta.resolve("@scope/pkg"),',
      ");",
      "```",
      "",
    ].join("\n"),
  );
});

void test("scopes fenced recovery to the declared language", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "languages.md"),
    [
      "```js",
      "const value = combine(alpha, beta);",
      "```",
      "",
      "```ts",
      "const value: string = combine(alpha, beta);",
      "```",
      "",
    ].join("\n"),
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: languages.md
@@
 \`\`\`ts
-const value: string = combine(
-  alpha,
-  beta,
-);
+const value: string = merge(
+  alpha,
+  beta,
+);
 \`\`\`
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "languages.md"), "utf8"),
    [
      "```js",
      "const value = combine(alpha, beta);",
      "```",
      "",
      "```ts",
      "const value: string = merge(alpha, beta);",
      "```",
      "",
    ].join("\n"),
  );
});

void test("matches formatter-aligned Markdown table rows by cells", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "SECURITY.md"),
    [
      "| Job                        | Read | Write | OIDC |",
      "| -------------------------- | ---- | ----- | ---- |",
      "| Pull-request validation    | Yes  | No    | No   |",
      "| Release construction       | Yes  | No    | No   |",
      "| npm publication            | No   | No    | Yes  |",
      "| GitHub release finalization | No   | Yes   | No   |",
      "",
    ].join("\n"),
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: SECURITY.md
@@
 | Pull-request validation | Yes | No | No |
 | Release construction | Yes | No | No |
 | npm publication | No | No | Yes |
+| Public-package integration | Yes | No | No |
 | GitHub release finalization | No | Yes | No |
*** End Patch`,
  );

  assert.match(
    await readFile(join(cwd, "SECURITY.md"), "utf8"),
    /\| npm publication {12}\| No {3}\| No {4}\| Yes {2}\|\n\| Public-package integration \| Yes \| No \| No \|\n\| GitHub release/u,
  );
});

void test("locates reflowed plain Markdown paragraphs for insertions and replacements", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "notes.md"),
    [
      "# Notes",
      "",
      "Existing automation separately exercises audio-only, subtitle-only, and mixed extension outputs.",
      "",
      "The old paragraph is currently formatted onto one line.",
      "",
    ].join("\n"),
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: notes.md
@@
 Existing automation separately exercises audio-only, subtitle-only, and mixed extension
 outputs.
+A uniquely anchored finding.
@@
-The old paragraph is currently
-formatted onto one line.
+The replacement paragraph is
+intentionally wrapped.
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "notes.md"), "utf8"),
    [
      "# Notes",
      "",
      "Existing automation separately exercises audio-only, subtitle-only, and mixed extension outputs.",
      "A uniquely anchored finding.",
      "",
      "The replacement paragraph is",
      "intentionally wrapped.",
      "",
    ].join("\n"),
  );
});

void test("ignores a stale context-only chunk when the actual insertion is unique", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "runbook.md"),
    "Current introduction.\n\nThe practical risk is transient load, not data loss.\n",
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: runbook.md
@@ obsolete introduction
@@
 The practical risk is transient load, not data loss.
+Add the operational follow-up.
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "runbook.md"), "utf8"),
    "Current introduction.\n\nThe practical risk is transient load, not data loss.\nAdd the operational follow-up.\n",
  );
});

void test("uses surviving context to disambiguate duplicate structural matches", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "calls.ts"),
    [
      "function first() {",
      "  return combine(alpha, beta);",
      "}",
      "function second() {",
      "  return combine(alpha, beta);",
      "}",
      "",
    ].join("\n"),
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: calls.ts
@@
 function second() {
-  return combine(
-    alpha,
-    beta,
-  );
+  return merge(
+    alpha,
+    beta,
+  );
 }
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "calls.ts"), "utf8"),
    [
      "function first() {",
      "  return combine(alpha, beta);",
      "}",
      "function second() {",
      "  return merge(alpha, beta);",
      "}",
      "",
    ].join("\n"),
  );
});

void test("applies ordered non-overlapping structural groups against one snapshot", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "groups.ts"),
    "const first = combine(alpha, beta);\nconst second = combine(gamma, delta);\n",
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: groups.ts
@@
-const first = combine(
-  alpha,
-  beta,
-);
+const first = merge(
+  alpha,
+  beta,
+);
@@
-const second = combine(
-  gamma,
-  delta,
-);
+const second = merge(
+  gamma,
+  delta,
+);
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "groups.ts"), "utf8"),
    "const first = merge(alpha, beta);\nconst second = merge(gamma, delta);\n",
  );
});

void test("preserves multibyte prefixes and CRLF around token-only edits", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "unicode.ts"),
    'const emoji = "😀"; const result = combine(alpha, beta);\r\n',
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: unicode.ts
@@
-const result = combine(
-  alpha,
-  beta,
-);
+const result = merge(
+  alpha,
+  beta,
+);
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "unicode.ts"), "utf8"),
    'const emoji = "😀"; const result = merge(alpha, beta);\r\n',
  );
});

void test("uses current indentation when a structural replacement changes token count", async (t) => {
  const cwd = await workspace(t);
  await writeFile(
    join(cwd, "tokens.ts"),
    "function values() {\n  const result = [alpha, beta];\n}\n",
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: tokens.ts
@@
-const result = [
-  alpha,
-  beta,
-];
+const result = [
+  alpha,
+  beta,
+  gamma,
+];
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "tokens.ts"), "utf8"),
    [
      "function values() {",
      "  const result = [",
      "    alpha,",
      "    beta,",
      "    gamma,",
      "  ];",
      "}",
      "",
    ].join("\n"),
  );
});

void test("preserves surrounding tokens when an inline replacement changes token count", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "inline.ts"), "function run() { return combine(alpha, beta); }\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: inline.ts
@@ stale
-combine(
-  alpha,
-  beta,
-)
+merge(
+  alpha,
+  beta,
+  gamma,
+)
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "inline.ts"), "utf8"),
    ["function run() { return merge(", "  alpha,", "  beta,", "  gamma,", "); }", ""].join("\n"),
  );
});

void test("retains official first-match behavior when strict matching succeeds", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "strict.txt"), "target\ntarget\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: strict.txt
@@
-target
+changed
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "strict.txt"), "utf8"), "changed\ntarget\n");
});

void test("honors explicit end-of-file constraints during recovery", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "tail.txt"), "target\nnot-the-tail\n");
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: tail.txt
@@ stale
-target
+changed
*** End of File
*** End Patch`,
    ),
    /Failed to find context/u,
  );
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "target\nnot-the-tail\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: tail.txt
@@ stale
+appended
*** End of File
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "target\nnot-the-tail\nappended\n");
});

void test("does not invent a blank line when recovering into an empty file", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "empty.txt"), "");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: empty.txt
@@ stale
+first
*** End of File
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "first\n");
});

void test("rejects ambiguous duplicate code blocks and structural expressions", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "duplicate.md",
    "```ts\nconst value = combine(alpha, beta);\n```\n\n```ts\nconst value = combine(alpha, beta);\n```\n",
    `*** Begin Patch
*** Update File: duplicate.md
@@
 \`\`\`ts
-const value = combine(
-  alpha,
-  beta,
-);
+const value = merge(
+  alpha,
+  beta,
+);
*** End Patch`,
    /candidate mappings produce different files/u,
  );

  await rejectWithoutWrite(
    cwd,
    "duplicate.ts",
    "const first = combine(alpha, beta);\nconst second = combine(alpha, beta);\n",
    `*** Begin Patch
*** Update File: duplicate.ts
@@ stale
-combine(
-  alpha,
-  beta,
-)
+merge(
+  alpha,
+  beta,
+)
*** End Patch`,
    /candidate mappings produce different files/u,
  );
});

void test("rejects duplicate reflowed prose and table insertion boundaries", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "duplicate-prose.md",
    [
      "A formatter placed this complete paragraph on one line.",
      "",
      "A formatter placed this complete paragraph on one line.",
      "",
    ].join("\n"),
    `*** Begin Patch
*** Update File: duplicate-prose.md
@@
 A formatter placed this complete
 paragraph on one line.
+inserted
*** End Patch`,
    /candidate mappings produce different files/u,
  );

  await rejectWithoutWrite(
    cwd,
    "duplicate-table.md",
    ["| Name  | Value |", "| ----- | ----- |", "| alpha | one   |", "| alpha | one   |", ""].join(
      "\n",
    ),
    `*** Begin Patch
*** Update File: duplicate-table.md
@@
 | alpha | one |
+| beta | two |
*** End Patch`,
    /candidate mappings produce different files/u,
  );
});

void test("rejects unknown, unterminated, and malformed fenced code", async (t) => {
  const cwd = await workspace(t);
  const fixtures = [
    {
      path: "unknown.md",
      content: "```kotlin\nval value = combine(alpha, beta)\n```\n",
      fence: "kotlin",
      old: ["val value = combine(", "  alpha,", "  beta,", ")"],
      replacement: ["val value = merge(", "  alpha,", "  beta,", ")"],
    },
    {
      path: "unterminated.md",
      content: "```ts\nconst value = combine(alpha, beta);\n",
      fence: "ts",
      old: ["const value = combine(", "  alpha,", "  beta,", ");"],
      replacement: ["const value = merge(", "  alpha,", "  beta,", ");"],
    },
    {
      path: "malformed-fence.md",
      content: "```ts\nconst broken = ;\nconst value = combine(alpha, beta);\n```\n",
      fence: "ts",
      old: ["const value = combine(", "  alpha,", "  beta,", ");"],
      replacement: ["const value = merge(", "  alpha,", "  beta,", ");"],
    },
  ] as const;

  for (const fixture of fixtures) {
    await rejectWithoutWrite(
      cwd,
      fixture.path,
      fixture.content,
      [
        "*** Begin Patch",
        `*** Update File: ${fixture.path}`,
        "@@",
        ` \`\`\`${fixture.fence}`,
        ...fixture.old.map((line) => `-${line}`),
        ...fixture.replacement.map((line) => `+${line}`),
        "*** End Patch",
      ].join("\n"),
      /Failed to find expected lines/u,
    );
  }
});

void test("rejects overlapping edit groups even when each group is identifiable", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "overlap.ts",
    "const value = combine(alpha, beta);\n",
    `*** Begin Patch
*** Update File: overlap.ts
@@ stale declaration
-const value = combine(
-  alpha,
-  beta,
-);
+const value = merge(
+  alpha,
+  beta,
+);
@@ stale call
-combine(
-  alpha,
-  beta,
-)
+transform(
+  alpha,
+  beta,
+)
*** End Patch`,
    /Failed to find context/u,
  );
});

void test("rejects prose constructs where whitespace can be semantic", async (t) => {
  const cwd = await workspace(t);
  const cases = [
    {
      path: "hard-break.md",
      content: "A line with a hard break.  \nThe continuation remains separate.\n",
      old: ["A line with a hard break.", "The continuation remains separate."],
    },
    {
      path: "inline-code.md",
      content: "Use `alpha  beta` exactly as written.\n",
      old: ["Use `alpha", "beta` exactly as written."],
    },
    {
      path: "escaped-table.md",
      content:
        "| Value          | Meaning |\n| -------------- | ------- |\n| alpha \\| beta | exact   |\n",
      old: ["| alpha \\| beta | exact |"],
    },
    {
      path: "list.md",
      content: "- A list item that the formatter kept on one line.\n",
      old: ["- A list item that the formatter", "  kept on one line."],
    },
    {
      path: "setext-heading.md",
      content: "A heading\n---------\n",
      old: ["A", "heading", "---------"],
    },
  ] as const;

  for (const fixture of cases) {
    await rejectWithoutWrite(
      cwd,
      fixture.path,
      fixture.content,
      [
        "*** Begin Patch",
        `*** Update File: ${fixture.path}`,
        "@@ stale",
        ...fixture.old.map((line) => `-${line}`),
        "+replacement",
        "*** End Patch",
      ].join("\n"),
      /Failed to find context/u,
    );
  }
});

void test("rejects semantic Java drift instead of treating it as formatting", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "Service.java",
    [
      "class Service {",
      "  Service(String queue, Repository repository, Logger logger) {",
      "    this.queue = queue;",
      "    this.repository = repository;",
      "    this.logger = logger;",
      "  }",
      "}",
      "",
    ].join("\n"),
    `*** Begin Patch
*** Update File: Service.java
@@ stale
-Service(
-    String queue,
-    Repository repository) {
-  this.queue = queue;
-  this.repository = repository;
+Service(
+    String queue,
+    Repository repository,
+    Policy policy) {
+  this.queue = queue;
+  this.repository = repository;
+  this.policy = policy;
*** End Patch`,
    /Failed to find context/u,
  );
});

void test("does not anchor an insertion to older context after nearer context changed", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "semantic-drift.md",
    [
      "The first sentence remains unchanged.",
      "The current total is 8 jobs with 2 failures.",
      "",
    ].join("\n"),
    `*** Begin Patch
*** Update File: semantic-drift.md
@@
 The first sentence remains unchanged.
 The current total is 9 jobs with 2 failures.
+Add a conclusion.
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

void test("fails closed when equally ranked locations exceed the candidate limit", async (t) => {
  const cwd = await workspace(t);
  const content = `${Array.from({ length: 65 }, () => "target").join("\n")}\n`;
  await rejectWithoutWrite(
    cwd,
    "many.txt",
    content,
    `*** Begin Patch
*** Update File: many.txt
@@ stale
-target
+changed
*** End Patch`,
    /more than 64 equally ranked locations/u,
  );
});

void test("fails closed when equivalent mappings exceed the exhaustive-search limit", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "many-mappings.txt",
    "\n".repeat(20),
    `*** Begin Patch
*** Update File: many-mappings.txt
@@ stale one
-
@@ stale two
-
@@ stale three
-
*** End Patch`,
    /more than 256 candidate mappings/u,
  );
});

void test("reports ambiguity as a preflight failure with no committed instructions", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "ambiguous.txt"), "target\nother\ntarget\n");
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: should-not-exist.txt
+blocked
*** Update File: ambiguous.txt
@@ stale
-target
+changed
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.equal(error.details.failure?.phase, "preflight");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["not-run", "failed"],
      );
      return true;
    },
  );
  await assert.rejects(readFile(join(cwd, "should-not-exist.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "ambiguous.txt"), "utf8"), "target\nother\ntarget\n");
});
