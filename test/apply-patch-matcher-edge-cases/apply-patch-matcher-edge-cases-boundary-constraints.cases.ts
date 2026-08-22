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

test("contains explicit end-of-file recovery after strict mismatch", async (t) => {
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

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: tail.txt
@@ stale
+appended
*** End of File
*** End Patch`,
    ),
    /Failed to find context/u,
  );
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "target\nnot-the-tail\n");
});

test("contains formatter recovery into an empty file", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "empty.txt"), "");

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: empty.txt
@@ stale
+first
*** End of File
*** End Patch`,
    ),
    /Failed to find context/u,
  );

  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
});

test("contains end-of-file recovery for complete chunks", async (t) => {
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

  const tailContent = "head\nold\nfooter\n";
  await writeFile(join(cwd, "tail-context.txt"), tailContent);
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: tail-context.txt
@@ stale
-old
+new
 footer
*** End of File
*** End Patch`,
    ),
    /Failed to find context/u,
  );
  assert.equal(await readFile(join(cwd, "tail-context.txt"), "utf8"), tailContent);

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

test("contains structural indentation and CRLF recovery", async (t) => {
  const cwd = await workspace(t);
  const indentContent = "function run() {\n  combine(alpha, beta);\n}\n";
  await writeFile(join(cwd, "indent.ts"), indentContent);
  await assert.rejects(
    applyPatch(
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
    ),
    /Failed to find context/u,
  );
  assert.equal(await readFile(join(cwd, "indent.ts"), "utf8"), indentContent);

  const crlfContent = "function run() {\r\n  return combine(alpha, beta);\r\n}\r\n";
  await writeFile(join(cwd, "crlf.ts"), crlfContent);
  await assert.rejects(
    applyPatch(
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
    ),
    /Failed to find context/u,
  );
  assert.equal(await readFile(join(cwd, "crlf.ts"), "utf8"), crlfContent);
});
