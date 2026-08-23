import { renameSync } from "node:fs";
import {
  assert,
  writeFileSync,
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  workspace,
  assertMissing,
  patch,
  isFileHandle,
  filesystemError,
} from "./apply-patch-semantic-harness.ts";

test("revalidates identical-add bytes, type, and current postcondition", async (t) => {
  const cwd = await workspace(t);

  const changedPath = join(cwd, "changed-add.txt");
  await writeFile(changedPath, "same\n");
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: changed-add.txt\n+same\n"), undefined, {
      async onExecutionStart() {
        await writeFile(changedPath, "external\n");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.deepEqual(error.details.changes, []);
      assert.equal(error.details.instructions?.[0]?.status, "failed");
      return true;
    },
  );
  assert.equal(await readFile(changedPath, "utf8"), "external\n");

  const typePath = join(cwd, "type-add.txt");
  const typeTargetPath = join(cwd, "type-add-target.txt");
  await writeFile(typePath, "same\n");
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: type-add.txt\n+same\n"), undefined, {
      async onExecutionStart() {
        await rename(typePath, typeTargetPath);
        await symlink("type-add-target.txt", typePath);
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(typeTargetPath, "utf8"), "same\n");

  const spellingPath = join(cwd, "Spelling-Add.txt");
  const alternateSpellingPath = join(cwd, "spelling-add.txt");
  await writeFile(spellingPath, "same\n");
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: Spelling-Add.txt\n+same\n"), undefined, {
      async onExecutionStart() {
        await rename(spellingPath, alternateSpellingPath);
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(alternateSpellingPath, "utf8"), "same\n");

  const replacedPath = join(cwd, "replaced-add.txt");
  const replacedBackupPath = join(cwd, "replaced-add-backup.txt");
  await writeFile(replacedPath, "same\n");
  const original = await lstat(replacedPath);
  const replacement = await applyPatch(
    cwd,
    patch("*** Add File: replaced-add.txt\n+same\n"),
    undefined,
    {
      async onExecutionStart() {
        await rename(replacedPath, replacedBackupPath);
        await writeFile(replacedPath, "same\n");
      },
    },
  );
  assert.deepEqual(replacement.changes, []);
  assert.equal(replacement.instructions?.[0]?.status, "no-op");
  assert.notEqual((await lstat(replacedPath)).ino, original.ino);
  assert.equal(await readFile(replacedPath, "utf8"), "same\n");
});

test("revalidates absent deletes at their source-order position", async (t) => {
  const cwd = await workspace(t);
  const appearedPath = join(cwd, "appeared.txt");

  await assert.rejects(
    applyPatch(cwd, patch("*** Delete File: appeared.txt\n"), undefined, {
      async onExecutionStart() {
        await writeFile(appearedPath, "external\n");
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(appearedPath, "utf8"), "external\n");

  const ordered = await applyPatch(
    cwd,
    patch("*** Delete File: created-later.txt\n", "*** Add File: created-later.txt\n+created\n"),
  );
  assert.deepEqual(
    ordered.instructions?.map(({ status }) => status),
    ["no-op", "applied"],
  );
  assert.equal(await readFile(join(cwd, "created-later.txt"), "utf8"), "created\n");

  await writeFile(join(cwd, "deleted-later.txt"), "same\n");
  const removed = await applyPatch(
    cwd,
    patch("*** Add File: deleted-later.txt\n+same\n", "*** Delete File: deleted-later.txt\n"),
  );
  assert.deepEqual(
    removed.instructions?.map(({ status }) => status),
    ["no-op", "applied"],
  );
  await assertMissing(join(cwd, "deleted-later.txt"));
});

test("reapplies unchanged updates without rejecting unrelated drift", async (t) => {
  const cwd = await workspace(t);
  const constrainedPath = join(cwd, "constrained.txt");
  await writeFile(constrainedPath, "unrelated\nvalue\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: constrained.txt\n@@\n- value\n+value\n"), undefined, {
      async onExecutionStart() {
        await writeFile(constrainedPath, "unrelated\nother\n");
      },
    }),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(constrainedPath, "utf8"), "unrelated\nother\n");

  const unrelatedPath = join(cwd, "unrelated.txt");
  await writeFile(unrelatedPath, "before\nvalue\n");
  const unrelated = await applyPatch(
    cwd,
    patch("*** Update File: unrelated.txt\n@@\n- value\n+value\n"),
    undefined,
    {
      async onExecutionStart() {
        await writeFile(unrelatedPath, "after\nvalue\n");
      },
    },
  );
  assert.deepEqual(unrelated.changes, []);
  assert.equal(unrelated.instructions?.[0]?.status, "no-op");
  assert.equal(await readFile(unrelatedPath, "utf8"), "after\nvalue\n");
});

test("revalidates same-entry aliases and supplied identity chunks", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "same-real"));
  await mkdir(join(cwd, "same-other"));
  await writeFile(join(cwd, "same-real", "file.txt"), "same\n");
  await writeFile(join(cwd, "same-other", "file.txt"), "same\n");
  await symlink("same-real", join(cwd, "same-alias"));

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: same-real/file.txt\n", "*** Move to: same-alias/file.txt\n"),
      undefined,
      {
        async onExecutionStart() {
          await unlink(join(cwd, "same-alias"));
          await symlink("same-other", join(cwd, "same-alias"));
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(join(cwd, "same-real", "file.txt"), "utf8"), "same\n");
  assert.equal(await readFile(join(cwd, "same-other", "file.txt"), "utf8"), "same\n");

  const identityPath = join(cwd, "same-identity.txt");
  await writeFile(identityPath, "expected\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: same-identity.txt\n",
        "*** Move to: same-identity.txt\n",
        "@@\n",
        "-expected\n",
        "+expected\n",
      ),
      undefined,
      {
        async onExecutionStart() {
          await writeFile(identityPath, "unexpected\n");
        },
      },
    ),
    /Failed to find expected lines/u,
  );
  assert.equal(await readFile(identityPath, "utf8"), "unexpected\n");
});

test("keeps unconditional no-ops independent of filesystem drift", async (t) => {
  const cwd = await workspace(t);
  const lexicalSelfPath = join(cwd, "lexical-self.txt");
  await writeFile(lexicalSelfPath, "before\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: empty.txt\n",
      "*** Update File: identity.txt\n@@\n-expected\n+expected\n",
      "*** Update File: lexical-self.txt\n",
      "*** Move to: lexical-self.txt\n",
    ),
    undefined,
    {
      async onExecutionStart() {
        await writeFile(join(cwd, "empty.txt"), "external empty\n");
        await writeFile(join(cwd, "identity.txt"), "external identity\n");
        await writeFile(lexicalSelfPath, "external self\n");
      },
    },
  );

  assert.deepEqual(details.changes, []);
  assert.deepEqual(
    details.instructions?.map(({ status }) => status),
    ["no-op", "no-op", "no-op"],
  );
  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "external empty\n");
  assert.equal(await readFile(join(cwd, "identity.txt"), "utf8"), "external identity\n");
  assert.equal(await readFile(lexicalSelfPath, "utf8"), "external self\n");
});

test("revalidates fulfilled moves by committed identity and supplied chunks", async (t) => {
  const cwd = await workspace(t);

  const recreatedSourcePath = join(cwd, "recreated-source.txt");
  await writeFile(recreatedSourcePath, "move\n");
  let recreated = false;
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: recreated-source.txt\n*** Move to: recreated-destination.txt\n",
        "*** Update File: recreated-source.txt\n*** Move to: recreated-destination.txt\n",
      ),
      undefined,
      {
        onProgress() {
          if (recreated) return;
          recreated = true;
          writeFileSync(recreatedSourcePath, "external\n");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["applied", "failed"],
      );
      return true;
    },
  );
  assert.equal(await readFile(recreatedSourcePath, "utf8"), "external\n");
  assert.equal(await readFile(join(cwd, "recreated-destination.txt"), "utf8"), "move\n");

  const replacedSourcePath = join(cwd, "replaced-source.txt");
  const replacedDestinationPath = join(cwd, "replaced-destination.txt");
  const replacedBackupPath = join(cwd, "replaced-destination-backup.txt");
  await writeFile(replacedSourcePath, "move\n");
  let replaced = false;
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: replaced-source.txt\n*** Move to: replaced-destination.txt\n",
        "*** Update File: replaced-source.txt\n*** Move to: replaced-destination.txt\n",
      ),
      undefined,
      {
        onProgress() {
          if (replaced) return;
          replaced = true;
          renameSync(replacedDestinationPath, replacedBackupPath);
          writeFileSync(replacedDestinationPath, "move\n");
        },
      },
    ),
    ApplyPatchExecutionError,
  );
  assert.equal(await readFile(replacedDestinationPath, "utf8"), "move\n");
  assert.equal(await readFile(replacedBackupPath, "utf8"), "move\n");

  const constrainedSourcePath = join(cwd, "constrained-source.txt");
  const constrainedDestinationPath = join(cwd, "constrained-destination.txt");
  await writeFile(constrainedSourcePath, "expected\n");
  let constrained = false;
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: constrained-source.txt\n*** Move to: constrained-destination.txt\n",
        "*** Update File: constrained-source.txt\n",
        "*** Move to: constrained-destination.txt\n",
        "@@\n",
        "-expected\n",
        "+expected\n",
      ),
      undefined,
      {
        onProgress() {
          if (constrained) return;
          constrained = true;
          writeFileSync(constrainedDestinationPath, "unexpected\n");
        },
      },
    ),
    /Failed to find expected lines/u,
  );
  assert.equal(await readFile(constrainedDestinationPath, "utf8"), "unexpected\n");
});

test("checks fulfilled moves before later mutations and ignores unconstrained bytes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "ordered-source.txt"), "move\n");
  const ordered = await applyPatch(
    cwd,
    patch(
      "*** Update File: ordered-source.txt\n*** Move to: ordered-destination.txt\n",
      "*** Update File: ordered-source.txt\n*** Move to: ordered-destination.txt\n",
      "*** Delete File: ordered-destination.txt\n",
    ),
  );
  assert.deepEqual(
    ordered.instructions?.map(({ status }) => status),
    ["applied", "no-op", "applied"],
  );
  await assertMissing(join(cwd, "ordered-source.txt"));
  await assertMissing(join(cwd, "ordered-destination.txt"));

  const changedSourcePath = join(cwd, "changed-source.txt");
  const changedDestinationPath = join(cwd, "changed-destination.txt");
  await writeFile(changedSourcePath, "before\n");
  let changed = false;
  const unconstrained = await applyPatch(
    cwd,
    patch(
      "*** Update File: changed-source.txt\n*** Move to: changed-destination.txt\n",
      "*** Update File: changed-source.txt\n*** Move to: changed-destination.txt\n",
    ),
    undefined,
    {
      onProgress() {
        if (changed) return;
        changed = true;
        writeFileSync(changedDestinationPath, "external\n");
      },
    },
  );
  assert.deepEqual(
    unconstrained.instructions?.map(({ status }) => status),
    ["applied", "no-op"],
  );
  assert.equal(await readFile(changedDestinationPath, "utf8"), "external\n");
});

test("marks later state-dependent no-ops not run after an earlier failure", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "failed-write.txt"), "before\n");
  await writeFile(join(cwd, "later-no-change.txt"), "same\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: failed-write.txt\n@@\n-before\n+after\n",
        "*** Add File: later-no-change.txt\n+same\n",
      ),
      undefined,
      {
        filesystem: {
          async writeFile(target, data, options) {
            if (isFileHandle(target)) {
              throw filesystemError("EIO", "injected write failure");
            }
            await writeFile(target, data, options);
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["failed", "not-run"],
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "failed-write.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "later-no-change.txt"), "utf8"), "same\n");
});

test("performs no filesystem mutation for stable no-change assertions", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "stable-add.txt"), "same\n");
  await writeFile(join(cwd, "stable-update.txt"), "value\n");
  let mutationCalls = 0;

  const details = await applyPatch(
    cwd,
    patch(
      "*** Add File: stable-add.txt\n+same\n",
      "*** Delete File: stable-absent.txt\n",
      "*** Update File: stable-update.txt\n@@\n- value\n+value\n",
    ),
    undefined,
    {
      filesystem: {
        async mkdir() {
          mutationCalls += 1;
          throw new Error("unexpected mkdir");
        },
        async rename() {
          mutationCalls += 1;
          throw new Error("unexpected rename");
        },
        async unlink() {
          mutationCalls += 1;
          throw new Error("unexpected unlink");
        },
        async writeFile() {
          mutationCalls += 1;
          throw new Error("unexpected write");
        },
      },
    },
  );

  assert.equal(mutationCalls, 0);
  assert.deepEqual(details.changes, []);
  assert.deepEqual(
    details.instructions?.map(({ status }) => status),
    ["no-op", "no-op", "no-op"],
  );
  assert.equal(await readFile(join(cwd, "stable-add.txt"), "utf8"), "same\n");
  assert.equal(await readFile(join(cwd, "stable-update.txt"), "utf8"), "value\n");
  await assertMissing(join(cwd, "stable-absent.txt"));
});
