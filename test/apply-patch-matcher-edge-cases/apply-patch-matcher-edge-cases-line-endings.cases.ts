import {
  assert,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  workspace,
} from "./apply-patch-matcher-edge-cases-harness.ts";

test("contains structural replacements with multibyte prefixes and CRLF", async (t) => {
  const cwd = await workspace(t);
  const content = 'const emoji = "😀";\r\nconst result = combine(alpha, beta);\r\n';
  await writeFile(join(cwd, "unicode.ts"), content);

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: unicode.ts
@@
-const result = combine(
-  alpha,
-  beta
-);
+const result = merge(
+  alpha,
+  beta
+);
*** End Patch`,
    ),
    /Failed to find expected lines/u,
  );

  assert.equal(await readFile(join(cwd, "unicode.ts"), "utf8"), content);
});

test("contains stale-context line recovery in CRLF files", async (t) => {
  const cwd = await workspace(t);
  const content = "current context\r\nold\r\n";
  await writeFile(join(cwd, "line-recovery.txt"), content);

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: line-recovery.txt
@@
 stale context
-old
+new
*** End Patch`,
    ),
    /Failed to find expected lines/u,
  );

  assert.equal(await readFile(join(cwd, "line-recovery.txt"), "utf8"), content);
});

test("preserves local line endings during strict matching", async (t) => {
  const cwd = await workspace(t);

  await writeFile(join(cwd, "single.txt"), "old\r\nnext\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: single.txt
@@
-old
+new
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "single.txt"), "utf8"), "new\r\nnext\r\n");

  await writeFile(join(cwd, "multi.txt"), "head\r\nold one\r\nold two\r\ntail\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: multi.txt
@@
 head
-old one
-old two
+new one
+new two
 tail
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "multi.txt"), "utf8"),
    "head\r\nnew one\r\nnew two\r\ntail\r\n",
  );

  await writeFile(join(cwd, "insert.txt"), "before\r\nafter\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: insert.txt
@@
 before
+inserted
 after
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "insert.txt"), "utf8"), "before\r\ninserted\r\nafter\r\n");

  await writeFile(join(cwd, "delete.txt"), "before\r\nremoved\r\nafter\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: delete.txt
@@
 before
-removed
 after
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "delete.txt"), "utf8"), "before\r\nafter\r\n");

  await writeFile(join(cwd, "mixed.txt"), "one\r\ntwo\nthree\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: mixed.txt
@@
-two
+changed
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "mixed.txt"), "utf8"), "one\r\nchanged\nthree\r\n");

  await writeFile(join(cwd, "eof.txt"), "head\r\ntail\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: eof.txt
@@
-tail
+new tail
*** End of File
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "eof.txt"), "utf8"), "head\r\nnew tail\r\n");

  await writeFile(join(cwd, "eof-insert.txt"), "head\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: eof-insert.txt
@@
+tail
*** End of File
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "eof-insert.txt"), "utf8"), "head\r\ntail\r\n");
});
