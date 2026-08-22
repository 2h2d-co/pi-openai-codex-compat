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

test("contains reflowed code inside a typed Markdown fence", async (t) => {
  const cwd = await workspace(t);
  const content = [
    "# API",
    "",
    "```ts",
    'const value = new URL("@scope/pkg", import.meta.url);',
    "```",
    "",
  ].join("\n");
  await writeFile(join(cwd, "README.md"), content);

  await assert.rejects(
    applyPatch(
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
    ),
    /Failed to find expected lines/u,
  );

  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), content);
});

test("contains fenced recovery even when the language scope is unique", async (t) => {
  const cwd = await workspace(t);
  const content = [
    "```js",
    "const value = combine(alpha, beta);",
    "```",
    "",
    "```ts",
    "const value: string = combine(alpha, beta);",
    "```",
    "",
  ].join("\n");
  await writeFile(join(cwd, "languages.md"), content);

  await assert.rejects(
    applyPatch(
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
    ),
    /Failed to find expected lines/u,
  );

  assert.equal(await readFile(join(cwd, "languages.md"), "utf8"), content);
});

test("contains formatter-aligned Markdown table rows", async (t) => {
  const cwd = await workspace(t);
  const content = [
    "| Job                        | Read | Write | OIDC |",
    "| -------------------------- | ---- | ----- | ---- |",
    "| Pull-request validation    | Yes  | No    | No   |",
    "| Release construction       | Yes  | No    | No   |",
    "| npm publication            | No   | No    | Yes  |",
    "| GitHub release finalization | No   | Yes   | No   |",
    "",
  ].join("\n");
  await writeFile(join(cwd, "SECURITY.md"), content);

  await assert.rejects(
    applyPatch(
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
    ),
    /Failed to find expected lines/u,
  );

  assert.equal(await readFile(join(cwd, "SECURITY.md"), "utf8"), content);
});

test("rejects reflowed plain Markdown paragraphs", async (t) => {
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
    /Failed to find expected lines/u,
  );
});
