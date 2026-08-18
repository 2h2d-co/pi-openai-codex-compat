import {
  assert,
  stat,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchSummary,
  parsePatch,
  ApplyPatchDiffComponent,
  workspace,
  patch,
  type ApplyPatchDetails,
  type FormatterMatchFailureDetails,
} from "./apply-patch-semantic-harness.ts";

test("accepts grammar-valid empty and identity updates as no-ops", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "same.txt"), "same\n");
  const before = await stat(join(cwd, "same.txt"));

  const empty = parsePatch(patch("*** Update File: missing.txt\n"));
  assert.deepEqual(empty, [{ kind: "update", path: "missing.txt", chunks: [] }]);
  const pureMove = parsePatch(patch("*** Update File: source.txt\n*** Move to: destination.txt\n"));
  assert.equal(pureMove[0]?.kind, "update");
  assert.equal(pureMove[0]?.kind === "update" ? pureMove[0].moveTo : undefined, "destination.txt");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: missing.txt\n",
      "*** Update File: also-missing.txt\n@@\n-same\n+same\n",
      "*** Update File: same.txt\n@@\n-same\n+same\n",
      "*** Add File: same.txt\n+same\n",
      "*** Delete File: absent.txt\n",
    ),
  );

  assert.deepEqual(details.changes, []);
  assert.equal(
    formatApplyPatchSummary(details),
    [
      "Success. No files were changed.",
      "",
      "Patch instruction results:",
      "1. [NO CHANGE] Update missing.txt - The instruction contains no changes.",
      "2. [NO CHANGE] Update also-missing.txt - Old and replacement content are identical.",
      "3. [NO CHANGE] Update same.txt - Old and replacement content are identical.",
      "4. [NO CHANGE] Add same.txt - The file already contains the requested content byte-for-byte.",
      "5. [NO CHANGE] Delete absent.txt - Path already absent.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    details.instructions?.map((instruction) => instruction.reason?.code),
    [
      "empty-update",
      "identity-update",
      "identity-update",
      "content-already-present",
      "path-already-absent",
    ],
  );
  const after = await stat(join(cwd, "same.txt"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("reports patch-level input and format failures once", async (t) => {
  const cwd = await workspace(t);

  await assert.rejects(applyPatch(cwd, "not a patch"), (error: unknown) => {
    assert.ok(error instanceof ApplyPatchVerificationError);
    const feedback = formatApplyPatchFailureSummary(error.details, cwd);
    const reason = "The first line of the patch must be '*** Begin Patch'";
    assert.equal(feedback.split(reason).length - 1, 1);
    assert.doesNotMatch(feedback, /Patch instruction results:/u);
    return true;
  });

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Environment ID: unavailable\n", "*** Add File: not-run.txt\n+not run\n"),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchInputError);
      assert.ok(error.details);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(
        feedback,
        /^apply_patch request rejected: apply_patch environment selection is unavailable for this turn$/mu,
      );
      assert.match(
        feedback,
        /^1\. \[NOT RUN\] Add not-run\.txt - The apply_patch request was rejected before this instruction was executed\.$/mu,
      );
      return true;
    },
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: cancelled.txt\n+cancelled\n"), controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchInputError);
      assert.ok(error.details);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /^apply_patch was cancelled before execution\.$/mu);
      assert.match(
        feedback,
        /^1\. \[NOT RUN\] Add cancelled\.txt - apply_patch was cancelled before this instruction was executed\.$/mu,
      );
      assert.doesNotMatch(feedback, /setup failed|request rejected/u);
      return true;
    },
  );
});

test("distinguishes setup failures from execution stops without an owning instruction", () => {
  const instruction = {
    index: 1,
    kind: "add" as const,
    path: "not-executed.txt",
    status: "not-run" as const,
  };
  const setup: ApplyPatchDetails = {
    status: "failed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
    instructions: [instruction],
    failure: { phase: "preflight", message: "metadata unavailable" },
    error: "metadata unavailable",
  };
  assert.equal(
    formatApplyPatchFailureSummary(setup),
    [
      "apply_patch setup failed: metadata unavailable",
      "No files were changed.",
      "",
      "Patch instruction results:",
      "1. [NOT RUN] Add not-executed.txt - apply_patch setup failed before this instruction was executed.",
      "",
    ].join("\n"),
  );

  const stopped: ApplyPatchDetails = {
    ...setup,
    failure: { phase: "execution", message: "integration callback failed" },
    error: "integration callback failed",
  };
  assert.equal(
    formatApplyPatchFailureSummary(stopped),
    [
      "apply_patch stopped before execution.",
      "Patch error: integration callback failed",
      "No files were changed.",
      "",
      "Patch instruction results:",
      "1. [NOT RUN] Add not-executed.txt - apply_patch stopped before this instruction was executed.",
      "",
    ].join("\n"),
  );
});

test("explains every no-op and dead operation to the model and TUI", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "same-content.txt"), "value\n");
  await writeFile(join(cwd, "move-source.txt"), "move\n");
  await writeFile(join(cwd, "dead-delete.txt"), "delete\n");
  await writeFile(join(cwd, "dead-add.txt"), "old\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: same-content.txt\n@@\n- value\n+value\n",
      "*** Update File: same-content.txt\n*** Move to: same-content.txt\n",
      "*** Update File: move-source.txt\n*** Move to: move-destination.txt\n",
      "*** Update File: move-source.txt\n*** Move to: move-destination.txt\n",
      "*** Update File: dead-delete.txt\n@@\n-missing\n+ignored\n",
      "*** Delete File: dead-delete.txt\n",
      "*** Update File: dead-add.txt\n@@\n-missing\n+ignored\n",
      "*** Add File: dead-add.txt\n+replacement\n",
    ),
  );

  assert.deepEqual(
    details.instructions?.map(({ status, reason }) => [status, reason?.code]),
    [
      ["no-op", "update-result-unchanged"],
      ["no-op", "same-entry-move"],
      ["applied", undefined],
      ["no-op", "move-already-fulfilled"],
      ["dead", "dead-dominated"],
      ["applied", undefined],
      ["dead", "dead-dominated"],
      ["applied", undefined],
    ],
  );
  assert.deepEqual(details.instructions?.[4]?.reason?.dominatingInstructions, [6]);
  assert.deepEqual(details.instructions?.[6]?.reason?.dominatingInstructions, [8]);

  const model = formatApplyPatchSummary(details);
  assert.match(
    model,
    /1\. \[NO CHANGE\] Update same-content\.txt - Applying the update would not change the file\./u,
  );
  assert.match(
    model,
    /4\. \[NO CHANGE\] Move move-source\.txt -> move-destination\.txt - Instruction 3 already moved this entry\./u,
  );
  assert.doesNotMatch(model, /An earlier instruction already moved this entry/u);
  assert.match(
    model,
    /5\. \[SKIPPED\] Update dead-delete\.txt - Instruction 6 determines the final filesystem state before another instruction reads it\./u,
  );
  assert.doesNotMatch(model, /[○↷→—]/u);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const collapsed = new ApplyPatchDiffComponent(details, theme, cwd, false).render(140).join("\n");
  assert.match(collapsed, /Patch instruction results:/u);
  assert.match(
    collapsed,
    /1\. \[NO CHANGE\] Update same-content\.txt — Applying the update would not change the file\./u,
  );
  assert.match(collapsed, /5\. \[SKIPPED\] Update dead-delete\.txt — Instruction 6 determines/u);
  assert.doesNotMatch(collapsed, /Proof:/u);
  const expanded = new ApplyPatchDiffComponent(details, theme, cwd, true).render(140).join("\n");
  assert.match(expanded, /5\. \[SKIPPED\] Update dead-delete\.txt — Instruction 6 determines/u);
  assert.match(expanded, /7\. \[SKIPPED\] Update dead-add\.txt — Instruction 8 determines/u);
  assert.doesNotMatch(expanded, /Proof:/u);
});

test("uses explicit filesystem metadata failure terminology", () => {
  const cwd = "/workspace";
  const details: ApplyPatchDetails = {
    status: "failed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
    instructions: [
      {
        index: 1,
        kind: "update",
        path: "metadata.txt",
        status: "failed",
        error: "Failed to inspect /workspace/metadata.txt: permission denied",
      },
    ],
    failure: {
      phase: "preflight",
      message: "Failed to inspect /workspace/metadata.txt: permission denied",
      failedInstruction: 1,
    },
  };

  assert.match(
    formatApplyPatchFailureSummary(details, cwd),
    /1\. \[FAILED\] Update metadata\.txt - Failed to read filesystem metadata for \/workspace\/metadata\.txt: permission denied\./u,
  );
});

test("gives actionable guidance for every formatter matcher failure", () => {
  const base = {
    path: "matcher.ts",
    groupCount: 2,
    candidateCount: 2,
    candidates: [{ startLine: 10, endLine: 12 }],
  };
  const cases: Array<{ matcher: FormatterMatchFailureDetails; expected: RegExp }> = [
    {
      matcher: { ...base, reason: "no-candidate", candidateCount: 0, candidates: [] },
      expected:
        /Old content was not found\. Read the current file and use apply_patch again with updated instructions if needed\./u,
    },
    {
      matcher: {
        ...base,
        reason: "no-candidate",
        candidateCount: 0,
        candidates: [],
        replacementCandidateCount: 1,
        replacementCandidates: [{ startLine: 40, endLine: 44 }],
      },
      expected:
        /Requested replacement found at lines 40-44, but old content was not found\. Inspect the reported lines and use apply_patch again with updated instructions if needed\./u,
    },
    {
      matcher: {
        ...base,
        reason: "no-ordered-mapping",
        groupIndex: 2,
        previousGroupIndex: 1,
        previousCandidates: [{ startLine: 30, endLine: 32 }],
        reverseOrdered: true,
      },
      expected:
        /The requested changes match in reverse source-file order at lines 10-12 and lines 30-32\. Use apply_patch again with the requested changes in source-file order if needed\./u,
    },
    {
      matcher: {
        ...base,
        reason: "no-ordered-mapping",
        groupIndex: 2,
        previousGroupIndex: 1,
        previousCandidates: [{ startLine: 11, endLine: 13 }],
        overlapping: true,
      },
      expected:
        /The requested changes overlap at lines 10-12 and lines 11-13\. Use apply_patch again with non-overlapping changes if needed\./u,
    },
    {
      matcher: {
        ...base,
        reason: "no-ordered-mapping",
        groupIndex: 2,
        previousGroupIndex: 1,
        previousCandidates: [{ startLine: 20, endLine: 22 }],
      },
      expected:
        /The requested changes cannot be matched in source-file order; matches were found at lines 10-12 and lines 20-22\. Use apply_patch again with the requested changes in source-file order if needed\./u,
    },
    {
      matcher: { ...base, reason: "too-many-candidates", candidateCount: 65 },
      expected:
        /65 matching locations exceed the 64-location limit\. Use apply_patch again with more specific surrounding context or smaller changes if needed\./u,
    },
    {
      matcher: { ...base, reason: "ambiguous-output" },
      expected:
        /Matching locations at lines 10-12 produce different results\. Use apply_patch again with more specific surrounding context or smaller changes if needed\./u,
    },
    {
      matcher: { ...base, reason: "mapping-limit" },
      expected:
        /More than 256 possible ways to apply the requested changes were found\. Use apply_patch again with more specific surrounding context or smaller changes if needed\./u,
    },
    {
      matcher: { ...base, reason: "overlapping-edits" },
      expected:
        /The requested changes at lines 10-12 overlap\. Use apply_patch again with non-overlapping changes if needed\./u,
    },
  ];

  for (const { matcher, expected } of cases) {
    const details: ApplyPatchDetails = {
      status: "failed",
      exact: true,
      changes: [],
      added: [],
      modified: [],
      deleted: [],
      instructions: [
        {
          index: 1,
          kind: "update",
          path: "matcher.ts",
          status: "failed",
          matcher,
          error: "matcher failure",
        },
      ],
      failure: {
        phase: "preflight",
        message: "matcher failure",
        failedInstruction: 1,
        matcher,
      },
      error: "matcher failure",
    };
    assert.match(formatApplyPatchFailureSummary(details), expected);
  }
});

test("reports every instruction to the model and TUI without a limit", async (t) => {
  const cwd = await workspace(t);
  const operations = Array.from(
    { length: 11 },
    (_, index) => `*** Delete File: absent-${index + 1}.txt\n`,
  );
  const details = await applyPatch(cwd, patch(...operations));
  const model = formatApplyPatchSummary(details);
  assert.equal((model.match(/^\d+\. \[NO CHANGE\] Delete/gmu) ?? []).length, 11);
  assert.doesNotMatch(model, /omitted|more instruction explanations/u);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const collapsed = new ApplyPatchDiffComponent(details, theme, cwd, false).render(120).join("\n");
  assert.equal((collapsed.match(/^\s*\d+\. \[NO CHANGE\] Delete/gmu) ?? []).length, 11);
  assert.doesNotMatch(collapsed, /more instruction explanations/u);
  const expanded = new ApplyPatchDiffComponent(details, theme, cwd, true).render(120).join("\n");
  assert.equal((expanded.match(/^\s*\d+\. \[NO CHANGE\] Delete/gmu) ?? []).length, 11);
  assert.doesNotMatch(expanded, /more instruction explanations/u);

  const allDead: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
    instructions: [1, 2].map((index) => ({
      index,
      kind: "update" as const,
      path: `dead-${index}.txt`,
      status: "dead" as const,
      reason: {
        code: "dead-dominated" as const,
        message: `Instruction ${index + 2} determines the final filesystem state before another instruction reads it.`,
        dominatingInstructions: [index + 2],
      },
    })),
  };
  assert.match(
    formatApplyPatchSummary(allDead),
    /1\. \[SKIPPED\] Update dead-1\.txt - Instruction 3 determines the final filesystem state before another instruction reads it\./u,
  );

  for (const count of [1, 8, 9, 100, 500]) {
    const complete: ApplyPatchDetails = {
      status: "completed",
      exact: true,
      changes: [],
      added: [],
      modified: [],
      deleted: [],
      instructions: Array.from({ length: count }, (_, offset) => ({
        index: offset + 1,
        kind: "delete" as const,
        path: `large-${offset + 1}.txt`,
        status: "no-op" as const,
        reason: {
          code: "path-already-absent" as const,
          message: "Path already absent.",
        },
      })),
    };
    assert.equal(
      (formatApplyPatchSummary(complete).match(/^\d+\. \[NO CHANGE\] Delete/gmu) ?? []).length,
      count,
    );
    assert.equal(
      (
        new ApplyPatchDiffComponent(complete, theme, cwd, false)
          .render(120)
          .join("\n")
          .match(/^\s*\d+\. \[NO CHANGE\] Delete/gmu) ?? []
      ).length,
      count,
    );
  }

  const failedInstruction = 250;
  const failedLarge: ApplyPatchDetails = {
    status: "failed",
    exact: true,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
    instructions: Array.from({ length: 500 }, (_, offset) => {
      const instruction: NonNullable<ApplyPatchDetails["instructions"]>[number] = {
        index: offset + 1,
        kind: "delete",
        path: `failed-large-${offset + 1}.txt`,
        status: offset + 1 === failedInstruction ? "failed" : "not-run",
      };
      if (offset + 1 === failedInstruction) instruction.error = "injected failure";
      return instruction;
    }),
    failure: {
      phase: "execution",
      message: "injected failure",
      failedInstruction,
    },
    error: "injected failure",
  };
  const failedModel = formatApplyPatchFailureSummary(failedLarge, cwd);
  assert.equal((failedModel.match(/^\d+\. \[(?:FAILED|NOT RUN)\] Delete/gmu) ?? []).length, 500);
  assert.doesNotMatch(failedModel, /omitted/u);
  const failedTui = new ApplyPatchDiffComponent(failedLarge, theme, cwd, false)
    .render(120)
    .join("\n");
  assert.equal((failedTui.match(/^\s*\d+\. \[(?:FAILED|NOT RUN)\] Delete/gmu) ?? []).length, 500);
  assert.doesNotMatch(failedTui, /omitted/u);
});
