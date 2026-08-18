import {
  assert,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  basename,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  formatApplyPatchFailureSummary,
  previewPatch,
  ApplyPatchDiffComponent,
  formatApplyPatchRenderText,
  workspace,
  assertMissing,
  patch,
  filesystemError,
  pathLikeBasename,
} from "./apply-patch-semantic-harness.ts";

void test(
  "plans cross-filesystem hard-link moves with independent destination identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await workspace(t);
    if ((await stat(cwd)).dev === (await stat("/dev")).dev) {
      t.skip("a distinct local filesystem is required");
      return;
    }

    await writeFile(join(cwd, "source-a.txt"), "before\n");
    await link(join(cwd, "source-a.txt"), join(cwd, "source-b.txt"));
    const destination = join("/dev", `pi-cross-preview-${basename(cwd)}`);
    await assertMissing(destination);

    const independent = await previewPatch(
      cwd,
      patch(
        `*** Update File: source-a.txt\n*** Move to: ${destination}\n`,
        `*** Update File: ${destination}\n@@\n-before\n+destination\n`,
        "*** Update File: source-b.txt\n@@\n-before\n+remaining\n",
      ),
    );
    assert.deepEqual(
      independent.instructions?.map(({ status }) => status),
      ["planned", "planned", "planned"],
    );

    await writeFile(join(cwd, "dead-a.txt"), "before\n");
    await link(join(cwd, "dead-a.txt"), join(cwd, "dead-b.txt"));
    const deadDestination = join("/dev", `pi-cross-dead-preview-${basename(cwd)}`);
    await assertMissing(deadDestination);
    const deadAfterCrossDeviceMove = await previewPatch(
      cwd,
      patch(
        `*** Update File: dead-a.txt\n*** Move to: ${deadDestination}\n`,
        "*** Update File: dead-b.txt\n@@\n-missing\n+after\n",
        "*** Delete File: dead-b.txt\n",
      ),
    );
    assert.deepEqual(
      deadAfterCrossDeviceMove.instructions?.map(({ status }) => status),
      ["planned", "dead", "planned"],
    );
  },
);

void test("executes planned move strategies and reports every injected failure prefix", async (t) => {
  const cwd = await workspace(t);

  await writeFile(join(cwd, "forced-a.txt"), "before\n");
  await link(join(cwd, "forced-a.txt"), join(cwd, "forced-b.txt"));
  const forced = await applyPatch(
    cwd,
    patch(
      "*** Update File: forced-a.txt\n*** Move to: forced-z.txt\n",
      "*** Update File: forced-z.txt\n@@\n-before\n+destination\n",
      "*** Update File: forced-b.txt\n@@\n-before\n+remaining\n",
    ),
    undefined,
    {
      selectMoveStrategy: () => "copy-unlink",
    },
  );
  assert.equal(forced.exact, true);
  assert.equal(await readFile(join(cwd, "forced-z.txt"), "utf8"), "destination\n");
  assert.equal(await readFile(join(cwd, "forced-b.txt"), "utf8"), "remaining\n");
  assert.notEqual(
    (await stat(join(cwd, "forced-z.txt"))).ino,
    (await stat(join(cwd, "forced-b.txt"))).ino,
  );

  await writeFile(join(cwd, "cross-chain-source.txt"), "chain\n");
  const crossChain = await applyPatch(
    cwd,
    patch(
      "*** Update File: cross-chain-source.txt\n*** Move to: cross-chain-middle.txt\n",
      "*** Update File: cross-chain-middle.txt\n*** Move to: cross-chain-final.txt\n",
      "*** Delete File: cross-chain-final.txt\n",
    ),
    undefined,
    {
      selectMoveStrategy: () => "copy-unlink",
    },
  );
  assert.deepEqual(
    crossChain.instructions?.map(({ status }) => status),
    ["applied", "applied", "applied"],
  );
  await assertMissing(join(cwd, "cross-chain-source.txt"));
  await assertMissing(join(cwd, "cross-chain-middle.txt"));
  await assertMissing(join(cwd, "cross-chain-final.txt"));

  await writeFile(join(cwd, "native-source.txt"), "native\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: native-source.txt\n*** Move to: native-destination.txt\n"),
      undefined,
      {
        filesystem: {
          async rename(source, destination) {
            if (
              source === join(cwd, "native-source.txt") &&
              destination === join(cwd, "native-destination.txt")
            ) {
              throw filesystemError("EXDEV", "injected unexpected cross-device rename");
            }
            await rename(source, destination);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.exact, true);
      assert.equal(error.details.changes.length, 0);
      assert.equal(error.details.failure?.failedInstruction, 1);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["failed"],
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "native-source.txt"), "utf8"), "native\n");
  await assertMissing(join(cwd, "native-destination.txt"));

  await writeFile(join(cwd, "copied-source.txt"), "copied\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: copied-source.txt\n*** Move to: copied-destination.txt\n"),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "copied-source.txt")) {
              throw filesystemError("EACCES", "injected source unlink failure");
            }
            await unlink(path);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.exact, false);
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.changes[0]?.kind, "move");
      assert.equal(
        error.details.changes[0]?.kind === "move" ? error.details.changes[0].exact : undefined,
        false,
      );
      assert.equal(error.details.failure?.failedInstruction, 1);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Patch failed at instruction 1 of 1\./u);
      assert.match(feedback, /Files changed:\nA copied-destination\.txt/u);
      assert.match(
        feedback,
        /1\. \[FAILED\] Move copied-source\.txt -> copied-destination\.txt - Created copied-destination\.txt; copied-source\.txt remains; Move failed: injected source unlink failure\./u,
      );
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const tui = new ApplyPatchDiffComponent(error.details, theme, cwd, true)
        .render(120)
        .join("\n");
      assert.match(tui, /A copied-destination\.txt/u);
      assert.match(tui, /Created copied-destination\.txt/u);
      assert.doesNotMatch(tui, /Moved copied-source\.txt/u);
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "copied-source.txt"), "utf8"), "copied\n");
  assert.equal(await readFile(join(cwd, "copied-destination.txt"), "utf8"), "copied\n");

  await writeFile(join(cwd, "replaced-source.txt"), "replacement\n");
  await writeFile(join(cwd, "replaced-destination.txt"), "old destination\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: replaced-source.txt\n*** Move to: replaced-destination.txt\n"),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "replaced-source.txt")) {
              throw filesystemError("EACCES", "injected replacement source unlink failure");
            }
            await unlink(path);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Files changed:\nM replaced-destination\.txt/u);
      assert.match(
        feedback,
        /replaced-destination\.txt is still a regular file; replaced-source\.txt remains/u,
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "replaced-source.txt"), "utf8"), "replacement\n");
  assert.equal(await readFile(join(cwd, "replaced-destination.txt"), "utf8"), "replacement\n");

  await writeFile(join(cwd, "unverified-move-source.txt"), "source\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: unverified-move-source.txt\n",
        "*** Move to: unverified-move-destination.txt\n",
      ),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "unverified-move-source.txt")) {
              throw filesystemError("EACCES", "injected source unlink failure");
            }
            await unlink(path);
          },
          async lstat(path) {
            if (path === join(cwd, "unverified-move-destination.txt")) {
              throw filesystemError("EIO", "injected final-state inspection failure");
            }
            return lstat(path);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Files changed:\nA unverified-move-destination\.txt/u);
      assert.match(
        feedback,
        /Created unverified-move-destination\.txt; unverified-move-source\.txt remains/u,
      );
      assert.match(feedback, /Final state not verified for unverified-move-destination\.txt\./u);
      assert.doesNotMatch(feedback, /No files were changed\./u);
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "unverified-move-destination.txt"), "utf8"), "source\n");

  await writeFile(join(cwd, "text-move-source.txt"), "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: text-move-source.txt\n",
        "*** Move to: text-move-destination.txt\n",
        "@@\n-before\n+after\n",
      ),
      undefined,
      {
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "text-move-source.txt")) {
              throw filesystemError("EACCES", "injected text-move source unlink failure");
            }
            await unlink(path);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.exact, false);
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.changes[0]?.kind, "add");
      assert.equal(error.details.failure?.failedInstruction, 1);
      assert.match(error.message, /Failed to remove original/u);
      assert.match(
        formatApplyPatchFailureSummary(error.details, cwd),
        /1\. \[FAILED\] Update & Move text-move-source\.txt -> text-move-destination\.txt - Created text-move-destination\.txt; text-move-source\.txt remains; The updated content was written to the destination, but removing the source failed: injected text-move source unlink failure; The file at text-move-destination\.txt contains the requested content byte-for-byte despite the reported error\./u,
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "text-move-source.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "text-move-destination.txt"), "utf8"), "after\n");

  await writeFile(join(cwd, "removed-source.txt"), "source\n");
  await writeFile(join(cwd, "removed-destination.txt"), "destination\n");
  let failedReplacementAttempts = 0;
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Add File: committed-prefix.txt\n+committed\n",
        "*** Update File: removed-source.txt\n*** Move to: removed-destination.txt\n",
        "*** Add File: not-run.txt\n+not run\n",
      ),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async rename(source, destination) {
            if (
              destination === join(cwd, "removed-destination.txt") &&
              basename(String(source)).includes(".apply-patch-")
            ) {
              failedReplacementAttempts += 1;
              if (failedReplacementAttempts === 1) {
                throw filesystemError("EEXIST", "injected Windows replacement conflict");
              }
              throw filesystemError("EIO", "injected destination replacement failure");
            }
            await rename(source, destination);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.exact, false);
      assert.equal(error.details.changes.length, 1);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["applied", "failed", "not-run"],
      );
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.match(error.message, /destination was removed before replacement failed/u);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(
        feedback,
        /Files changed:\nA committed-prefix\.txt\nD removed-destination\.txt/u,
      );
      assert.match(
        feedback,
        /2\. \[FAILED\] Move removed-source\.txt -> removed-destination\.txt - Deleted removed-destination\.txt; removed-source\.txt remains; Move failed: injected destination replacement failure\./u,
      );
      assert.match(feedback, /3\. \[NOT RUN\] Add not-run\.txt - Instruction 2 failed\./u);
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "committed-prefix.txt"), "utf8"), "committed\n");
  assert.equal(await readFile(join(cwd, "removed-source.txt"), "utf8"), "source\n");
  await assertMissing(join(cwd, "removed-destination.txt"));
  await assertMissing(join(cwd, "not-run.txt"));

  await writeFile(join(cwd, "windows-source.txt"), "source\n");
  await writeFile(join(cwd, "windows-destination.txt"), "old destination\n");
  let windowsReplacementAttempts = 0;
  const windowsReplacement = await applyPatch(
    cwd,
    patch("*** Update File: windows-source.txt\n*** Move to: windows-destination.txt\n"),
    undefined,
    {
      selectMoveStrategy: () => "copy-unlink",
      filesystem: {
        async rename(source, destination) {
          if (
            destination === join(cwd, "windows-destination.txt") &&
            basename(String(source)).includes(".apply-patch-")
          ) {
            windowsReplacementAttempts += 1;
            if (windowsReplacementAttempts === 1) {
              throw filesystemError("EPERM", "injected Windows rename-over-existing behavior");
            }
          }
          await rename(source, destination);
        },
      },
    },
  );
  assert.equal(windowsReplacement.exact, true);
  assert.equal(windowsReplacementAttempts, 2);
  await assertMissing(join(cwd, "windows-source.txt"));
  assert.equal(await readFile(join(cwd, "windows-destination.txt"), "utf8"), "source\n");
});

void test("reports deterministic file states after write failures", async (t) => {
  const cwd = await workspace(t);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const cases = [
    {
      name: "unchanged",
      before: "before\n",
      mutate: false,
      mutation: "",
      summary: /No files were changed\./u,
      result: /Write failed: injected unchanged write failure; unchanged\.txt is unchanged\./u,
    },
    {
      name: "requested",
      before: "before\n",
      mutate: true,
      mutation: "requested\n",
      summary: /Files changed:\nM requested\.txt/u,
      result:
        /Write failed: injected requested write failure; The file at requested\.txt contains the requested content byte-for-byte despite the reported error\./u,
    },
    {
      name: "different",
      before: "before\n",
      mutate: true,
      mutation: "different\n",
      summary: /Files changed:\nM different\.txt/u,
      result:
        /Write failed: injected different write failure; The content at different\.txt matches neither the requested content nor the previously observed content\./u,
    },
  ] as const;

  for (const fixture of cases) {
    const path = join(cwd, `${fixture.name}.txt`);
    await writeFile(path, fixture.before);
    await assert.rejects(
      applyPatch(
        cwd,
        patch(`*** Update File: ${fixture.name}.txt\n@@\n-before\n+requested\n`),
        undefined,
        {
          filesystem: {
            async writeFile(target, data, options) {
              if (target === path) {
                if (fixture.mutate) await writeFile(target, fixture.mutation, options);
                throw filesystemError("EIO", `injected ${fixture.name} write failure`);
              }
              await writeFile(target, data, options);
            },
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApplyPatchExecutionError);
        const feedback = formatApplyPatchFailureSummary(error.details, cwd);
        assert.match(feedback, fixture.summary);
        assert.match(feedback, fixture.result);
        const tui = formatApplyPatchRenderText(error.details, theme, cwd);
        assert.match(tui, fixture.result);
        if (fixture.name === "unchanged") assert.match(tui, /No files were changed\./u);
        else assert.match(tui, /Changed 1 file/u);
        assert.doesNotMatch(
          feedback,
          /Committed prefix|exact|inexact|might|possibly|probably|likely/u,
        );
        return true;
      },
    );
  }

  const unverifiedPath = join(cwd, "unverified.txt");
  await writeFile(unverifiedPath, "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: unverified.txt\n@@\n-before\n+requested\n"),
      undefined,
      {
        filesystem: {
          async writeFile(target, data, options) {
            if (target === unverifiedPath) {
              await writeFile(target, data, options);
              throw filesystemError("EIO", "injected unverified write failure");
            }
            await writeFile(target, data, options);
          },
          async readFile(target) {
            if (target === unverifiedPath) {
              throw filesystemError("EIO", "injected final-state read failure");
            }
            return readFile(target);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.doesNotMatch(feedback, /No files were changed\./u);
      assert.match(
        feedback,
        /Write failed: injected unverified write failure; Final state not verified for unverified\.txt\./u,
      );
      const tui = formatApplyPatchRenderText(error.details, theme, cwd);
      assert.doesNotMatch(tui, /No files were changed\./u);
      assert.match(tui, /Final state not verified for unverified\.txt\./u);
      return true;
    },
  );

  const changedEntryPath = join(cwd, "changed-entry.txt");
  const replacementEntryPath = join(cwd, "changed-entry-replacement.txt");
  await writeFile(changedEntryPath, "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: changed-entry.txt\n@@\n-before\n+requested\n"),
      undefined,
      {
        filesystem: {
          async writeFile(path, data, options) {
            if (path === changedEntryPath) {
              await writeFile(replacementEntryPath, "before\n");
              await rename(replacementEntryPath, path);
              throw filesystemError("EIO", "injected same-content entry replacement");
            }
            await writeFile(path, data, options);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Files changed:\nM changed-entry\.txt/u);
      assert.match(
        feedback,
        /Write failed: injected same-content entry replacement; changed-entry\.txt is a different filesystem entry\./u,
      );
      return true;
    },
  );

  const changedTypePath = join(cwd, "changed-type.txt");
  await writeFile(changedTypePath, "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: changed-type.txt\n@@\n-before\n+requested\n"),
      undefined,
      {
        filesystem: {
          async writeFile(path, data, options) {
            if (path === changedTypePath) {
              await unlink(path);
              await mkdir(path);
              throw filesystemError("EIO", "injected entry-type write failure");
            }
            await writeFile(path, data, options);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Files changed:\nM changed-type\.txt/u);
      assert.match(
        feedback,
        /Write failed: injected entry-type write failure; Entry type changed for changed-type\.txt\./u,
      );
      assert.doesNotMatch(feedback, /No files were changed\./u);
      return true;
    },
  );
});

void test("reports parent, temporary, and post-operation failure effects", async (t) => {
  const cwd = await workspace(t);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: created-parent/file.txt\n+content\n"), undefined, {
      filesystem: {
        async writeFile(path, data, options) {
          if (pathLikeBasename(path).includes(".file.txt.apply-patch-")) {
            throw filesystemError("EIO", "injected write failure after parent creation");
          }
          await writeFile(path, data, options);
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /^Filesystem changed\.$/mu);
      assert.match(feedback, /Created directory created-parent/u);
      assert.doesNotMatch(feedback, /No files were changed\./u);
      const tui = formatApplyPatchRenderText(error.details, theme, cwd);
      assert.match(tui, /Filesystem changed\./u);
      assert.match(tui, /Created directory created-parent/u);
      return true;
    },
  );

  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: temporary.txt\n+content\n"), undefined, {
      filesystem: {
        async writeFile(path, data, options) {
          if (pathLikeBasename(path).includes(".temporary.txt.apply-patch-")) {
            await writeFile(path, data, options);
            throw filesystemError("EIO", "injected temporary write failure");
          }
          await writeFile(path, data, options);
        },
        async unlink(path) {
          if (pathLikeBasename(path).includes(".temporary.txt.apply-patch-")) {
            throw filesystemError("EACCES", "injected temporary cleanup failure");
          }
          await unlink(path);
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /^Filesystem changed\.$/mu);
      assert.match(feedback, /Temporary entry remains at \.temporary\.txt\.apply-patch-/u);
      assert.doesNotMatch(feedback, /No files were changed\./u);
      return true;
    },
  );

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Add File: planned-delete.txt\n+content\n",
        "*** Delete File: planned-delete.txt\n",
      ),
      undefined,
      {
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "planned-delete.txt")) {
              throw filesystemError("EACCES", "injected planned delete failure");
            }
            await unlink(path);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(feedback, /Files changed:\nA planned-delete\.txt/u);
      assert.match(
        feedback,
        /2\. \[FAILED\] Delete planned-delete\.txt - Delete failed: injected planned delete failure; planned-delete\.txt is unchanged\./u,
      );
      assert.doesNotMatch(feedback, /Replaced planned-delete\.txt/u);
      return true;
    },
  );

  const postOperationSource = join(cwd, "post-operation-source.txt");
  const postOperationDestination = join(cwd, "post-operation-destination.txt");
  await writeFile(postOperationSource, "before\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: post-operation-source.txt\n",
        "*** Move to: post-operation-destination.txt\n",
      ),
      undefined,
      {
        filesystem: {
          async rename(source, destination) {
            await rename(source, destination);
            if (source === postOperationSource && destination === postOperationDestination) {
              await unlink(destination);
            }
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      const feedback = formatApplyPatchFailureSummary(error.details, cwd);
      assert.match(
        feedback,
        /Files changed:\nM post-operation-destination\.txt\nD post-operation-source\.txt/u,
      );
      assert.match(
        feedback,
        /Filesystem changed after the operation; post-operation-destination\.txt is unchanged\./u,
      );
      return true;
    },
  );
  await assertMissing(postOperationSource);
  await assertMissing(postOperationDestination);
});
