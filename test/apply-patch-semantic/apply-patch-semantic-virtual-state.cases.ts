import {
  assert,
  chmod,
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
  isApplyPatchDetails,
  workspace,
  assertMissing,
  patch,
} from "./apply-patch-semantic-harness.ts";

void test("moves opaque regular files without decoding or changing bytes", async (t) => {
  const cwd = await workspace(t);
  const fixtures = new Map<string, Buffer>([
    ["invalid.bin", Buffer.from([0xff, 0xfe, 0x00, 0x0a])],
    ["nul.bin", Buffer.from([0x00, 0x01, 0x00])],
    ["empty.bin", Buffer.alloc(0)],
    ["bom.bin", Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])],
    ["crlf.bin", Buffer.from("one\r\ntwo\r\n")],
    ["cr.bin", Buffer.from("one\rtwo\r")],
    ["mixed.bin", Buffer.from("one\r\ntwo\rthree\n")],
    ["no-newline.bin", Buffer.from("tail")],
    ["identity.bin", Buffer.from([0xff, 0x00, 0xfe])],
  ]);
  for (const [name, bytes] of fixtures) await writeFile(join(cwd, name), bytes);
  await chmod(join(cwd, "invalid.bin"), 0o755);

  const operations = [...fixtures.keys()].map((name) =>
    name === "identity.bin"
      ? `*** Update File: ${name}\n*** Move to: moved/${name}\n@@\n-same\n+same\n`
      : `*** Update File: ${name}\n*** Move to: moved/${name}\n`,
  );
  const details = await applyPatch(cwd, patch(...operations));

  assert.equal(details.changes.length, fixtures.size);
  assert.ok(details.changes.every((change) => change.kind === "move"));
  assert.doesNotMatch(JSON.stringify(details), /\ufffd/);
  for (const [name, bytes] of fixtures) {
    assert.deepEqual(await readFile(join(cwd, "moved", name)), bytes);
    await assertMissing(join(cwd, name));
  }
  assert.equal((await stat(join(cwd, "moved", "invalid.bin"))).mode & 0o777, 0o755);
});

void test("moves symlink entries and reports both replacement entry types", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "target stays unchanged\n");
  await symlink("target.txt", join(cwd, "source-link"));
  await writeFile(join(cwd, "source.bin"), Buffer.from([0xff, 0x00]));
  await symlink("target.txt", join(cwd, "destination-link"));
  await symlink("target.txt", join(cwd, "replacement-source-link"));
  await writeFile(join(cwd, "regular-destination.txt"), "replace me\n");
  const absoluteTarget = join(cwd, "target.txt");
  await symlink(absoluteTarget, join(cwd, "absolute-target-link"));

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: source-link\n*** Move to: nested/moved-link\n",
      "*** Update File: source.bin\n*** Move to: destination-link\n",
      "*** Update File: replacement-source-link\n*** Move to: regular-destination.txt\n",
      "*** Update File: absolute-target-link\n*** Move to: nested/absolute-target-link\n",
    ),
  );

  assert.equal(await readlink(join(cwd, "nested", "moved-link")), "target.txt");
  assert.deepEqual(await readFile(join(cwd, "destination-link")), Buffer.from([0xff, 0x00]));
  assert.equal(await readlink(join(cwd, "regular-destination.txt")), "target.txt");
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "target stays unchanged\n");
  assert.deepEqual(
    details.changes.map((change) =>
      change.kind === "move"
        ? [change.entryType, change.replacedDestination]
        : [change.kind, false],
    ),
    [
      ["symlink", false],
      ["regular-file", true],
      ["symlink", true],
      ["symlink", false],
    ],
  );
  const replacementEffect = details.instructions?.[2]?.effects?.find(
    (effect) => effect.kind === "replaced",
  );
  assert.deepEqual(replacementEffect, {
    kind: "replaced",
    path: "regular-destination.txt",
    previousEntry: { entryType: "regular-file" },
    replacementEntry: { entryType: "symlink", target: "target.txt" },
  });
  assert.ok(isApplyPatchDetails(details));
  const incompleteDetails = structuredClone(details);
  assert.ok(incompleteDetails.instructions);
  const incompleteReplacement = incompleteDetails.instructions[2]?.effects?.find(
    (effect) => effect["kind"] === "replaced",
  );
  assert.ok(incompleteReplacement);
  Reflect.deleteProperty(incompleteReplacement, "replacementEntry");
  assert.equal(isApplyPatchDetails(incompleteDetails), false);
  const feedback = formatApplyPatchSummary(details, cwd);
  assert.match(
    feedback,
    /1\. \[APPLIED\] Move source-link -> nested\/moved-link - Moved the symlink source-link; nested\/moved-link is now a symlink to target\.txt\./u,
  );
  assert.match(
    feedback,
    /2\. \[APPLIED\] Move source\.bin -> destination-link - destination-link, previously a symlink to target\.txt, is now a regular file\./u,
  );
  assert.match(
    feedback,
    /3\. \[APPLIED\] Move replacement-source-link -> regular-destination\.txt - Moved the symlink replacement-source-link; regular-destination\.txt, previously a regular file, is now a symlink to target\.txt\./u,
  );
  assert.ok(
    feedback.includes(
      `4. [APPLIED] Move absolute-target-link -> nested/absolute-target-link - Moved the symlink absolute-target-link; nested/absolute-target-link is now a symlink to ${absoluteTarget}.`,
    ),
  );
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = new ApplyPatchDiffComponent(details, theme, cwd, false).render(240).join("\n");
  assert.match(
    rendered,
    /3\. \[APPLIED\] Move replacement-source-link → regular-destination\.txt — Moved the symlink replacement-source-link; regular-destination\.txt, previously a regular file, is now a symlink to target\.txt\./u,
  );

  await mkdir(join(cwd, "relative-source"));
  await mkdir(join(cwd, "relative-destination"));
  await writeFile(join(cwd, "relative-source", "target.txt"), "source target\n");
  await writeFile(join(cwd, "relative-destination", "target.txt"), "destination target\n");
  await symlink("target.txt", join(cwd, "relative-source", "link.txt"));
  await applyPatch(
    cwd,
    patch(
      "*** Update File: relative-source/link.txt\n",
      "*** Move to: relative-destination/link.txt\n",
      "*** Update File: relative-destination/link.txt\n",
      "@@\n-destination target\n+updated destination\n",
    ),
  );
  assert.equal(
    await readFile(join(cwd, "relative-source", "target.txt"), "utf8"),
    "source target\n",
  );
  assert.equal(
    await readFile(join(cwd, "relative-destination", "target.txt"), "utf8"),
    "updated destination\n",
  );

  await mkdir(join(cwd, "cross-relative-source"));
  await mkdir(join(cwd, "cross-relative-destination"));
  await writeFile(join(cwd, "cross-relative-source", "target.txt"), "cross source\n");
  await writeFile(join(cwd, "cross-relative-destination", "target.txt"), "cross destination\n");
  await symlink("target.txt", join(cwd, "cross-relative-source", "link.txt"));
  await applyPatch(
    cwd,
    patch(
      "*** Update File: cross-relative-source/link.txt\n",
      "*** Move to: cross-relative-destination/link.txt\n",
      "*** Update File: cross-relative-destination/link.txt\n",
      "@@\n-cross destination\n+updated cross destination\n",
    ),
    undefined,
    {
      selectMoveStrategy: (sourcePath) =>
        sourcePath.includes("cross-relative-source") ? "copy-unlink" : "rename",
    },
  );
  assert.equal(
    await readFile(join(cwd, "cross-relative-source", "target.txt"), "utf8"),
    "cross source\n",
  );
  assert.equal(
    await readFile(join(cwd, "cross-relative-destination", "target.txt"), "utf8"),
    "updated cross destination\n",
  );
});

void test("evaluates repeated paths against sequential virtual state", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "text-a.txt"), "old\n");
  await writeFile(join(cwd, "pure-a.bin"), Buffer.from([0xff]));
  await writeFile(join(cwd, "consume-a.txt"), "before\n");
  await writeFile(join(cwd, "dead-delete-a.txt"), "moved\n");
  await writeFile(join(cwd, "dead-add-a.txt"), "moved\n");
  await writeFile(join(cwd, "recreate-a.txt"), "moved\n");
  await writeFile(join(cwd, "chain-a.bin"), Buffer.from([0x00, 0xff]));
  await writeFile(join(cwd, "overwrite-a.txt"), "first\n");
  await writeFile(join(cwd, "overwrite-c.txt"), "second\n");
  await writeFile(join(cwd, "back-a.txt"), "back\n");

  await applyPatch(
    cwd,
    patch(
      "*** Update File: text-a.txt\n*** Move to: text-b.txt\n@@\n-old\n+new\n",
      "*** Delete File: text-a.txt\n",
      "*** Update File: pure-a.bin\n*** Move to: pure-b.bin\n",
      "*** Delete File: pure-a.bin\n",
      "*** Update File: consume-a.txt\n*** Move to: consume-b.txt\n",
      "*** Update File: consume-b.txt\n@@\n-before\n+after\n",
      "*** Update File: dead-delete-a.txt\n*** Move to: dead-delete-b.txt\n",
      "*** Update File: dead-delete-a.txt\n@@\n-missing\n+ignored\n",
      "*** Delete File: dead-delete-a.txt\n",
      "*** Update File: dead-add-a.txt\n*** Move to: dead-add-b.txt\n",
      "*** Update File: dead-add-a.txt\n@@\n-missing\n+ignored\n",
      "*** Add File: dead-add-a.txt\n+replacement\n",
      "*** Update File: recreate-a.txt\n*** Move to: recreate-b.txt\n",
      "*** Add File: recreate-a.txt\n+created\n",
      "*** Update File: recreate-a.txt\n@@\n-created\n+updated\n",
      "*** Update File: chain-a.bin\n*** Move to: chain-b.bin\n",
      "*** Update File: chain-b.bin\n*** Move to: chain-c.bin\n",
      "*** Update File: overwrite-a.txt\n*** Move to: overwrite-b.txt\n",
      "*** Update File: overwrite-c.txt\n*** Move to: overwrite-b.txt\n",
      "*** Update File: back-a.txt\n*** Move to: back-b.txt\n",
      "*** Update File: back-b.txt\n*** Move to: back-a.txt\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "text-b.txt"), "utf8"), "new\n");
  assert.deepEqual(await readFile(join(cwd, "pure-b.bin")), Buffer.from([0xff]));
  assert.equal(await readFile(join(cwd, "consume-b.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "dead-add-a.txt"), "utf8"), "replacement\n");
  assert.equal(await readFile(join(cwd, "recreate-a.txt"), "utf8"), "updated\n");
  assert.deepEqual(await readFile(join(cwd, "chain-c.bin")), Buffer.from([0x00, 0xff]));
  assert.equal(await readFile(join(cwd, "overwrite-b.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(cwd, "back-a.txt"), "utf8"), "back\n");
});

void test("skips a failed move only when every entry effect is safely dominated", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source.txt"), "source\n");
  await writeFile(join(cwd, "destination.txt"), "destination\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: source.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-missing\n",
      "+unknown\n",
      "*** Add File: source.txt\n+new source\n",
      "*** Add File: destination.txt\n+new destination\n",
    ),
  );

  assert.equal(details.instructions?.[0]?.status, "dead");
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "new source\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new destination\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: source.txt\n",
        "*** Move to: nested/destination.txt\n",
        "@@\n",
        "-missing\n",
        "+unknown\n",
        "*** Delete File: source.txt\n",
        "*** Delete File: nested/destination.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "new source\n");
  await assertMissing(join(cwd, "nested"));
});

void test("rejects observed unknown updates and binary text edits before any writes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "a.txt"), "source\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Add File: should-not-exist.txt\n+blocked\n",
        "*** Update File: a.txt\n*** Move to: b.txt\n",
        "*** Update File: a.txt\n@@\n-missing\n+unknown\n",
        "*** Update File: a.txt\n*** Move to: c.txt\n",
        "*** Delete File: a.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "source\n");
  await assertMissing(join(cwd, "b.txt"));
  await assertMissing(join(cwd, "should-not-exist.txt"));

  await writeFile(join(cwd, "binary.bin"), Buffer.from([0xff]));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: binary.bin\n*** Move to: moved.bin\n",
        "*** Update File: moved.bin\n@@\n+text\n",
      ),
    ),
    /encoded data was not valid/,
  );
  assert.deepEqual(await readFile(join(cwd, "binary.bin")), Buffer.from([0xff]));
  await assertMissing(join(cwd, "moved.bin"));
});

void test("keeps empty files distinct from absent paths", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "only-line.txt"), "only line\n");

  await applyPatch(cwd, patch("*** Update File: only-line.txt\n@@\n-only line\n"));
  assert.deepEqual(await readFile(join(cwd, "only-line.txt")), Buffer.alloc(0));

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: absent.txt\n@@\n-only line\n")),
    ApplyPatchVerificationError,
  );
  const dead = await applyPatch(
    cwd,
    patch("*** Update File: absent.txt\n@@\n-only line\n", "*** Delete File: absent.txt\n"),
  );
  assert.deepEqual(dead.changes, []);
  await assertMissing(join(cwd, "absent.txt"));
});
