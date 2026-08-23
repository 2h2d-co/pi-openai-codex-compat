import { Value } from "typebox/value";
import { APPLY_PATCH_DETAILS_SCHEMA } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-details-schema.ts";
import {
  assert,
  writeFileSync,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchRenderText,
  workspace,
  assertMissing,
  isFileHandle,
  patch,
} from "./apply-patch-semantic-harness.ts";

test(
  "establishes exact case-only spellings without mutating collateral hard links",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async (t) => {
    const cwd = await workspace(t);
    await writeFile(join(cwd, "Pure.txt"), "pure\n");
    await writeFile(join(cwd, "State.txt"), "before\n");
    await link(join(cwd, "State.txt"), join(cwd, "state-hardlink.txt"));
    await writeFile(join(cwd, "Add.txt"), "before add\n");

    await applyPatch(
      cwd,
      patch(
        "*** Update File: Pure.txt\n*** Move to: pure.txt\n",
        "*** Update File: Pure.txt\n*** Move to: pure.txt\n",
        "*** Update File: State.txt\n",
        "*** Move to: state.txt\n",
        "@@\n",
        "-before\n",
        "+after\n",
        "*** Add File: add.txt\n+after add\n",
      ),
    );

    const names = await readdir(cwd);
    assert.ok(names.includes("pure.txt"));
    assert.ok(names.includes("state.txt"));
    assert.ok(names.includes("add.txt"));
    assert.ok(!names.includes("Pure.txt"));
    assert.ok(!names.includes("State.txt"));
    assert.ok(!names.includes("Add.txt"));
    assert.equal(await readFile(join(cwd, "pure.txt"), "utf8"), "pure\n");
    assert.equal(await readFile(join(cwd, "state.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(cwd, "state-hardlink.txt"), "utf8"), "before\n");
    assert.equal(await readFile(join(cwd, "add.txt"), "utf8"), "after add\n");
  },
);

test(
  "establishes exact Unicode-normalization-only spellings",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const cwd = await workspace(t);
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    await writeFile(join(cwd, `pure-${composed}.txt`), "pure\n");
    await writeFile(join(cwd, `state-${composed}.txt`), "before\n");
    await writeFile(join(cwd, `add-${composed}.txt`), "same\n");

    await applyPatch(
      cwd,
      patch(
        `*** Update File: pure-${composed}.txt\n*** Move to: pure-${decomposed}.txt\n`,
        `*** Update File: state-${composed}.txt\n`,
        `*** Move to: state-${decomposed}.txt\n`,
        "@@\n",
        "-before\n",
        "+after\n",
        `*** Add File: add-${decomposed}.txt\n`,
        "+same\n",
      ),
    );

    const names = await readdir(cwd);
    assert.ok(names.includes(`pure-${decomposed}.txt`));
    assert.ok(names.includes(`state-${decomposed}.txt`));
    assert.ok(names.includes(`add-${decomposed}.txt`));
    assert.ok(!names.includes(`pure-${composed}.txt`));
    assert.ok(!names.includes(`state-${composed}.txt`));
    assert.ok(!names.includes(`add-${composed}.txt`));
    assert.equal(await readFile(join(cwd, `pure-${decomposed}.txt`), "utf8"), "pure\n");
    assert.equal(await readFile(join(cwd, `state-${decomposed}.txt`), "utf8"), "after\n");
    assert.equal(await readFile(join(cwd, `add-${decomposed}.txt`), "utf8"), "same\n");
  },
);

test("rejects directories and unproven missing-source moves", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "directory"));
  await writeFile(join(cwd, "destination.txt"), "unrelated\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: directory\n*** Move to: moved-directory\n")),
    /source is a directory/,
  );
  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: missing.txt\n*** Move to: destination.txt\n")),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.match(error.message, /source does not exist, and no earlier instruction moved it to/u);
      assert.match(
        formatApplyPatchFailureSummary(error.details, cwd),
        /1\. \[FAILED\] Move missing\.txt -> destination\.txt - Validation failed: The move source does not exist, and no earlier instruction moved it to the destination\./u,
      );
      return true;
    },
  );
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: directory\n+blocked\n")),
    /path is a directory/,
  );
  await assert.rejects(
    applyPatch(cwd, patch("*** Delete File: directory\n")),
    /path is a directory/,
  );
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: destination.txt\n",
        "*** Move to: directory\n",
        "@@\n",
        "-unrelated\n",
        "+blocked\n",
      ),
    ),
    /destination is a directory/,
  );
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "unrelated\n");
});

test("detects external drift after preflight and before mutation", async (t) => {
  const cwd = await workspace(t);
  const sourcePath = join(cwd, "source.txt");
  await writeFile(sourcePath, "before\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: source.txt\n*** Move to: destination.txt\n"),
      undefined,
      {
        onExecutionStart() {
          writeFileSync(sourcePath, "external change\n");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.deepEqual(error.details.changes, []);
      return true;
    },
  );
  assert.equal(await readFile(sourcePath, "utf8"), "external change\n");
  await assertMissing(join(cwd, "destination.txt"));
});

test("detects external changes to text content and planned parent paths", async (t) => {
  const cwd = await workspace(t);
  const textPath = join(cwd, "text.txt");
  await writeFile(textPath, "before\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: text.txt\n@@\n-before\n+after\n"), undefined, {
      onExecutionStart() {
        writeFileSync(textPath, "same-size\n");
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(textPath, "utf8"), "same-size\n");

  await writeFile(join(cwd, "parent-source.txt"), "source\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: parent-source.txt\n*** Move to: missing-parent/destination.txt\n"),
      undefined,
      {
        onExecutionStart() {
          writeFileSync(join(cwd, "missing-parent"), "external file\n");
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(join(cwd, "parent-source.txt"), "utf8"), "source\n");
  assert.equal(await readFile(join(cwd, "missing-parent"), "utf8"), "external file\n");
});

test("rejects byte-identical inode and hard-link topology drift before writing", async (t) => {
  const cwd = await workspace(t);
  const replacementPath = join(cwd, "replacement.txt");
  const replacementBackupPath = join(cwd, "replacement-backup.txt");
  await writeFile(replacementPath, "before\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: replacement.txt\n@@\n-before\n+after\n"), undefined, {
      async onExecutionStart() {
        await rename(replacementPath, replacementBackupPath);
        await writeFile(replacementPath, "before\n");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.deepEqual(error.details.changes, []);
      return true;
    },
  );
  assert.equal(await readFile(replacementPath, "utf8"), "before\n");
  assert.equal(await readFile(replacementBackupPath, "utf8"), "before\n");

  const hardLinkPath = join(cwd, "hard-link-source.txt");
  const originalHardLinkPath = join(cwd, "hard-link-original.txt");
  const collateralPath = join(cwd, "hard-link-collateral.txt");
  await writeFile(hardLinkPath, "before\n");
  await writeFile(collateralPath, "before\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: hard-link-source.txt\n@@\n-before\n+after\n"),
      undefined,
      {
        async onExecutionStart() {
          await rename(hardLinkPath, originalHardLinkPath);
          await link(collateralPath, hardLinkPath);
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(hardLinkPath, "utf8"), "before\n");
  assert.equal(await readFile(originalHardLinkPath, "utf8"), "before\n");
  assert.equal(await readFile(collateralPath, "utf8"), "before\n");

  const addedLinkSourcePath = join(cwd, "added-link-source.txt");
  const addedLinkCollateralPath = join(cwd, "added-link-collateral.txt");
  await writeFile(addedLinkSourcePath, "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: added-link-source.txt\n@@\n-before\n+after\n"),
      undefined,
      {
        async onExecutionStart() {
          await link(addedLinkSourcePath, addedLinkCollateralPath);
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(addedLinkSourcePath, "utf8"), "before\n");
  assert.equal(await readFile(addedLinkCollateralPath, "utf8"), "before\n");
});

test("rejects replaced ancestor, source-symlink, and symlink-target routes", async (t) => {
  const cwd = await workspace(t);
  const parentPath = join(cwd, "route-parent");
  const originalParentPath = join(cwd, "route-parent-original");
  const alternateParentPath = join(cwd, "route-parent-alternate");
  await mkdir(parentPath);
  await mkdir(alternateParentPath);
  await writeFile(join(parentPath, "source.txt"), "before\n");
  await link(join(parentPath, "source.txt"), join(alternateParentPath, "source.txt"));

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: route-parent/source.txt\n@@\n-before\n+after\n"),
      undefined,
      {
        async onExecutionStart() {
          await rename(parentPath, originalParentPath);
          await symlink("route-parent-alternate", parentPath);
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(join(originalParentPath, "source.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(alternateParentPath, "source.txt"), "utf8"), "before\n");

  const targetPath = join(cwd, "route-target.txt");
  const sourceLinkPath = join(cwd, "route-source-link.txt");
  const originalSourceLinkPath = join(cwd, "route-source-link-original.txt");
  await writeFile(targetPath, "before\n");
  await symlink("route-target.txt", sourceLinkPath);
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: route-source-link.txt\n@@\n-before\n+after\n"),
      undefined,
      {
        async onExecutionStart() {
          await rename(sourceLinkPath, originalSourceLinkPath);
          await symlink("route-target.txt", sourceLinkPath);
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(targetPath, "utf8"), "before\n");

  const replacedTargetPath = join(cwd, "replaced-route-target.txt");
  const originalTargetPath = join(cwd, "replaced-route-target-original.txt");
  const targetLinkPath = join(cwd, "replaced-route-link.txt");
  await writeFile(replacedTargetPath, "before\n");
  await symlink("replaced-route-target.txt", targetLinkPath);
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: replaced-route-link.txt\n@@\n-before\n+after\n"),
      undefined,
      {
        async onExecutionStart() {
          await rename(replacedTargetPath, originalTargetPath);
          await writeFile(replacedTargetPath, "before\n");
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(replacedTargetPath, "utf8"), "before\n");
  assert.equal(await readFile(originalTargetPath, "utf8"), "before\n");
});

test("binds an in-place write to the validated inode across a final pathname swap", async (t) => {
  const cwd = await workspace(t);
  const sourcePath = join(cwd, "bound-source.txt");
  const originalPath = join(cwd, "bound-original.txt");
  const collateralPath = join(cwd, "bound-collateral.txt");
  await writeFile(sourcePath, "before\n");
  await writeFile(collateralPath, "before\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: bound-source.txt\n@@\n-before\n+after\n"), undefined, {
      filesystem: {
        async writeFile(target, data, options) {
          if (isFileHandle(target)) {
            await rename(sourcePath, originalPath);
            await link(collateralPath, sourcePath);
          }
          await writeFile(target, data, options);
        },
      },
    }),
    ApplyPatchExecutionError,
  );

  assert.equal(await readFile(originalPath, "utf8"), "after\n");
  assert.equal(await readFile(sourcePath, "utf8"), "before\n");
  assert.equal(await readFile(collateralPath, "utf8"), "before\n");
});

test("updates a file created with planned parents using its committed identity", async (t) => {
  const cwd = await workspace(t);
  await applyPatch(
    cwd,
    patch(
      "*** Add File: planned-parent/source.txt\n+before\n",
      "*** Update File: planned-parent/source.txt\n@@\n-before\n+after\n",
    ),
  );
  assert.equal(await readFile(join(cwd, "planned-parent", "source.txt"), "utf8"), "after\n");
});

test("renders opaque moves as path-only structured history", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0xff, 0x00]));
  await writeFile(join(cwd, "old-target.bin"), Buffer.from([0x01]));

  const details = await applyPatch(
    cwd,
    patch("*** Update File: binary.bin\n*** Move to: old-target.bin\n"),
  );
  const move = details.changes[0];
  assert.equal(move?.kind, "move");
  if (move?.kind === "move") {
    assert.equal(move.replacedDestination, true);
    assert.equal(move.exact, true);
    assert.equal("oldContent" in move, false);
    assert.equal("newContent" in move, false);
  }

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  assert.ok(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, details));
  const rendered = formatApplyPatchRenderText(details, theme, cwd);
  assert.match(
    rendered,
    /• Moved binary\.bin → old-target\.bin \(replaced destination\) \(\+0 -0\)/,
  );
  assert.doesNotMatch(rendered, /\ufffd/);
});
