import {
  assert,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  workspace,
  assertMissing,
  patch,
  filesystemError,
} from "./apply-patch-semantic-harness.ts";

test("executes state-dependent no-change checkpoints in source order", async (t) => {
  const cwd = await workspace(t);

  const created = await applyPatch(
    cwd,
    patch("*** Delete File: created-later.txt\n", "*** Add File: created-later.txt\n+created\n"),
  );
  assert.deepEqual(
    created.instructions?.map(({ status }) => status),
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

  await writeFile(join(cwd, "ordered-source.txt"), "move\n");
  const moved = await applyPatch(
    cwd,
    patch(
      "*** Update File: ordered-source.txt\n*** Move to: ordered-destination.txt\n",
      "*** Update File: ordered-source.txt\n*** Move to: ordered-destination.txt\n",
      "*** Delete File: ordered-destination.txt\n",
    ),
  );
  assert.deepEqual(
    moved.instructions?.map(({ status }) => status),
    ["applied", "no-op", "applied"],
  );
  await assertMissing(join(cwd, "ordered-source.txt"));
  await assertMissing(join(cwd, "ordered-destination.txt"));
});

test("marks later state-dependent no-change checkpoints not run after a failure", async (t) => {
  const cwd = await workspace(t);
  const failedPath = join(cwd, "failed-write.txt");
  await writeFile(failedPath, "before\n");
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
            if (target === failedPath) {
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
  assert.equal(await readFile(failedPath, "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "later-no-change.txt"), "utf8"), "same\n");
});

test("performs no filesystem mutation at no-change checkpoints", async (t) => {
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
