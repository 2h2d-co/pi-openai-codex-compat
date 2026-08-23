import {
  assert,
  chmod,
  link,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchVerificationError,
  formatApplyPatchSummary,
  ApplyPatchDiffComponent,
  workspace,
  assertMissing,
  patch,
} from "./apply-patch-semantic-harness.ts";

test("handles self moves, hard links, and proven repeated moves", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "self.bin"), Buffer.from([0xff]));
  await writeFile(join(cwd, "hard-a.txt"), "hard linked\n");
  await link(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  await writeFile(join(cwd, "repeat-a.txt"), "repeat\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: self.bin\n*** Move to: ./self.bin\n",
      "*** Update File: hard-a.txt\n*** Move to: hard-b.txt\n",
      "*** Update File: repeat-a.txt\n*** Move to: repeat-b.txt\n",
      "*** Update File: repeat-a.txt\n*** Move to: repeat-b.txt\n",
    ),
  );

  assert.deepEqual(await readFile(join(cwd, "self.bin")), Buffer.from([0xff]));
  await assertMissing(join(cwd, "hard-a.txt"));
  assert.equal(await readFile(join(cwd, "hard-b.txt"), "utf8"), "hard linked\n");
  assert.equal(await readFile(join(cwd, "repeat-b.txt"), "utf8"), "repeat\n");
  assert.equal(details.changes.length, 2);
});

test("preserves hard-link observations across sequential content writes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "alias-a.txt"), "before\n");
  await link(join(cwd, "alias-a.txt"), join(cwd, "alias-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: alias-a.txt\n@@\n-before\n+after\n",
      "*** Update File: alias-b.txt\n@@\n-after\n+final\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "alias-a.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias-b.txt"), "utf8"), "final\n");
});

test("follows symlinks for updates but replaces them for adds", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "before\n");
  await symlink("target.txt", join(cwd, "alias.txt"));

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: alias.txt\n@@\n-before\n+after\n",
      "*** Update File: target.txt\n@@\n-after\n+final\n",
      "*** Add File: alias.txt\n+independent\n",
      "*** Update File: alias.txt\n@@\n-independent\n+done\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias.txt"), "utf8"), "done\n");
  await assert.rejects(readlink(join(cwd, "alias.txt")), { code: "EINVAL" });
  const feedback = formatApplyPatchSummary(details, cwd);
  assert.match(feedback, /Patch instruction results:/u);
  assert.match(
    feedback,
    /1\. \[APPLIED\] Update alias\.txt - Modified file content through the symlink at alias\.txt \(target: target\.txt\); the symlink was not modified\./u,
  );
  assert.match(feedback, /2\. \[APPLIED\] Update target\.txt$/mu);
  assert.match(
    feedback,
    /3\. \[APPLIED\] Add alias\.txt - alias\.txt, previously a symlink to target\.txt, is now a regular file\./u,
  );
  assert.match(feedback, /4\. \[APPLIED\] Update alias\.txt$/mu);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = new ApplyPatchDiffComponent(details, theme, cwd, false).render(120).join("\n");
  assert.match(rendered, /Patch instruction results:/u);
  assert.match(
    rendered,
    /1\. \[APPLIED\] Update alias\.txt — Modified file content through the symlink at alias\.txt \(target: target\.txt\); the\s+symlink was not modified\./u,
  );
  assert.match(rendered, /2\. \[APPLIED\] Update target\.txt$/mu);
});

test("replaces live and dangling symlinks on add without touching their targets", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "same\n");
  await symlink("target.txt", join(cwd, "live.txt"));
  await symlink("missing.txt", join(cwd, "dangling.txt"));

  const details = await applyPatch(
    cwd,
    patch("*** Add File: live.txt\n+same\n", "*** Add File: dangling.txt\n+created here\n"),
  );

  assert.equal(details.exact, true);
  assert.equal(await readFile(join(cwd, "live.txt"), "utf8"), "same\n");
  assert.equal(await readFile(join(cwd, "dangling.txt"), "utf8"), "created here\n");
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "same\n");
  await assertMissing(join(cwd, "missing.txt"));
  await assert.rejects(readlink(join(cwd, "live.txt")), { code: "EINVAL" });
  await assert.rejects(readlink(join(cwd, "dangling.txt")), { code: "EINVAL" });
  const feedback = formatApplyPatchSummary(details, cwd);
  assert.match(
    feedback,
    /1\. \[APPLIED\] Add live\.txt - live\.txt, previously a symlink to target\.txt, is now a regular file\./u,
  );
  assert.match(
    feedback,
    /2\. \[APPLIED\] Add dangling\.txt - dangling\.txt, previously a symlink to missing\.txt, is now a regular file\./u,
  );
});

test("tracks symlink chains and rejects links made dangling earlier in the patch", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "before\n");
  await symlink("target.txt", join(cwd, "middle.txt"));
  await symlink("middle.txt", join(cwd, "outer.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: outer.txt\n@@\n-before\n+after\n",
      "*** Update File: middle.txt\n@@\n-after\n+final\n",
    ),
  );
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Delete File: target.txt\n",
        "*** Update File: outer.txt\n@@\n-final\n+should not happen\n",
      ),
    ),
    /symlink target does not exist/,
  );
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");
});

test("proves dead updates across symlink, hard-link, and path aliases", async (t) => {
  const cwd = await workspace(t);

  await writeFile(join(cwd, "symlink-target.txt"), "before\n");
  await symlink("symlink-target.txt", join(cwd, "symlink-alias.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: symlink-alias.txt\n@@\n-missing\n+after\n",
        "*** Delete File: symlink-alias.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "symlink-target.txt"), "utf8"), "before\n");
  assert.equal(await readlink(join(cwd, "symlink-alias.txt")), "symlink-target.txt");

  await writeFile(join(cwd, "hard-a.txt"), "before\n");
  await link(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: hard-a.txt\n@@\n-missing\n+after\n", "*** Delete File: hard-a.txt\n"),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "hard-a.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "hard-b.txt"), "utf8"), "before\n");

  await writeFile(join(cwd, "dominated-target.txt"), "before\n");
  await symlink("dominated-target.txt", join(cwd, "dominated-alias.txt"));
  const symlinkTargetDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: dominated-alias.txt\n@@\n-missing\n+after\n",
      "*** Delete File: dominated-target.txt\n",
    ),
  );
  assert.deepEqual(
    symlinkTargetDominated.instructions?.map(({ status }) => status),
    ["dead", "applied"],
  );
  await assertMissing(join(cwd, "dominated-target.txt"));
  assert.equal(await readlink(join(cwd, "dominated-alias.txt")), "dominated-target.txt");

  await writeFile(join(cwd, "all-hard-a.txt"), "before\n");
  await link(join(cwd, "all-hard-a.txt"), join(cwd, "all-hard-b.txt"));
  const allHardLinksDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: all-hard-a.txt\n@@\n-missing\n+after\n",
      "*** Delete File: all-hard-a.txt\n",
      "*** Delete File: all-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    allHardLinksDominated.instructions?.map(({ status }) => status),
    ["dead", "applied", "applied"],
  );
  await assertMissing(join(cwd, "all-hard-a.txt"));
  await assertMissing(join(cwd, "all-hard-b.txt"));

  await writeFile(join(cwd, "prior-hard-a.txt"), "before\n");
  await link(join(cwd, "prior-hard-a.txt"), join(cwd, "prior-hard-b.txt"));
  const priorHardLinkRemoved = await applyPatch(
    cwd,
    patch(
      "*** Delete File: prior-hard-a.txt\n",
      "*** Update File: prior-hard-b.txt\n@@\n-missing\n+after\n",
      "*** Delete File: prior-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    priorHardLinkRemoved.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  await assertMissing(join(cwd, "prior-hard-a.txt"));
  await assertMissing(join(cwd, "prior-hard-b.txt"));

  await writeFile(join(cwd, "replaced-hard-a.txt"), "before\n");
  await link(join(cwd, "replaced-hard-a.txt"), join(cwd, "replaced-hard-b.txt"));
  const priorHardLinkReplaced = await applyPatch(
    cwd,
    patch(
      "*** Add File: replaced-hard-a.txt\n+independent\n",
      "*** Update File: replaced-hard-b.txt\n@@\n-missing\n+after\n",
      "*** Delete File: replaced-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    priorHardLinkReplaced.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  assert.equal(await readFile(join(cwd, "replaced-hard-a.txt"), "utf8"), "independent\n");
  await assertMissing(join(cwd, "replaced-hard-b.txt"));

  await writeFile(join(cwd, "replayed-hard-a.txt"), "old\n");
  await link(join(cwd, "replayed-hard-a.txt"), join(cwd, "replayed-hard-b.txt"));
  const replayedFutureState = await applyPatch(
    cwd,
    patch(
      "*** Update File: replayed-hard-a.txt\n@@\n-missing\n+ignored\n",
      "*** Delete File: replayed-hard-a.txt\n",
      "*** Add File: replayed-hard-a.txt\n+old\n",
      "*** Delete File: replayed-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    replayedFutureState.instructions?.map(({ status }) => status),
    ["dead", "applied", "applied", "applied"],
  );
  assert.deepEqual(replayedFutureState.instructions?.[0]?.reason?.dominatingInstructions, [2, 4]);
  assert.equal(await readFile(join(cwd, "replayed-hard-a.txt"), "utf8"), "old\n");
  assert.equal((await stat(join(cwd, "replayed-hard-a.txt"))).nlink, 1);
  await assertMissing(join(cwd, "replayed-hard-b.txt"));

  const plannedEntryDominated = await applyPatch(
    cwd,
    patch(
      "*** Add File: planned-entry.txt\n+known\n",
      "*** Update File: planned-entry.txt\n@@\n-missing\n+after\n",
      "*** Delete File: planned-entry.txt\n",
    ),
  );
  assert.deepEqual(
    plannedEntryDominated.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  await assertMissing(join(cwd, "planned-entry.txt"));

  await writeFile(join(cwd, "moved-hard-a.txt"), "before\n");
  await link(join(cwd, "moved-hard-a.txt"), join(cwd, "moved-hard-b.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: moved-hard-a.txt\n*** Move to: moved-hard-c.txt\n",
        "*** Update File: moved-hard-b.txt\n@@\n-missing\n+after\n",
        "*** Delete File: moved-hard-b.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "moved-hard-a.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "moved-hard-b.txt"), "utf8"), "before\n");
  await assertMissing(join(cwd, "moved-hard-c.txt"));

  await mkdir(join(cwd, "real-parent"));
  await symlink("real-parent", join(cwd, "alias-parent"));
  await writeFile(join(cwd, "real-parent", "file.txt"), "before\n");
  const parentAliasDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: alias-parent/file.txt\n@@\n-missing\n+after\n",
      "*** Delete File: real-parent/file.txt\n",
    ),
  );
  assert.deepEqual(
    parentAliasDominated.instructions?.map(({ status }) => status),
    ["dead", "applied"],
  );
  await assertMissing(join(cwd, "real-parent", "file.txt"));
});

test("materializes state-changing symlink moves without modifying either target", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source-target.txt"), "source old\n");
  await writeFile(join(cwd, "destination-target.txt"), "destination old\n");
  await symlink("source-target.txt", join(cwd, "source-link.txt"));
  await symlink("destination-target.txt", join(cwd, "destination-link.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: source-link.txt\n",
      "*** Move to: destination-link.txt\n",
      "@@\n",
      "-source old\n",
      "+moved new\n",
    ),
  );

  await assertMissing(join(cwd, "source-link.txt"));
  assert.equal(await readFile(join(cwd, "destination-link.txt"), "utf8"), "moved new\n");
  await assert.rejects(readlink(join(cwd, "destination-link.txt")), { code: "EINVAL" });
  assert.equal(await readFile(join(cwd, "source-target.txt"), "utf8"), "source old\n");
  assert.equal(await readFile(join(cwd, "destination-target.txt"), "utf8"), "destination old\n");
});

test("moves dangling symlink entries opaquely", async (t) => {
  const cwd = await workspace(t);
  await symlink("missing-source-target", join(cwd, "source-link"));
  await symlink("missing-destination-target", join(cwd, "destination-link"));

  await applyPatch(cwd, patch("*** Update File: source-link\n*** Move to: destination-link\n"));

  await assertMissing(join(cwd, "source-link"));
  assert.equal(await readlink(join(cwd, "destination-link")), "missing-source-target");
  await assertMissing(join(cwd, "missing-source-target"));
  await assertMissing(join(cwd, "missing-destination-target"));
});

test("preserves hard-link semantics across replacements, moves, and planned unlinks", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "add-a.txt"), "old add\n");
  await chmod(join(cwd, "add-a.txt"), 0o754);
  await link(join(cwd, "add-a.txt"), join(cwd, "add-b.txt"));

  await writeFile(join(cwd, "move-a.txt"), "old move\n");
  await chmod(join(cwd, "move-a.txt"), 0o751);
  await link(join(cwd, "move-a.txt"), join(cwd, "move-b.txt"));
  await writeFile(join(cwd, "destination.txt"), "old destination\n");
  await link(join(cwd, "destination.txt"), join(cwd, "destination-b.txt"));

  await writeFile(join(cwd, "delete-a.txt"), "delete then update\n");
  await link(join(cwd, "delete-a.txt"), join(cwd, "delete-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Add File: add-a.txt\n+new add\n",
      "*** Update File: move-a.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-old move\n",
      "+new move\n",
      "*** Delete File: delete-a.txt\n",
      "*** Update File: delete-b.txt\n@@\n-delete then update\n+updated survivor\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "add-a.txt"), "utf8"), "new add\n");
  assert.equal(await readFile(join(cwd, "add-b.txt"), "utf8"), "old add\n");
  assert.notEqual(
    (await stat(join(cwd, "add-a.txt"))).ino,
    (await stat(join(cwd, "add-b.txt"))).ino,
  );
  assert.equal((await stat(join(cwd, "add-a.txt"))).mode & 0o777, 0o754);

  await assertMissing(join(cwd, "move-a.txt"));
  assert.equal(await readFile(join(cwd, "move-b.txt"), "utf8"), "old move\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new move\n");
  assert.equal(await readFile(join(cwd, "destination-b.txt"), "utf8"), "old destination\n");
  assert.equal((await stat(join(cwd, "destination.txt"))).mode & 0o777, 0o751);
  assert.notEqual(
    (await stat(join(cwd, "destination.txt"))).ino,
    (await stat(join(cwd, "destination-b.txt"))).ino,
  );

  await assertMissing(join(cwd, "delete-a.txt"));
  assert.equal(await readFile(join(cwd, "delete-b.txt"), "utf8"), "updated survivor\n");
});

test("preserves regular-file modes across sequential virtual replacements", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "repeated-add.txt"), "before\n");
  await chmod(join(cwd, "repeated-add.txt"), 0o600);
  await writeFile(join(cwd, "updated-source.txt"), "before\n");
  await chmod(join(cwd, "updated-source.txt"), 0o700);
  await writeFile(join(cwd, "copied-source.txt"), "before\n");
  await chmod(join(cwd, "copied-source.txt"), 0o741);

  await applyPatch(
    cwd,
    patch(
      "*** Add File: repeated-add.txt\n+middle\n",
      "*** Add File: repeated-add.txt\n+after\n",
      "*** Update File: updated-source.txt\n@@\n-before\n+middle\n",
      "*** Update File: updated-source.txt\n",
      "*** Move to: updated-destination.txt\n",
      "@@\n",
      "-middle\n",
      "+after\n",
      "*** Update File: copied-source.txt\n*** Move to: copied-middle.txt\n",
      "*** Update File: copied-middle.txt\n",
      "*** Move to: copied-destination.txt\n",
      "@@\n",
      "-before\n",
      "+after\n",
    ),
    undefined,
    {
      selectMoveStrategy: (sourcePath) =>
        sourcePath.endsWith("copied-source.txt") ? "copy-unlink" : "rename",
    },
  );

  assert.equal((await stat(join(cwd, "repeated-add.txt"))).mode & 0o7777, 0o600);
  assert.equal((await stat(join(cwd, "updated-destination.txt"))).mode & 0o7777, 0o700);
  assert.equal((await stat(join(cwd, "copied-destination.txt"))).mode & 0o7777, 0o741);
});

test("keeps hard-link topology for no-op adds and pure native moves", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "same-a.txt"), "same\n");
  await link(join(cwd, "same-a.txt"), join(cwd, "same-b.txt"));

  await writeFile(join(cwd, "source-a.txt"), "source\n");
  await link(join(cwd, "source-a.txt"), join(cwd, "source-b.txt"));
  await writeFile(join(cwd, "destination-a.txt"), "destination\n");
  await link(join(cwd, "destination-a.txt"), join(cwd, "destination-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Add File: same-a.txt\n+same\n",
      "*** Update File: source-a.txt\n*** Move to: destination-a.txt\n",
    ),
  );

  assert.equal(
    (await stat(join(cwd, "same-a.txt"))).ino,
    (await stat(join(cwd, "same-b.txt"))).ino,
  );
  await assertMissing(join(cwd, "source-a.txt"));
  assert.equal(await readFile(join(cwd, "destination-a.txt"), "utf8"), "source\n");
  assert.equal(await readFile(join(cwd, "source-b.txt"), "utf8"), "source\n");
  assert.equal(
    (await stat(join(cwd, "destination-a.txt"))).ino,
    (await stat(join(cwd, "source-b.txt"))).ino,
  );
  assert.equal(await readFile(join(cwd, "destination-b.txt"), "utf8"), "destination\n");
  assert.notEqual(
    (await stat(join(cwd, "destination-a.txt"))).ino,
    (await stat(join(cwd, "destination-b.txt"))).ino,
  );
});
