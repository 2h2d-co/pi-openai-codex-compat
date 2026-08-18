import {
  assert,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchVerificationError,
  workspace,
  rejectWithoutWrite,
} from "./apply-patch-matcher-edge-cases-harness.ts";

test("rejects prose constructs where whitespace can be semantic", async (t) => {
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

test("rejects semantic Java drift instead of treating it as formatting", async (t) => {
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

test("does not anchor an insertion to older context after nearer context changed", async (t) => {
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

test("fails closed when eligible locations exceed the candidate limit", async (t) => {
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
    /65 eligible locations exceed the 64-candidate limit/u,
  );
});

test("does not count byte-identical line and structural candidates twice", async (t) => {
  const cwd = await workspace(t);
  const exactLines = Array.from({ length: 9 }, (_, index) => `const value${index} = old${index};`);
  await writeFile(
    join(cwd, "deduplicated-candidates.js"),
    [...exactLines, "const result = combine(alpha, beta);", ""].join("\n"),
  );
  const exactGroups = exactLines.map(
    (line, index) => `@@
-${line}
+const value${index} = next${index};`,
  );

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: deduplicated-candidates.js
${exactGroups.join("\n")}
@@
-const result = combine(
-  alpha,
-  beta
-);
+const result = merge(alpha, beta);
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "deduplicated-candidates.js"), "utf8"),
    [
      ...Array.from({ length: 9 }, (_, index) => `const value${index} = next${index};`),
      "const result = merge(alpha, beta);",
      "",
    ].join("\n"),
  );
});

test("fails closed when equivalent mappings exceed the exhaustive-search limit", async (t) => {
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

test("bounds exhaustive mapping work at the configured limit", async (t) => {
  const cwd = await workspace(t);
  const groups = Array.from({ length: 6 }, (_, index) => `@@ stale ${index + 1}\n-\n`).join("");
  const startedAt = performance.now();
  await rejectWithoutWrite(
    cwd,
    "bounded-mappings.txt",
    "\n".repeat(64),
    `*** Begin Patch
*** Update File: bounded-mappings.txt
${groups}*** End Patch`,
    /more than 256 candidate mappings/u,
  );
  assert.ok(performance.now() - startedAt < 1_000, "mapping limit should bound traversal work");
});

test("reports ambiguity as a preflight failure with no committed instructions", async (t) => {
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
