import {
  assert,
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  writeFile,
  join,
  test,
  applyPatch,
  formatApplyPatchSummary,
  formatApplyPatchRenderText,
  workspace,
  assertMissing,
  patch,
} from "./apply-patch-semantic-harness.ts";

test("deletes symlink entries without deleting their targets", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "preserved\n");
  await symlink("target.txt", join(cwd, "alias.txt"));

  const direct = await applyPatch(cwd, patch("*** Delete File: alias.txt\n"));

  await assertMissing(join(cwd, "alias.txt"));
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "preserved\n");
  assert.deepEqual(direct.changes, [
    {
      kind: "delete",
      path: "alias.txt",
      entryType: "symlink",
      displayDiff: "",
      additions: 0,
      deletions: 0,
    },
  ]);

  await symlink("missing.txt", join(cwd, "dangling.txt"));
  const dangling = await applyPatch(cwd, patch("*** Delete File: dangling.txt\n"));
  assert.equal(
    dangling.changes[0]?.kind === "delete" ? dangling.changes[0].entryType : undefined,
    "symlink",
  );
  await assertMissing(join(cwd, "dangling.txt"));

  await writeFile(join(cwd, "followed-target.txt"), "old target\n");
  await symlink("followed-target.txt", join(cwd, "followed-link.txt"));
  const followed = await applyPatch(
    cwd,
    patch(
      "*** Update File: followed-link.txt\n@@\n-old target\n+new target\n",
      "*** Delete File: followed-link.txt\n",
    ),
  );
  assert.equal(await readFile(join(cwd, "followed-target.txt"), "utf8"), "new target\n");
  await assertMissing(join(cwd, "followed-link.txt"));
  assert.deepEqual(followed.changes[1], {
    kind: "delete",
    path: "followed-link.txt",
    entryType: "symlink",
    displayDiff: "",
    additions: 0,
    deletions: 0,
  });
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = formatApplyPatchRenderText(followed, theme, cwd);
  assert.match(rendered, /followed-link\.txt \(deleted symlink\)/u);
  assert.match(
    formatApplyPatchSummary(followed, cwd),
    /2\. \[APPLIED\] Delete followed-link\.txt - Removed the symlink followed-link\.txt; its target was followed-target\.txt\./u,
  );
  assert.doesNotMatch(JSON.stringify(followed.changes[1]), /old target|new target/u);
});

test("does not dereference cyclic symlinks for entry-only operations or no-ops", async (t) => {
  const cwd = await workspace(t);
  const createCycle = async (prefix: string): Promise<void> => {
    await symlink(`${prefix}-b`, join(cwd, `${prefix}-a`));
    await symlink(`${prefix}-a`, join(cwd, `${prefix}-b`));
  };

  await createCycle("empty");
  const empty = await applyPatch(cwd, patch("*** Update File: empty-a\n"));
  assert.equal(empty.instructions?.[0]?.reason?.code, "empty-update");
  assert.equal(await readlink(join(cwd, "empty-a")), "empty-b");

  await createCycle("identity");
  const identity = await applyPatch(cwd, patch("*** Update File: identity-a\n@@\n-same\n+same\n"));
  assert.equal(identity.instructions?.[0]?.reason?.code, "identity-update");
  assert.equal(await readlink(join(cwd, "identity-a")), "identity-b");

  await createCycle("text");
  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: text-a\n@@\n-old\n+new\n")),
    /symlink cycle/u,
  );

  await createCycle("add");
  await applyPatch(cwd, patch("*** Add File: add-a\n+replacement\n"));
  assert.equal(await readFile(join(cwd, "add-a"), "utf8"), "replacement\n");
  assert.equal(await readlink(join(cwd, "add-b")), "add-a");

  await createCycle("delete");
  await applyPatch(cwd, patch("*** Delete File: delete-a\n"));
  await assertMissing(join(cwd, "delete-a"));
  assert.equal(await readlink(join(cwd, "delete-b")), "delete-a");

  await createCycle("move");
  await applyPatch(cwd, patch("*** Update File: move-a\n*** Move to: moved-link\n"));
  await assertMissing(join(cwd, "move-a"));
  assert.equal(await readlink(join(cwd, "moved-link")), "move-b");
  assert.equal(await readlink(join(cwd, "move-b")), "move-a");

  await writeFile(join(cwd, "destination-source.txt"), "source\n");
  await createCycle("destination");
  await applyPatch(
    cwd,
    patch("*** Update File: destination-source.txt\n", "*** Move to: destination-a\n"),
  );
  await assertMissing(join(cwd, "destination-source.txt"));
  assert.equal(await readFile(join(cwd, "destination-a"), "utf8"), "source\n");
  assert.equal(await readlink(join(cwd, "destination-b")), "destination-a");
});

test("shares virtual state through a symlinked parent without moving the entry twice", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));
  await writeFile(join(cwd, "real", "file.txt"), "before\n");

  await applyPatch(
    cwd,
    patch(
      "*** Update File: real/file.txt\n@@\n-before\n+after\n",
      "*** Update File: alias/file.txt\n@@\n-after\n+final\n",
      "*** Update File: real/file.txt\n*** Move to: alias/file.txt\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "real", "file.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias", "file.txt"), "utf8"), "final\n");
  assert.deepEqual(await readdir(join(cwd, "real")), ["file.txt"]);
});

test("routes later operations through a symlink parent moved earlier in the patch", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await writeFile(join(cwd, "real", "existing.txt"), "before\n");
  await symlink("real", join(cwd, "alias"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: alias\n*** Move to: moved-alias\n",
      "*** Update File: moved-alias/existing.txt\n@@\n-before\n+middle\n",
      "*** Update File: real/existing.txt\n@@\n-middle\n+after\n",
      "*** Add File: moved-alias/created.txt\n+created\n",
      "*** Update File: real/created.txt\n@@\n-created\n+final\n",
    ),
  );

  await assertMissing(join(cwd, "alias"));
  assert.equal(await readlink(join(cwd, "moved-alias")), "real");
  assert.equal(await readFile(join(cwd, "real", "existing.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "moved-alias", "created.txt"), "utf8"), "final\n");
});

test("resolves relative symlink targets from canonical aliased parents", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "source-real", "sub"), { recursive: true });
  await writeFile(join(cwd, "source-real", "target.txt"), "source before\n");
  await symlink("../target.txt", join(cwd, "source-real", "sub", "link.txt"));
  await symlink("source-real/sub", join(cwd, "source-alias"));

  await mkdir(join(cwd, "destination-real", "sub"), { recursive: true });
  await writeFile(join(cwd, "destination-real", "target.txt"), "destination before\n");
  await symlink("destination-real/sub", join(cwd, "destination-alias"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: source-alias/link.txt\n",
      "@@\n",
      "-source before\n",
      "+source after\n",
      "*** Update File: source-real/sub/link.txt\n",
      "*** Move to: destination-alias/link.txt\n",
      "*** Update File: destination-alias/link.txt\n",
      "@@\n",
      "-destination before\n",
      "+destination after\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "source-real", "target.txt"), "utf8"), "source after\n");
  assert.equal(
    await readFile(join(cwd, "destination-real", "target.txt"), "utf8"),
    "destination after\n",
  );
  assert.equal(await readlink(join(cwd, "destination-real", "sub", "link.txt")), "../target.txt");
});

test("updates same-entry moves safely through a symlinked parent", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));
  await writeFile(join(cwd, "real", "file.txt"), "before\n");
  await link(join(cwd, "real", "file.txt"), join(cwd, "other-link.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: real/file.txt\n",
      "*** Move to: alias/file.txt\n",
      "@@\n",
      "-before\n",
      "+after\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "real", "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "other-link.txt"), "utf8"), "before\n");
  assert.notEqual(
    (await stat(join(cwd, "real", "file.txt"))).ino,
    (await stat(join(cwd, "other-link.txt"))).ino,
  );
});

test("replaces a destination symlink that points back to the move source", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source.txt"), "old\n");
  await symlink("source.txt", join(cwd, "destination.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: source.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-old\n",
      "+new\n",
    ),
  );

  await assertMissing(join(cwd, "source.txt"));
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new\n");
  await assert.rejects(readlink(join(cwd, "destination.txt")), { code: "EINVAL" });
});
