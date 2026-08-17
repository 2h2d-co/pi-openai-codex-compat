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

void test("does not use contextual preference to choose among structural matches", async (t) => {
  const cwd = await workspace(t);
  const content = [
    "function first() {",
    "  return combine(alpha, beta);",
    "}",
    "function second() {",
    "  return combine(alpha, beta);",
    "}",
    "",
  ].join("\n");
  await rejectWithoutWrite(
    cwd,
    "calls.ts",
    content,
    `*** Begin Patch
*** Update File: calls.ts
@@
 function second() {
-  return combine(
-    alpha,
-    beta
-  );
+  return merge(
+    alpha,
+    beta
+  );
 }
*** End Patch`,
    /candidate mappings produce different files/u,
  );
});

void test("does not let stronger context hide a structural decoy", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "scored-decoy.ts",
    [
      "/*",
      "before old",
      "combine(",
      "  alpha,",
      "  beta",
      ");",
      "after old",
      "*/",
      "function run() {",
      "  combine(alpha, beta);",
      "}",
      "const marker = old();",
      "",
    ].join("\n"),
    `*** Begin Patch
*** Update File: scored-decoy.ts
@@
 before old
-combine(
-  alpha,
-  beta
-);
+merge(
+  alpha,
+  beta
+);
 after old
@@ stale marker
-const marker = old(
-);
+const marker = fresh(
+);
*** End Patch`,
    /candidate mappings produce different files/u,
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
-  beta
-);
+const first = merge(
+  alpha,
+  beta
+);
@@
-const second = combine(
-  gamma,
-  delta
-);
+const second = merge(
+  gamma,
+  delta
+);
*** End Patch`,
  );

  assert.equal(
    await readFile(join(cwd, "groups.ts"), "utf8"),
    [
      "const first = merge(",
      "  alpha,",
      "  beta",
      ");",
      "const second = merge(",
      "  gamma,",
      "  delta",
      ");",
      "",
    ].join("\n"),
  );
});
