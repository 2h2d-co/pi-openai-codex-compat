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

test("applies structurally recovered replacement indentation exactly", async (t) => {
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
-  const result = [
-    alpha,
-    beta
-  ];
+  const result = [
+    alpha,
+    beta,
+    gamma,
+  ];
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

test("recovers only complete formatter-collapsed line content", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "Complete.java"), "class Complete {\n  void func() { return a; }\n}\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: Complete.java
@@ stale
-void func() {
-  return a;
-}
+  void func() {
+    return b;
+  }
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "Complete.java"), "utf8"),
    "class Complete {\n  void func() {\n    return b;\n  }\n}\n",
  );

  await rejectWithoutWrite(
    cwd,
    "Additional.java",
    "class Additional {\n  public void func() { return a; }\n}\n",
    `*** Begin Patch
*** Update File: Additional.java
@@ stale
-void func() {
-  return a;
-}
+void func() {
+  return b;
+}
*** End Patch`,
    /No formatter-tolerant candidate/u,
  );
});

test("rejects structural matches that cover only part of a source line", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "inline.ts",
    "function run() { return combine(alpha, beta); }\n",
    `*** Begin Patch
*** Update File: inline.ts
@@ stale
-combine(
-  alpha,
-  beta
-)
+merge(
+  alpha,
+  beta,
+  gamma,
+)
*** End Patch`,
    /No formatter-tolerant candidate/u,
  );
});

test("rejects single-token structural recovery", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "single-token.ts",
    "function run() { return value; }\n",
    `*** Begin Patch
*** Update File: single-token.ts
@@ stale
-value
+replacement
*** End Patch`,
    /No formatter-tolerant candidate/u,
  );
});

test("retains official first-match behavior when strict matching succeeds", async (t) => {
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
