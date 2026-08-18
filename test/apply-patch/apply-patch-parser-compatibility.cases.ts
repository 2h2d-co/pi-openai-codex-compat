import {
  assert,
  mkdir,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  parsePatch,
  parsePatchDocument,
  workspace,
} from "./apply-patch-harness.ts";

test("matches Codex overwrite semantics for add and move", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "duplicate.txt"), "old content\n");
  await mkdir(join(cwd, "old"), { recursive: true });
  await mkdir(join(cwd, "renamed"), { recursive: true });
  await writeFile(join(cwd, "old/name.txt"), "from\n");
  await writeFile(join(cwd, "renamed/name.txt"), "existing\n");

  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-from
+new
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "duplicate.txt"), "utf8"), "new content\n");
  assert.equal(await readFile(join(cwd, "renamed/name.txt"), "utf8"), "new\n");
  await assert.rejects(readFile(join(cwd, "old/name.txt"), "utf8"), { code: "ENOENT" });
  assert.deepEqual(details.added, ["duplicate.txt"]);
  assert.deepEqual(details.modified, ["renamed/name.txt"]);
  assert.equal(details.changes[0]?.kind, "add");
  assert.equal(
    details.changes[0]?.kind === "add" ? details.changes[0].overwrittenContent : undefined,
    "old content\n",
  );
  assert.deepEqual(details.changes[1], {
    kind: "update",
    path: "old/name.txt",
    moveTo: "renamed/name.txt",
    oldContent: "from\n",
    newContent: "new\n",
    overwrittenMoveContent: "existing\n",
    displayDiff: "-1 from\n+1 new",
    additions: 1,
    deletions: 1,
  });
});

test("matches Codex lenient parsing around markers, heredocs, and blank context", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "file.txt"), "one\n\ntwo\n");

  const wrapped = `<<'EOF'
 *** Begin Patch
  *** Update File: file.txt
@@
 one

-two
+three
 *** End Patch
EOF`;
  const parsed = parsePatchDocument(wrapped);
  assert.equal(parsed.patch.trimStart().startsWith("*** Begin Patch"), true);
  assert.equal(parsed.operations[0]?.kind, "update");
  assert.equal(
    parsePatch("\u0085*** Begin Patch\n*** Add File: spaced.txt\n+ok\n*** End Patch\u0085")[0]
      ?.path,
    "spaced.txt",
  );
  assert.throws(
    () => parsePatch("\ufeff*** Begin Patch\n*** Add File: bom.txt\n+no\n*** End Patch"),
    /first line/,
  );
  assert.throws(() => parsePatch(""), /last line/);

  await applyPatch(cwd, wrapped);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "one\n\nthree\n");

  assert.throws(
    () =>
      parsePatch(`*** Begin Patch
*** Add File: one.txt
+one

*** Add File: two.txt
+two
*** End Patch`),
    /is not a valid hunk header/,
  );
  await assert.rejects(
    applyPatch(cwd, "*** Begin Patch\n*** End Patch"),
    /patch rejected: empty patch/,
  );
});

test("matches Codex fuzzy Unicode and strict end-of-file matching", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "unicode.txt"), "“hello” — world\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: unicode.txt
@@
-"hello" - world
+"hello" - updated
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "unicode.txt"), "utf8"), '"hello" - updated\n');

  await writeFile(join(cwd, "rust-whitespace.txt"), "target\u0085\n");
  await applyPatch(
    cwd,
    "*** Begin Patch\n*** Update File: rust-whitespace.txt\n@@\n-target\n+matched\n*** End Patch",
  );
  assert.equal(await readFile(join(cwd, "rust-whitespace.txt"), "utf8"), "matched\n");

  await writeFile(join(cwd, "tail.txt"), "target\nnot-the-end\n");
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: tail.txt
@@
-target
+changed
*** End of File
*** End Patch`,
    ),
    /Failed to find expected lines/,
  );
  assert.equal(await readFile(join(cwd, "tail.txt"), "utf8"), "target\nnot-the-end\n");

  await writeFile(join(cwd, "context.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: context.txt
@@
-four
+changed
*** End Patch`,
  );
  const change = details.changes[0];
  assert.equal(change?.kind, "update");
  if (change?.kind === "update") {
    assert.match(change.displayDiff, / 3 three/);
    assert.match(change.displayDiff, / 5 five/);
    assert.doesNotMatch(change.displayDiff, / 1 one/);
    assert.doesNotMatch(change.displayDiff, / 7 seven/);
  }
});
