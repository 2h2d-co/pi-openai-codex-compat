import { test, workspace, rejectWithoutWrite } from "./apply-patch-matcher-edge-cases-harness.ts";

void test("treats JavaScript array elisions as exact punctuation", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "elision.js",
    "const values = [,];\n",
    `*** Begin Patch
*** Update File: elision.js
@@ stale
-[]
+[value]
*** End Patch`,
    /Failed to find context/u,
  );
});

void test("rejects divergent line-level and structural candidates", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "decoy.ts",
    [
      "/*",
      "combine(",
      "  alpha,",
      "  beta",
      ");",
      "*/",
      "function run() {",
      "  combine(alpha, beta);",
      "}",
      "",
    ].join("\n"),
    `*** Begin Patch
*** Update File: decoy.ts
@@ stale
-combine(
-  alpha,
-  beta
-);
+merge(
+  alpha,
+  beta
+);
*** End Patch`,
    /candidate mappings produce different files/u,
  );
});

void test("keeps Markdown tolerant matching outside closed and fenced blocks", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "table-fence.md",
    "```text\n| alpha      | one |\n```\n",
    `*** Begin Patch
*** Update File: table-fence.md
@@ stale
 | alpha | one |
+| beta | two |
*** End Patch`,
    /Failed to find context/u,
  );
  await rejectWithoutWrite(
    cwd,
    "closed-fence.md",
    "```ts\nconst value = combine(alpha, beta);\n```\n\nsomewhere else: combine(alpha, beta)\n",
    `*** Begin Patch
*** Update File: closed-fence.md
@@
 \`\`\`ts
 const value = combine(alpha, beta);
 \`\`\`
 somewhere else:
-combine(
-  alpha,
-  beta
-)
+merge(
+  alpha,
+  beta,
+)
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

void test("applies Markdown safety rules consistently to CRLF files", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "hard-break-crlf.md",
    "A line with a hard break.  \r\nThe continuation remains separate.\r\n",
    `*** Begin Patch
*** Update File: hard-break-crlf.md
@@ stale
-A line with a hard break.
-The continuation remains separate.
+replacement
*** End Patch`,
    /Failed to find context/u,
  );
});

void test("rejects ambiguous duplicate code blocks and full-line structural expressions", async (t) => {
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
-  beta
-);
+const value = merge(
+  alpha,
+  beta
+);
*** End Patch`,
    /candidate mappings produce different files/u,
  );

  await rejectWithoutWrite(
    cwd,
    "duplicate.ts",
    "const value = combine(alpha, beta);\nconst value = combine(alpha, beta);\n",
    `*** Begin Patch
*** Update File: duplicate.ts
@@ stale
-const value = combine(
-  alpha,
-  beta
-);
+const value = merge(
+  alpha,
+  beta
+);
*** End Patch`,
    /candidate mappings produce different files/u,
  );
});

void test("rejects unsupported reflowed prose and ambiguous table insertion boundaries", async (t) => {
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
    /No formatter-tolerant candidate/u,
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
-  beta
-);
+const value = merge(
+  alpha,
+  beta,
+);
@@ stale declaration again
-const value = combine(
-  alpha,
-  beta
-);
+const value = transform(
+  alpha,
+  beta,
+);
*** End Patch`,
    /overlaps edit group 1/u,
  );
});
