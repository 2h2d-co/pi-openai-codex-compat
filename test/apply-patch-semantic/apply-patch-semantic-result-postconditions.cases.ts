import {
  assert,
  readFile,
  unlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  workspace,
  patch,
  pathLikeBasename,
} from "./apply-patch-semantic-harness.ts";

test("requires the complete final bytes instead of finding requested bytes elsewhere", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "duplicates.txt");
  const wrongResult = "header\nneedle\nmiddle\nchanged\nfooter\n";
  await writeFile(target, "header\nneedle\nmiddle\nneedle\nfooter\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: duplicates.txt\n",
        "@@\n",
        " header\n",
        "-needle\n",
        "+changed\n",
        " middle\n",
      ),
      undefined,
      {
        filesystem: {
          async writeFile(path, _content, options) {
            if (path === target) {
              await writeFile(target, wrongResult, options);
              return;
            }
            throw new Error("Unexpected write target");
          },
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.match(error.message, /did not produce the complete requested bytes/u);
      assert.equal(error.details.instructions?.[0]?.status, "failed");
      return true;
    },
  );
  assert.equal(await readFile(target, "utf8"), wrongResult);
});

test("verifies replacement bytes before committing a temporary file", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "added.txt");

  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: added.txt\n+intended\n"), undefined, {
      filesystem: {
        async writeFile(path, _content, options) {
          await writeFile(path, "different\n", options);
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.match(error.message, /temporary replacement content differs/u);
      assert.equal(error.details.instructions?.[0]?.status, "failed");
      return true;
    },
  );
  await assert.rejects(readFile(target), /ENOENT/u);
});

test("does not clean obsolete temporary paths after committed renames", async (t) => {
  const cwd = await workspace(t);
  const rejectObsoleteTemporaryCleanup: typeof unlink = async (path) => {
    if (pathLikeBasename(path).includes(".apply-patch-")) {
      throw new Error("unexpected cleanup after committed rename");
    }
    await unlink(path);
  };

  await applyPatch(cwd, patch("*** Add File: added.txt\n+added\n"), undefined, {
    filesystem: {
      unlink: rejectObsoleteTemporaryCleanup,
    },
  });

  await writeFile(join(cwd, "source.txt"), "source\n");
  await applyPatch(
    cwd,
    patch("*** Update File: source.txt\n*** Move to: destination.txt\n"),
    undefined,
    {
      selectMoveStrategy: () => "copy-unlink",
      filesystem: {
        unlink: rejectObsoleteTemporaryCleanup,
      },
    },
  );

  assert.equal(await readFile(join(cwd, "added.txt"), "utf8"), "added\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "source\n");
});
