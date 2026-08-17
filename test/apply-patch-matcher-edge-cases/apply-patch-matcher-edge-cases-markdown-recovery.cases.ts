import {
  assert,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  workspace,
  rejectWithoutWrite,
} from "./apply-patch-matcher-edge-cases-harness.ts";

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
-  import.meta.url
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
-  beta
-);
+const value: string = merge(
+  alpha,
+  beta
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
      "const value: string = merge(",
      "  alpha,",
      "  beta",
      ");",
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

void test("rejects reflowed plain Markdown paragraphs", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "notes.md",
    [
      "# Notes",
      "",
      "Existing automation separately exercises audio-only, subtitle-only, and mixed extension outputs.",
      "",
      "The old paragraph is currently formatted onto one line.",
      "",
    ].join("\n"),
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
    /No formatter-tolerant candidate/u,
  );
});
