import { Value } from "typebox/value";
import { APPLY_PATCH_DETAILS_SCHEMA } from "../../extensions/openai-codex-compat/apply-patch-engine/apply-patch-engine-details-schema.ts";
import {
  assert,
  writeFileSync,
  mkdir,
  readFile,
  symlink,
  writeFile,
  join,
  test,
  applyPatch,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  formatApplyPatchRenderText,
  workspace,
  type ApplyPatchDetails,
} from "./apply-patch-harness.ts";

test("rejects malformed optional and literal applied-change fields", () => {
  const detailsWithChange = (change: unknown) => ({
    status: "completed",
    exact: true,
    changes: [change],
    added: [],
    modified: [],
    deleted: [],
  });
  const add = {
    kind: "add",
    path: "added.txt",
    content: "new\n",
    overwrittenContent: "old\n",
    displayDiff: "+new",
    additions: 1,
    deletions: 0,
  };
  const update = {
    kind: "update",
    path: "updated.txt",
    oldContent: "old\n",
    newContent: "new\n",
    overwrittenMoveContent: "destination\n",
    displayDiff: "-old\n+new",
    additions: 1,
    deletions: 1,
  };
  const move = {
    kind: "move",
    sourcePath: "source.txt",
    destinationPath: "destination.txt",
    replacedDestination: true,
    entryType: "regular-file",
    exact: true,
    displayDiff: "",
    additions: 0,
    deletions: 0,
  };

  assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, detailsWithChange(add)), true);
  assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, detailsWithChange(update)), true);
  assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, detailsWithChange(move)), true);

  for (const malformed of [
    { ...add, overwrittenContent: 42 },
    { ...update, overwrittenMoveContent: false },
    { ...move, displayDiff: "unexpected" },
    { ...move, additions: 1 },
    { ...move, deletions: 1 },
    { ...add, additions: 0.5 },
  ]) {
    assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, detailsWithChange(malformed)), false);
  }
});

test("validates complete nested apply-patch details from one schema", () => {
  const instruction = {
    index: 1,
    kind: "move",
    path: "source.txt",
    moveTo: "destination.txt",
    status: "no-op",
    reason: {
      code: "move-already-fulfilled",
      message: "A previous instruction already moved the entry.",
      dominatingInstructions: [1],
      relatedInstructions: [1],
    },
    effects: [
      { kind: "created", path: "created.txt" },
      {
        kind: "replaced",
        path: "destination.txt",
        previousEntry: { entryType: "regular-file" },
        replacementEntry: { entryType: "symlink", target: "target.txt" },
      },
      { kind: "symlink-target-modified", path: "link.txt", target: "target.txt" },
    ],
    finalStates: [{ path: "destination.txt", state: "unchanged" }],
    changeIndexes: [0],
    error: "diagnostic",
    futureInstructionMetadata: true,
  };
  const details = {
    status: "failed",
    exact: false,
    changes: [],
    added: [],
    modified: [],
    deleted: [],
    instructions: [instruction],
    failure: {
      phase: "execution",
      message: "Execution stopped.",
      failedInstruction: 1,
    },
    error: "Execution stopped.",
    futureDetailsMetadata: true,
  };

  assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, details), true);

  const missingReplacement = structuredClone(instruction.effects[1]);
  assert.ok(missingReplacement);
  Reflect.deleteProperty(missingReplacement, "replacementEntry");

  const missingRequiredDetails = structuredClone(details);
  Reflect.deleteProperty(missingRequiredDetails, "changes");

  for (const malformed of [
    missingRequiredDetails,
    { ...details, instructions: [{ ...instruction, index: 1.5 }] },
    { ...details, instructions: [{ ...instruction, changeIndexes: [0.5] }] },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          reason: { ...instruction.reason, dominatingInstructions: [0.5] },
        },
      ],
    },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          reason: { ...instruction.reason, relatedInstructions: [] },
        },
      ],
    },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          reason: { ...instruction.reason, relatedInstructions: [1, 2] },
        },
      ],
    },
    { ...details, instructions: [{ ...instruction, effects: [missingReplacement] }] },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          effects: [
            {
              kind: "replaced",
              path: "destination.txt",
              previousEntry: { entryType: "regular-file" },
              replacementEntry: { entryType: "symlink" },
            },
          ],
        },
      ],
    },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          effects: [{ kind: "symlink-moved", path: "link.txt" }],
        },
      ],
    },
    {
      ...details,
      instructions: [
        {
          ...instruction,
          finalStates: [{ path: "destination.txt", state: "unexpected" }],
        },
      ],
    },
    {
      ...details,
      failure: { ...details.failure, failedInstruction: 1.5 },
    },
  ]) {
    assert.equal(Value.Check(APPLY_PATCH_DETAILS_SCHEMA, malformed), false);
  }
});

test("prevalidates all hunks but preserves committed-prefix history after runtime failure", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "current.txt"), "original\n");
  let executionStarted = false;

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+should not be written
*** Update File: missing.txt
@@
-missing
+replacement
*** End Patch`,
      undefined,
      {
        onExecutionStart() {
          executionStarted = true;
        },
      },
    ),
    /apply_patch verification failed/,
  );
  assert.equal(executionStarted, false);
  await assert.rejects(readFile(join(cwd, "created.txt"), "utf8"), { code: "ENOENT" });

  const duplicatePatch = `*** Begin Patch
*** Update File: current.txt
@@
-original
+first
*** Update File: current.txt
@@
-original
+second
*** End Patch`;
  const verificationLifecycle: string[] = [];
  await assert.rejects(
    applyPatch(cwd, duplicatePatch, undefined, {
      onExecutionStart() {
        verificationLifecycle.push("execution-start");
      },
    }),
    /Failed to find expected lines/,
  );
  assert.equal(verificationLifecycle.length, 0);
  assert.equal(await readFile(join(cwd, "current.txt"), "utf8"), "original\n");

  await writeFile(join(cwd, "first.txt"), "first before\n");
  await writeFile(join(cwd, "second.txt"), "second before\n");
  const runtimeFailurePatch = `*** Begin Patch
*** Update File: first.txt
@@
-first before
+first after
*** Update File: second.txt
@@
-second before
+second after
*** End Patch`;
  const lifecycle: string[] = [];
  await assert.rejects(
    applyPatch(cwd, runtimeFailurePatch, undefined, {
      onExecutionStart() {
        lifecycle.push("execution-start");
      },
      onProgress() {
        lifecycle.push("progress");
        writeFileSync(join(cwd, "second.txt"), "external change\n");
      },
    }),
    (error: unknown) => {
      if (!(error instanceof ApplyPatchExecutionError)) return false;
      assert.equal(error.details.status, "failed");
      assert.equal(error.details.changes.length, 1);
      assert.equal(error.details.changes[0]?.kind, "update");
      assert.equal(error.details.failure?.phase, "execution");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ status }) => status),
        ["applied", "failed"],
      );
      return true;
    },
  );
  assert.deepEqual(lifecycle, ["execution-start", "progress"]);
  assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first after\n");
  assert.equal(await readFile(join(cwd, "second.txt"), "utf8"), "external change\n");
});

test("reports parse and preflight failures by instruction", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "existing.txt"), "keep\n");

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: broken.txt
this line is invalid
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.equal(error.details.failure?.phase, "parse");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ kind, path, status }) => ({ kind, path, status })),
        [
          { kind: "add", path: "created.txt", status: "not-run" },
          { kind: "update", path: "broken.txt", status: "failed" },
        ],
      );
      return true;
    },
  );
  await assert.rejects(readFile(join(cwd, "created.txt")), { code: "ENOENT" });

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: actual.txt
@@
 context
 *** Delete File: header-looking-context.txt
invalid update line
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      assert.equal(error.details.failure?.phase, "parse");
      assert.equal(error.details.failure?.failedInstruction, 1);
      assert.deepEqual(
        error.details.instructions?.map(({ kind, path, status }) => ({ kind, path, status })),
        [{ kind: "update", path: "actual.txt", status: "failed" }],
      );
      return true;
    },
  );

  let preflightDetails: ApplyPatchDetails | undefined;
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: missing.txt
@@
-missing
+replacement
*** Delete File: existing.txt
*** End Patch`,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchVerificationError);
      preflightDetails = error.details;
      assert.equal(error.details.failure?.phase, "preflight");
      assert.equal(error.details.failure?.failedInstruction, 2);
      assert.deepEqual(
        error.details.instructions?.map(({ kind, path, status }) => ({ kind, path, status })),
        [
          { kind: "add", path: "created.txt", status: "not-run" },
          { kind: "update", path: "missing.txt", status: "failed" },
          { kind: "delete", path: "existing.txt", status: "not-run" },
        ],
      );
      return true;
    },
  );
  assert.ok(preflightDetails);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = formatApplyPatchRenderText(preflightDetails, theme, cwd);
  assert.match(rendered, /Patch failed at instruction 2 of 3\./);
  assert.match(rendered, /Patch instruction results:/);
  assert.match(rendered, /2\. \[FAILED\] Update missing\.txt — Read failed: path does not exist\./);
  assert.match(rendered, /1\. \[NOT RUN\] Add created\.txt — Instruction 2 failed\./);
  assert.match(rendered, /3\. \[NOT RUN\] Delete existing\.txt — Instruction 2 failed\./);
  await assert.rejects(readFile(join(cwd, "created.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "keep\n");
});

test("rejects invalid UTF-8 like Codex", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "binary.txt"), Buffer.from([0xff, 0x0a]));
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: binary.txt
@@
+appended
*** End Patch`,
    ),
    /encoded data was not valid/,
  );
});

test("matches Codex unrestricted path and symlink semantics", async (t) => {
  const root = await workspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  const absolutePath = join(root, "absolute.txt");
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git/config"), "old config\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(join(outside, "secret.txt"), join(cwd, "outside.txt"));

  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Add File: ../relative.txt
+relative
*** Add File: ${absolutePath}
+absolute
*** Add File: .git/config
+new config
*** Update File: outside.txt
@@
-secret
+exposed
*** End Patch`,
  );

  assert.equal(await readFile(join(root, "relative.txt"), "utf8"), "relative\n");
  assert.equal(await readFile(absolutePath, "utf8"), "absolute\n");
  assert.equal(await readFile(join(cwd, ".git/config"), "utf8"), "new config\n");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "exposed\n");
  assert.equal(details.exact, true);
});
