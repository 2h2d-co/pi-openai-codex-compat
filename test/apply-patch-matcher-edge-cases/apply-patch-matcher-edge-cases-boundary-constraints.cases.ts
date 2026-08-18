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

test("honors explicit end-of-file constraints during recovery", async (t) => {
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

test("does not invent a blank line when recovering into an empty file", async (t) => {
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

test("applies end-of-file to the complete recovered chunk", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "middle.ts",
    "const value = combine(alpha, beta);\nconst tail = true;\n",
    `*** Begin Patch
*** Update File: middle.ts
@@ stale
-const value = combine(
-  alpha,
-  beta
-);
+const value = merge(
+  alpha,
+  beta,
+);
*** End of File
*** End Patch`,
    /Failed to find context/u,
  );

  await writeFile(join(cwd, "tail-context.txt"), "head\nold\nfooter\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: tail-context.txt
@@ stale
-old
+new
 footer
*** End of File
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "tail-context.txt"), "utf8"), "head\nnew\nfooter\n");

  await writeFile(join(cwd, "append.txt"), "anchor\nmiddle\ntail\n");
  await rejectWithoutWrite(
    cwd,
    "append.txt",
    "anchor\nmiddle\ntail\n",
    `*** Begin Patch
*** Update File: append.txt
@@ stale
 anchor
+inserted
*** End of File
*** End Patch`,
    /Failed to find context/u,
  );
});

test("rejects tolerant candidates before a present anchor", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "anchor.txt",
    "target\nanchor\n",
    `*** Begin Patch
*** Update File: anchor.txt
@@ anchor
-target
+changed
*** End Patch`,
    /Failed to find expected lines/u,
  );
  await rejectWithoutWrite(
    cwd,
    "anchor.ts",
    "const value = combine(alpha, beta);\nanchor\n",
    `*** Begin Patch
*** Update File: anchor.ts
@@ anchor
-const value = combine(
-  alpha,
-  beta
-);
+const value = merge(
+  alpha,
+  beta,
+);
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("applies exact indentation and preserves CRLF for structural replacements", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "indent.ts"), "function run() {\n  combine(alpha, beta);\n}\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: indent.ts
@@ stale
-  combine(
-    alpha,
-    beta
-  );
+  merge(
+    alpha,
+    beta,
+    gamma,
+  );
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "indent.ts"), "utf8"),
    ["function run() {", "  merge(", "    alpha,", "    beta,", "    gamma,", "  );", "}", ""].join(
      "\n",
    ),
  );

  await writeFile(
    join(cwd, "crlf.ts"),
    "function run() {\r\n  return combine(alpha, beta);\r\n}\r\n",
  );
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: crlf.ts
@@ stale
-  return combine(
-    alpha,
-    beta
-  );
+  return merge(
+    alpha,
+    beta,
+    gamma,
+  );
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "crlf.ts"), "utf8"),
    "function run() {\r\n  return merge(\r\n    alpha,\r\n    beta,\r\n    gamma,\r\n  );\r\n}\r\n",
  );
});
