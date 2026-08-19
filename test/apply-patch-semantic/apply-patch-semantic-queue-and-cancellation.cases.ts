import {
  assert,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  join,
  delay,
  createServer,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  formatApplyPatchSummary,
  execFileAsync,
  workspace,
  assertMissing,
  patch,
  deferred,
} from "./apply-patch-semantic-harness.ts";

test("does not expose missing previous-content history to the model", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "unreadable.txt");
  await writeFile(target, "private\n");
  await chmod(target, 0);

  const details = await applyPatch(cwd, patch("*** Add File: unreadable.txt\n+replacement\n"));
  const feedback = formatApplyPatchSummary(details, cwd);
  await chmod(target, 0o600);
  assert.equal(await readFile(target, "utf8"), "replacement\n");
  assert.match(feedback, /A unreadable\.txt/u);
  assert.match(feedback, /1\. \[APPLIED\] Add unreadable\.txt/u);
  assert.doesNotMatch(feedback, /previous content|diff|history|Committed prefix|exact|inexact/u);
});

test("serializes same-process filesystem aliases with deterministic logical keys", async (t) => {
  const cwd = await workspace(t);

  const assertAliasAddsSerialize = async (firstPath: string, secondPath: string): Promise<void> => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let secondStarted = false;
    const first = applyPatch(cwd, patch(`*** Add File: ${firstPath}\n+first\n`), undefined, {
      async onExecutionStart() {
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    });
    await firstStarted.promise;
    const second = applyPatch(cwd, patch(`*** Add File: ${secondPath}\n+second\n`), undefined, {
      onExecutionStart() {
        secondStarted = true;
      },
    });
    await delay(25);
    assert.equal(secondStarted, false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(await readFile(join(cwd, secondPath), "utf8"), "second\n");
  };

  const caseProbe = join(cwd, "CaseProbe");
  await writeFile(caseProbe, "");
  const caseAliases =
    (await lstat(caseProbe)).ino ===
    (await lstat(join(cwd, "caseprobe")).catch(() => ({ ino: -1 }))).ino;
  await rm(caseProbe);
  if (caseAliases) await assertAliasAddsSerialize("MissingCase.txt", "missingcase.txt");

  const composed = "caf\u00e9-probe";
  const decomposed = "cafe\u0301-probe";
  await writeFile(join(cwd, composed), "");
  const unicodeAliases =
    (await lstat(join(cwd, composed))).ino ===
    (await lstat(join(cwd, decomposed)).catch(() => ({ ino: -1 }))).ino;
  await rm(join(cwd, composed));
  if (unicodeAliases) {
    await assertAliasAddsSerialize("caf\u00e9-missing.txt", "cafe\u0301-missing.txt");
  }

  await writeFile(join(cwd, "hard-a.txt"), "before\n");
  await link(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  const firstHardStarted = deferred();
  const releaseHard = deferred();
  let secondHardStarted = false;
  const firstHard = applyPatch(
    cwd,
    patch("*** Update File: hard-a.txt\n@@\n-before\n+one\n"),
    undefined,
    {
      async onExecutionStart() {
        firstHardStarted.resolve();
        await releaseHard.promise;
      },
    },
  );
  await firstHardStarted.promise;
  const secondHard = applyPatch(
    cwd,
    patch("*** Update File: hard-b.txt\n@@\n-one\n+two\n"),
    undefined,
    {
      onExecutionStart() {
        secondHardStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(secondHardStarted, false);
  releaseHard.resolve();
  await Promise.all([firstHard, secondHard]);
  assert.equal(await readFile(join(cwd, "hard-a.txt"), "utf8"), "two\n");
  assert.equal(await readFile(join(cwd, "hard-b.txt"), "utf8"), "two\n");

  await writeFile(join(cwd, "replace-a.txt"), "shared\n");
  await link(join(cwd, "replace-a.txt"), join(cwd, "replace-b.txt"));
  const replaceStarted = deferred();
  const releaseReplace = deferred();
  let aliasUpdateStarted = false;
  const replacement = applyPatch(
    cwd,
    patch("*** Add File: replace-a.txt\n+independent\n"),
    undefined,
    {
      async onExecutionStart() {
        replaceStarted.resolve();
        await releaseReplace.promise;
      },
    },
  );
  await replaceStarted.promise;
  const aliasUpdate = applyPatch(
    cwd,
    patch("*** Update File: replace-b.txt\n@@\n-shared\n+remaining\n"),
    undefined,
    {
      onExecutionStart() {
        aliasUpdateStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(aliasUpdateStarted, false);
  releaseReplace.resolve();
  await Promise.all([replacement, aliasUpdate]);
  assert.equal(await readFile(join(cwd, "replace-a.txt"), "utf8"), "independent\n");
  assert.equal(await readFile(join(cwd, "replace-b.txt"), "utf8"), "remaining\n");

  await mkdir(join(cwd, "real-parent"));
  await symlink("real-parent", join(cwd, "alias-parent"));
  await assertAliasAddsSerialize("real-parent/missing-tail.txt", "alias-parent/missing-tail.txt");
  await writeFile(join(cwd, "real-parent", "queued.txt"), "before\n");
  const parentStarted = deferred();
  const releaseParent = deferred();
  let parentAliasStarted = false;
  const parentUpdate = applyPatch(
    cwd,
    patch("*** Update File: real-parent/queued.txt\n@@\n-before\n+one\n"),
    undefined,
    {
      async onExecutionStart() {
        parentStarted.resolve();
        await releaseParent.promise;
      },
    },
  );
  await parentStarted.promise;
  const parentAliasUpdate = applyPatch(
    cwd,
    patch("*** Update File: alias-parent/queued.txt\n@@\n-one\n+two\n"),
    undefined,
    {
      onExecutionStart() {
        parentAliasStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(parentAliasStarted, false);
  releaseParent.resolve();
  await Promise.all([parentUpdate, parentAliasUpdate]);
  assert.equal(await readFile(join(cwd, "real-parent", "queued.txt"), "utf8"), "two\n");

  await writeFile(join(cwd, "move-queue-source.txt"), "source\n");
  const destinationHolderStarted = deferred();
  const releaseDestinationHolder = deferred();
  let destinationMoveStarted = false;
  const destinationHolder = applyPatch(
    cwd,
    patch("*** Add File: move-queue-destination.txt\n+temporary\n"),
    undefined,
    {
      async onExecutionStart() {
        destinationHolderStarted.resolve();
        await releaseDestinationHolder.promise;
      },
    },
  );
  await destinationHolderStarted.promise;
  const destinationMove = applyPatch(
    cwd,
    patch("*** Update File: move-queue-source.txt\n*** Move to: move-queue-destination.txt\n"),
    undefined,
    {
      onExecutionStart() {
        destinationMoveStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(destinationMoveStarted, false);
  releaseDestinationHolder.resolve();
  await Promise.all([destinationHolder, destinationMove]);
  await assertMissing(join(cwd, "move-queue-source.txt"));
  assert.equal(await readFile(join(cwd, "move-queue-destination.txt"), "utf8"), "source\n");

  const sourceHolderStarted = deferred();
  const releaseSourceHolder = deferred();
  let sourceMoveStarted = false;
  const sourceHolder = applyPatch(
    cwd,
    patch("*** Add File: move-queue-new-source.txt\n+new source\n"),
    undefined,
    {
      async onExecutionStart() {
        sourceHolderStarted.resolve();
        await releaseSourceHolder.promise;
      },
    },
  );
  await sourceHolderStarted.promise;
  const sourceMove = applyPatch(
    cwd,
    patch(
      "*** Update File: move-queue-new-source.txt\n*** Move to: move-queue-new-destination.txt\n",
    ),
    undefined,
    {
      onExecutionStart() {
        sourceMoveStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(sourceMoveStarted, false);
  releaseSourceHolder.resolve();
  await Promise.all([sourceHolder, sourceMove]);
  await assertMissing(join(cwd, "move-queue-new-source.txt"));
  assert.equal(await readFile(join(cwd, "move-queue-new-destination.txt"), "utf8"), "new source\n");

  await writeFile(join(cwd, "order-a.txt"), "a0\n");
  await writeFile(join(cwd, "order-b.txt"), "b0\n");
  const orderStarted = deferred();
  const releaseOrder = deferred();
  let reverseStarted = false;
  const ordered = applyPatch(
    cwd,
    patch(
      "*** Update File: order-a.txt\n@@\n-a0\n+a1\n",
      "*** Update File: order-b.txt\n@@\n-b0\n+b1\n",
    ),
    undefined,
    {
      async onExecutionStart() {
        orderStarted.resolve();
        await releaseOrder.promise;
      },
    },
  );
  await orderStarted.promise;
  const reversed = applyPatch(
    cwd,
    patch(
      "*** Update File: order-b.txt\n@@\n-b1\n+b2\n",
      "*** Update File: order-a.txt\n@@\n-a1\n+a2\n",
    ),
    undefined,
    {
      onExecutionStart() {
        reverseStarted = true;
      },
    },
  );
  await delay(25);
  assert.equal(reverseStarted, false);
  releaseOrder.resolve();
  await Promise.race([
    Promise.all([ordered, reversed]),
    delay(2_000).then(() => {
      throw new Error("reverse-order logical queue acquisition deadlocked");
    }),
  ]);
  assert.equal(await readFile(join(cwd, "order-a.txt"), "utf8"), "a2\n");
  assert.equal(await readFile(join(cwd, "order-b.txt"), "utf8"), "b2\n");
});

test("honors cancellation before, during, and between apply_patch phases", async (t) => {
  const cwd = await workspace(t);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: pre-aborted.txt\n+no\n"), preAborted.signal),
    /apply_patch was cancelled/u,
  );
  await assertMissing(join(cwd, "pre-aborted.txt"));

  await writeFile(join(cwd, "matcher-cancel.js"), "const result = combine(alpha, beta);\n");
  let signalReads = 0;
  let matcherExecutionStarted = false;
  const matcherSignal = new Proxy(new AbortController().signal, {
    get(target, property) {
      if (property === "aborted") {
        signalReads += 1;
        return signalReads >= 6;
      }
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: matcher-cancel.js\n@@\n",
        "-const result = combine(\n",
        "-  alpha,\n",
        "-  beta\n",
        "-);\n",
        "+const result = merge(\n",
        "+  alpha,\n",
        "+  beta\n",
        "+);\n",
      ),
      matcherSignal,
      {
        onExecutionStart() {
          matcherExecutionStarted = true;
        },
      },
    ),
    /apply_patch was cancelled/u,
  );
  assert.equal(matcherExecutionStarted, false);
  assert.ok(signalReads >= 6);
  assert.equal(
    await readFile(join(cwd, "matcher-cancel.js"), "utf8"),
    "const result = combine(alpha, beta);\n",
  );

  const firstStarted = deferred();
  const releaseFirst = deferred();
  const holder = applyPatch(cwd, patch("*** Add File: queued-cancel.txt\n+holder\n"), undefined, {
    async onExecutionStart() {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;
  const waitingController = new AbortController();
  let waitingSettled = false;
  const waiting = applyPatch(
    cwd,
    patch("*** Add File: queued-cancel.txt\n+cancelled\n"),
    waitingController.signal,
  ).finally(() => {
    waitingSettled = true;
  });
  waitingController.abort();
  await delay(25);
  assert.equal(waitingSettled, false);
  releaseFirst.resolve();
  await holder;
  await assert.rejects(waiting, /apply_patch was cancelled/u);
  assert.equal(await readFile(join(cwd, "queued-cancel.txt"), "utf8"), "holder\n");

  const beforeMutationController = new AbortController();
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Add File: before-mutation.txt\n+no\n"),
      beforeMutationController.signal,
      {
        onExecutionStart() {
          beforeMutationController.abort();
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.changes.length, 0);
      assert.equal(error.details.failure?.failedInstruction, 1);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["failed"],
      );
      return true;
    },
  );
  await assertMissing(join(cwd, "before-mutation.txt"));

  const betweenController = new AbortController();
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Add File: between-first.txt\n+first\n",
        "*** Add File: between-second.txt\n+second\n",
      ),
      betweenController.signal,
      {
        onProgress() {
          betweenController.abort();
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchExecutionError);
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["applied", "failed"],
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "between-first.txt"), "utf8"), "first\n");
  await assertMissing(join(cwd, "between-second.txt"));

  await applyPatch(cwd, patch("*** Add File: queue-released.txt\n+yes\n"));
  assert.equal(await readFile(join(cwd, "queue-released.txt"), "utf8"), "yes\n");
});

test(
  "rejects directories, FIFOs, sockets, and available device entries before mutation",
  { skip: process.platform === "win32" },
  async (t) => {
    const cwd = await workspace(t);
    const directory = join(cwd, "directory");
    const fifo = join(cwd, "named-pipe");
    const socket = join(cwd, "unix-socket");
    await mkdir(directory);
    await execFileAsync("mkfifo", [fifo]);

    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(socket, resolvePromise);
    });
    try {
      const specialPaths: Array<{ path: string; kind: string }> = [
        { path: directory, kind: "directory" },
        { path: fifo, kind: "fifo" },
        { path: socket, kind: "socket" },
      ];
      try {
        if ((await lstat("/dev/null")).isCharacterDevice()) {
          specialPaths.push({ path: "/dev/null", kind: "character device" });
        }
      } catch {}
      try {
        for (const name of await readdir("/dev")) {
          const candidate = join("/dev", name);
          if ((await lstat(candidate)).isBlockDevice()) {
            specialPaths.push({ path: candidate, kind: "block device" });
            break;
          }
        }
      } catch {}

      for (const special of specialPaths) {
        await assert.rejects(
          applyPatch(cwd, patch(`*** Update File: ${special.path}\n@@\n-old\n+new\n`)),
          (error: unknown) => {
            assert.ok(error instanceof ApplyPatchVerificationError);
            assert.match(error.message, new RegExp(special.kind, "u"));
            assert.equal(error.details.changes.length, 0);
            assert.equal(error.details.failure?.phase, "preflight");
            return true;
          },
        );
        const metadata = await lstat(special.path);
        assert.equal(
          special.kind === "directory"
            ? metadata.isDirectory()
            : special.kind === "fifo"
              ? metadata.isFIFO()
              : special.kind === "socket"
                ? metadata.isSocket()
                : special.kind === "character device"
                  ? metadata.isCharacterDevice()
                  : metadata.isBlockDevice(),
          true,
        );
      }
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  },
);
