import {
  assert,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchVerificationError,
  buildSemanticPlan,
  formatApplyPatchSummary,
  workspace,
  patch,
} from "./apply-patch-semantic-harness.ts";

async function hostAliasesNames(cwd: string, left: string, right: string): Promise<boolean> {
  const leftPath = join(cwd, left);
  await writeFile(leftPath, "");
  const leftMetadata = await lstat(leftPath);
  const rightMetadata = await lstat(join(cwd, right)).catch(() => undefined);
  await unlink(leftPath);
  return (
    rightMetadata !== undefined &&
    leftMetadata.dev === rightMetadata.dev &&
    leftMetadata.ino === rightMetadata.ino
  );
}

test("plans one mutation followed by no change for repeated identical adds", async (t) => {
  const cwd = await workspace(t);
  const document = patch(
    "*** Add File: repeated.txt\n+same\n",
    "*** Add File: repeated.txt\n+same\n",
  );

  const plan = await buildSemanticPlan(cwd, document);
  assert.deepEqual(
    plan.actions.map(({ kind, instructionIndex }) => ({ kind, instructionIndex })),
    [
      { kind: "add", instructionIndex: 0 },
      { kind: "no-change", instructionIndex: 1 },
    ],
  );
  assert.deepEqual(
    plan.instructions.map(({ status, reason }) => [status, reason?.code]),
    [
      ["planned", undefined],
      ["no-op", "content-already-present"],
    ],
  );

  let writeCalls = 0;
  const details = await applyPatch(cwd, document, undefined, {
    filesystem: {
      async writeFile(target, data, options) {
        writeCalls += 1;
        await writeFile(target, data, options);
      },
    },
  });

  assert.equal(writeCalls, 1);
  assert.equal(details.changes.length, 1);
  assert.deepEqual(
    details.instructions?.map(({ status, reason }) => [status, reason?.code]),
    [
      ["applied", undefined],
      ["no-op", "content-already-present"],
    ],
  );
  assert.equal(await readFile(join(cwd, "repeated.txt"), "utf8"), "same\n");
  const feedback = formatApplyPatchSummary(details, cwd);
  assert.match(feedback, /1\. \[APPLIED\] Add repeated\.txt/u);
  assert.match(
    feedback,
    /2\. \[NO CHANGE\] Add repeated\.txt - The file already contains the requested content byte-for-byte\./u,
  );
});

test("keeps a different second add as a replacement before an identical no-op", async (t) => {
  const cwd = await workspace(t);
  const document = patch(
    "*** Add File: replaced.txt\n+first\n",
    "*** Add File: replaced.txt\n+second\n",
    "*** Add File: replaced.txt\n+second\n",
  );

  const plan = await buildSemanticPlan(cwd, document);
  assert.deepEqual(
    plan.actions.map(({ kind, instructionIndex }) => ({ kind, instructionIndex })),
    [
      { kind: "add", instructionIndex: 0 },
      { kind: "add", instructionIndex: 1 },
      { kind: "no-change", instructionIndex: 2 },
    ],
  );

  const details = await applyPatch(cwd, document);
  assert.deepEqual(
    details.instructions?.map(({ status }) => status),
    ["applied", "applied", "no-op"],
  );
  assert.equal(details.changes.length, 2);
  assert.deepEqual(details.instructions?.[1]?.effects, [
    {
      kind: "replaced",
      path: "replaced.txt",
      previousEntry: { entryType: "regular-file" },
      replacementEntry: { entryType: "regular-file" },
    },
  ]);
  assert.equal(await readFile(join(cwd, "replaced.txt"), "utf8"), "second\n");
});

test("tracks exact case and Unicode names according to host alias behavior", async (t) => {
  const cwd = await workspace(t);
  const caseAliases = await hostAliasesNames(cwd, "CaseProbe", "caseprobe");
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  const unicodeAliases = await hostAliasesNames(cwd, `${composed}-probe`, `${decomposed}-probe`);

  const caseDetails = await applyPatch(
    cwd,
    patch(
      "*** Add File: Case.txt\n+same\n",
      "*** Add File: case.txt\n+same\n",
      "*** Add File: case.txt\n+same\n",
    ),
  );
  assert.deepEqual(
    caseDetails.instructions?.map(({ status }) => status),
    ["applied", "applied", "no-op"],
  );
  assert.equal(caseDetails.changes.length, 2);

  const unicodeDetails = await applyPatch(
    cwd,
    patch(
      `*** Add File: ${composed}.txt\n+same\n`,
      `*** Add File: ${decomposed}.txt\n+same\n`,
      `*** Add File: ${decomposed}.txt\n+same\n`,
    ),
  );
  assert.deepEqual(
    unicodeDetails.instructions?.map(({ status }) => status),
    ["applied", "applied", "no-op"],
  );
  assert.equal(unicodeDetails.changes.length, 2);

  await writeFile(join(cwd, "Existing.txt"), "same\n");
  const existingDetails = await applyPatch(
    cwd,
    patch("*** Add File: existing.txt\n+same\n", "*** Add File: existing.txt\n+same\n"),
  );
  assert.deepEqual(
    existingDetails.instructions?.map(({ status }) => status),
    ["applied", "no-op"],
  );

  const names = await readdir(cwd);
  assert.ok(names.includes("case.txt"));
  assert.ok(names.includes(`${decomposed}.txt`));
  assert.ok(names.includes("existing.txt"));
  assert.equal(names.includes("Case.txt"), !caseAliases);
  assert.equal(names.includes(`${composed}.txt`), !unicodeAliases);
  assert.equal(names.includes("Existing.txt"), !caseAliases);

  if (caseAliases) {
    await writeFile(join(cwd, "Updated.txt"), "before\n");
    const updatedDetails = await applyPatch(
      cwd,
      patch(
        "*** Update File: updated.txt\n@@\n-before\n+after\n",
        "*** Add File: updated.txt\n+after\n",
        "*** Add File: updated.txt\n+after\n",
      ),
    );
    assert.deepEqual(
      updatedDetails.instructions?.map(({ status }) => status),
      ["applied", "applied", "no-op"],
    );
    const updatedNames = await readdir(cwd);
    assert.ok(updatedNames.includes("updated.txt"));
    assert.ok(!updatedNames.includes("Updated.txt"));
  }
});

test("uses actual entry spelling for dead proofs and fulfilled same-entry moves", async (t) => {
  const cwd = await workspace(t);
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  const aliases = [
    {
      actual: "Proof.txt",
      alias: "proof.txt",
      supported: await hostAliasesNames(cwd, "CaseProof", "caseproof"),
    },
    {
      actual: `Proof-${composed}.txt`,
      alias: `Proof-${decomposed}.txt`,
      supported: await hostAliasesNames(
        cwd,
        `Unicode-${composed}-proof`,
        `Unicode-${decomposed}-proof`,
      ),
    },
  ].filter(({ supported }) => supported);
  if (aliases.length === 0) {
    t.skip("host filesystem does not alias case or Unicode-normalized names");
    return;
  }

  for (const [index, names] of aliases.entries()) {
    const actual = `${index}-${names.actual}`;
    const alias = `${index}-${names.alias}`;
    await writeFile(join(cwd, actual), "before\n");
    await assert.rejects(
      applyPatch(
        cwd,
        patch(
          `*** Update File: ${alias}\n@@\n-missing\n+after\n`,
          `*** Add File: ${actual}\n+before\n`,
        ),
      ),
      ApplyPatchVerificationError,
    );
    assert.equal(await readFile(join(cwd, actual), "utf8"), "before\n");

    const moveActual = `move-${actual}`;
    const moveAlias = `move-${alias}`;
    await writeFile(join(cwd, moveActual), "moved\n");
    const details = await applyPatch(
      cwd,
      patch(`*** Update File: ${moveAlias}\n*** Move to: ${moveActual}\n`),
    );
    assert.deepEqual(
      details.instructions?.map(({ status, reason }) => [status, reason?.code]),
      [["no-op", "same-entry-move"]],
    );
    assert.deepEqual(details.changes, []);
    assert.equal(await readFile(join(cwd, moveActual), "utf8"), "moved\n");
  }
});

test("uses virtual spelling through symlink-parent aliases and earlier moves", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));

  const aliasDocument = patch(
    "*** Add File: real/shared.txt\n+same\n",
    "*** Add File: alias/shared.txt\n+same\n",
  );
  const aliasPlan = await buildSemanticPlan(cwd, aliasDocument);
  assert.deepEqual(
    aliasPlan.actions.map(({ kind, instructionIndex }) => ({ kind, instructionIndex })),
    [
      { kind: "add", instructionIndex: 0 },
      { kind: "no-change", instructionIndex: 1 },
    ],
  );
  const aliasDetails = await applyPatch(cwd, aliasDocument);
  assert.deepEqual(
    aliasDetails.instructions?.map(({ status }) => status),
    ["applied", "no-op"],
  );
  assert.equal(await readFile(join(cwd, "real", "shared.txt"), "utf8"), "same\n");

  await writeFile(join(cwd, "move-source.txt"), "moved\n");
  const moveDocument = patch(
    "*** Update File: move-source.txt\n*** Move to: move-destination.txt\n",
    "*** Add File: move-destination.txt\n+moved\n",
  );
  const movePlan = await buildSemanticPlan(cwd, moveDocument);
  assert.deepEqual(
    movePlan.actions.map(({ kind, instructionIndex }) => ({ kind, instructionIndex })),
    [
      { kind: "move", instructionIndex: 0 },
      { kind: "no-change", instructionIndex: 1 },
    ],
  );
  const moveDetails = await applyPatch(cwd, moveDocument);
  assert.deepEqual(
    moveDetails.instructions?.map(({ status }) => status),
    ["applied", "no-op"],
  );
  assert.equal(moveDetails.changes[0]?.kind, "move");
  assert.equal(await readFile(join(cwd, "move-destination.txt"), "utf8"), "moved\n");
});
