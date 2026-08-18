import {
  assert,
  writeFileSync,
  link,
  mkdir,
  readFile,
  readdir,
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
  isApplyPatchDetails,
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
  assert.ok(isApplyPatchDetails(details));
  const rendered = formatApplyPatchRenderText(details, theme, cwd);
  assert.match(
    rendered,
    /• Moved binary\.bin → old-target\.bin \(replaced destination\) \(\+0 -0\)/,
  );
  assert.doesNotMatch(rendered, /\ufffd/);
});
