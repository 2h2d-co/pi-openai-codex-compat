import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createServer } from "node:net";
import test, { type TestContext } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchSummary,
  parsePatch,
  previewPatch,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import { ApplyPatchDiffComponent } from "../extensions/openai-codex-compat/apply-patch-diff-render.ts";
import { formatApplyPatchRenderText } from "../extensions/openai-codex-compat/apply-patch-render.ts";

const execFileAsync = promisify(execFile);

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-semantic-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

function patch(...operations: string[]): string {
  return `*** Begin Patch\n${operations.join("")}*** End Patch`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function filesystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function pathLikeBasename(path: unknown): string {
  if (typeof path === "string") return basename(path);
  if (Buffer.isBuffer(path)) return basename(path.toString());
  if (path instanceof URL) return basename(path.pathname);
  return "";
}

void test("accepts grammar-valid empty and identity updates as no-ops", async (t) => {
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
      "Instruction results:",
      "1. NO CHANGE - Update missing.txt - The instruction contains no changes.",
      "2. NO CHANGE - Update also-missing.txt - Old and replacement content are identical.",
      "3. NO CHANGE - Update same.txt - Old and replacement content are identical.",
      "4. NO CHANGE - Add same.txt - Requested content already present.",
      "5. NO CHANGE - Delete absent.txt - Path already absent.",
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

void test("reports patch-level input and format failures once", async (t) => {
  const cwd = await workspace(t);

  await assert.rejects(applyPatch(cwd, "not a patch"), (error: unknown) => {
    assert.ok(error instanceof ApplyPatchVerificationError);
    const feedback = formatApplyPatchFailureSummary(error.details, cwd);
    const reason = "The first line of the patch must be '*** Begin Patch'";
    assert.equal(feedback.split(reason).length - 1, 1);
    assert.doesNotMatch(feedback, /Instruction results:/u);
    return true;
  });

  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Environment ID: unavailable\n", "*** Add File: not-run.txt\n+not run\n"),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchInputError);
      const feedback = formatApplyPatchFailureSummary(error.details!, cwd);
      assert.match(
        feedback,
        /^Patch input error: apply_patch environment selection is unavailable for this turn$/mu,
      );
      assert.match(feedback, /^1\. NOT RUN - Add not-run\.txt - Patch input error\.$/mu);
      return true;
    },
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    applyPatch(cwd, patch("*** Add File: cancelled.txt\n+cancelled\n"), controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof ApplyPatchInputError);
      const feedback = formatApplyPatchFailureSummary(error.details!, cwd);
      assert.match(feedback, /^Patch stopped before execution\.$/mu);
      assert.match(feedback, /^1\. NOT RUN - Add cancelled\.txt - Patch stopped\.$/mu);
      assert.doesNotMatch(feedback, /Filesystem setup failed|Patch input error/u);
      return true;
    },
  );
});

void test("explains every no-op and dead operation to the model and TUI", async (t) => {
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
      ["no-op", "content-already-present"],
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
    /1\. NO CHANGE - Update same-content\.txt - Requested content already present\./u,
  );
  assert.match(
    model,
    /4\. NO CHANGE - Move move-source\.txt -> move-destination\.txt - Instruction 3 already moved this entry\./u,
  );
  assert.match(
    model,
    /5\. SKIPPED - Update dead-delete\.txt - Instruction 6 determines the final filesystem state before another instruction reads it\./u,
  );
  assert.doesNotMatch(model, /[○↷→—]/u);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const collapsed = new ApplyPatchDiffComponent(details, theme, cwd, false).render(140).join("\n");
  assert.match(collapsed, /Instruction results:/u);
  assert.match(collapsed, /○ 1\. Update same-content\.txt — Requested content already present\./u);
  assert.match(collapsed, /↷ 5\. Update dead-delete\.txt — Instruction 6 determines/u);
  assert.doesNotMatch(collapsed, /Proof:/u);
  const expanded = new ApplyPatchDiffComponent(details, theme, cwd, true).render(140).join("\n");
  assert.match(expanded, /↷ 5\. Update dead-delete\.txt — Instruction 6 determines/u);
  assert.match(expanded, /↷ 7\. Update dead-add\.txt — Instruction 8 determines/u);
  assert.doesNotMatch(expanded, /Proof:/u);
});

void test("reports every instruction to the model and TUI without a limit", async (t) => {
  const cwd = await workspace(t);
  const operations = Array.from(
    { length: 11 },
    (_, index) => `*** Delete File: absent-${index + 1}.txt\n`,
  );
  const details = await applyPatch(cwd, patch(...operations));
  const model = formatApplyPatchSummary(details);
  assert.equal((model.match(/^\d+\. NO CHANGE - Delete/gmu) ?? []).length, 11);
  assert.doesNotMatch(model, /omitted|more instruction explanations/u);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const collapsed = new ApplyPatchDiffComponent(details, theme, cwd, false).render(120).join("\n");
  assert.equal((collapsed.match(/○ \d+\. Delete/gmu) ?? []).length, 11);
  assert.doesNotMatch(collapsed, /more instruction explanations/u);
  const expanded = new ApplyPatchDiffComponent(details, theme, cwd, true).render(120).join("\n");
  assert.equal((expanded.match(/○ \d+\. Delete/gmu) ?? []).length, 11);
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
    /1\. SKIPPED - Update dead-1\.txt - Instruction 3 determines the final filesystem state before another instruction reads it\./u,
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
      (formatApplyPatchSummary(complete).match(/^\d+\. NO CHANGE - Delete/gmu) ?? []).length,
      count,
    );
    assert.equal(
      (
        new ApplyPatchDiffComponent(complete, theme, cwd, false)
          .render(120)
          .join("\n")
          .match(/○ \d+\. Delete/gmu) ?? []
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
    instructions: Array.from({ length: 500 }, (_, offset) => ({
      index: offset + 1,
      kind: "delete" as const,
      path: `failed-large-${offset + 1}.txt`,
      status: offset + 1 === failedInstruction ? ("failed" as const) : ("not-run" as const),
      ...(offset + 1 === failedInstruction ? { error: "injected failure" } : {}),
    })),
    failure: {
      phase: "execution",
      message: "injected failure",
      failedInstruction,
    },
    error: "injected failure",
  };
  const failedModel = formatApplyPatchFailureSummary(failedLarge, cwd);
  assert.equal((failedModel.match(/^\d+\. (?:FAILED|NOT RUN) - Delete/gmu) ?? []).length, 500);
  assert.doesNotMatch(failedModel, /omitted/u);
  const failedTui = new ApplyPatchDiffComponent(failedLarge, theme, cwd, false)
    .render(120)
    .join("\n");
  assert.equal((failedTui.match(/[–✘] \d+\. Delete/gmu) ?? []).length, 500);
  assert.doesNotMatch(failedTui, /omitted/u);
});

void test("moves opaque regular files without decoding or changing bytes", async (t) => {
  const cwd = await workspace(t);
  const fixtures = new Map<string, Buffer>([
    ["invalid.bin", Buffer.from([0xff, 0xfe, 0x00, 0x0a])],
    ["nul.bin", Buffer.from([0x00, 0x01, 0x00])],
    ["empty.bin", Buffer.alloc(0)],
    ["bom.bin", Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])],
    ["crlf.bin", Buffer.from("one\r\ntwo\r\n")],
    ["cr.bin", Buffer.from("one\rtwo\r")],
    ["mixed.bin", Buffer.from("one\r\ntwo\rthree\n")],
    ["no-newline.bin", Buffer.from("tail")],
    ["identity.bin", Buffer.from([0xff, 0x00, 0xfe])],
  ]);
  for (const [name, bytes] of fixtures) await writeFile(join(cwd, name), bytes);
  await chmod(join(cwd, "invalid.bin"), 0o755);

  const operations = [...fixtures.keys()].map((name) =>
    name === "identity.bin"
      ? `*** Update File: ${name}\n*** Move to: moved/${name}\n@@\n-same\n+same\n`
      : `*** Update File: ${name}\n*** Move to: moved/${name}\n`,
  );
  const details = await applyPatch(cwd, patch(...operations));

  assert.equal(details.changes.length, fixtures.size);
  assert.ok(details.changes.every((change) => change.kind === "move"));
  assert.doesNotMatch(JSON.stringify(details), /\ufffd/);
  for (const [name, bytes] of fixtures) {
    assert.deepEqual(await readFile(join(cwd, "moved", name)), bytes);
    await assertMissing(join(cwd, name));
  }
  assert.equal((await stat(join(cwd, "moved", "invalid.bin"))).mode & 0o777, 0o755);
});

void test("moves symbolic-link entries and replaces destination links", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "target stays unchanged\n");
  await symlink("target.txt", join(cwd, "source-link"));
  await writeFile(join(cwd, "source.bin"), Buffer.from([0xff, 0x00]));
  await symlink("target.txt", join(cwd, "destination-link"));

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: source-link\n*** Move to: nested/moved-link\n",
      "*** Update File: source.bin\n*** Move to: destination-link\n",
    ),
  );

  assert.equal(await readlink(join(cwd, "nested", "moved-link")), "target.txt");
  assert.deepEqual(await readFile(join(cwd, "destination-link")), Buffer.from([0xff, 0x00]));
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "target stays unchanged\n");
  assert.deepEqual(
    details.changes.map((change) =>
      change.kind === "move"
        ? [change.entryType, change.replacedDestination]
        : [change.kind, false],
    ),
    [
      ["symbolic-link", false],
      ["regular-file", true],
    ],
  );

  await mkdir(join(cwd, "relative-source"));
  await mkdir(join(cwd, "relative-destination"));
  await writeFile(join(cwd, "relative-source", "target.txt"), "source target\n");
  await writeFile(join(cwd, "relative-destination", "target.txt"), "destination target\n");
  await symlink("target.txt", join(cwd, "relative-source", "link.txt"));
  await applyPatch(
    cwd,
    patch(
      "*** Update File: relative-source/link.txt\n",
      "*** Move to: relative-destination/link.txt\n",
      "*** Update File: relative-destination/link.txt\n",
      "@@\n-destination target\n+updated destination\n",
    ),
  );
  assert.equal(
    await readFile(join(cwd, "relative-source", "target.txt"), "utf8"),
    "source target\n",
  );
  assert.equal(
    await readFile(join(cwd, "relative-destination", "target.txt"), "utf8"),
    "updated destination\n",
  );

  await mkdir(join(cwd, "cross-relative-source"));
  await mkdir(join(cwd, "cross-relative-destination"));
  await writeFile(join(cwd, "cross-relative-source", "target.txt"), "cross source\n");
  await writeFile(join(cwd, "cross-relative-destination", "target.txt"), "cross destination\n");
  await symlink("target.txt", join(cwd, "cross-relative-source", "link.txt"));
  await applyPatch(
    cwd,
    patch(
      "*** Update File: cross-relative-source/link.txt\n",
      "*** Move to: cross-relative-destination/link.txt\n",
      "*** Update File: cross-relative-destination/link.txt\n",
      "@@\n-cross destination\n+updated cross destination\n",
    ),
    undefined,
    {
      selectMoveStrategy: (sourcePath) =>
        sourcePath.includes("cross-relative-source") ? "copy-unlink" : "rename",
    },
  );
  assert.equal(
    await readFile(join(cwd, "cross-relative-source", "target.txt"), "utf8"),
    "cross source\n",
  );
  assert.equal(
    await readFile(join(cwd, "cross-relative-destination", "target.txt"), "utf8"),
    "updated cross destination\n",
  );
});

void test("evaluates repeated paths against sequential virtual state", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "text-a.txt"), "old\n");
  await writeFile(join(cwd, "pure-a.bin"), Buffer.from([0xff]));
  await writeFile(join(cwd, "consume-a.txt"), "before\n");
  await writeFile(join(cwd, "dead-delete-a.txt"), "moved\n");
  await writeFile(join(cwd, "dead-add-a.txt"), "moved\n");
  await writeFile(join(cwd, "recreate-a.txt"), "moved\n");
  await writeFile(join(cwd, "chain-a.bin"), Buffer.from([0x00, 0xff]));
  await writeFile(join(cwd, "overwrite-a.txt"), "first\n");
  await writeFile(join(cwd, "overwrite-c.txt"), "second\n");
  await writeFile(join(cwd, "back-a.txt"), "back\n");

  await applyPatch(
    cwd,
    patch(
      "*** Update File: text-a.txt\n*** Move to: text-b.txt\n@@\n-old\n+new\n",
      "*** Delete File: text-a.txt\n",
      "*** Update File: pure-a.bin\n*** Move to: pure-b.bin\n",
      "*** Delete File: pure-a.bin\n",
      "*** Update File: consume-a.txt\n*** Move to: consume-b.txt\n",
      "*** Update File: consume-b.txt\n@@\n-before\n+after\n",
      "*** Update File: dead-delete-a.txt\n*** Move to: dead-delete-b.txt\n",
      "*** Update File: dead-delete-a.txt\n@@\n-missing\n+ignored\n",
      "*** Delete File: dead-delete-a.txt\n",
      "*** Update File: dead-add-a.txt\n*** Move to: dead-add-b.txt\n",
      "*** Update File: dead-add-a.txt\n@@\n-missing\n+ignored\n",
      "*** Add File: dead-add-a.txt\n+replacement\n",
      "*** Update File: recreate-a.txt\n*** Move to: recreate-b.txt\n",
      "*** Add File: recreate-a.txt\n+created\n",
      "*** Update File: recreate-a.txt\n@@\n-created\n+updated\n",
      "*** Update File: chain-a.bin\n*** Move to: chain-b.bin\n",
      "*** Update File: chain-b.bin\n*** Move to: chain-c.bin\n",
      "*** Update File: overwrite-a.txt\n*** Move to: overwrite-b.txt\n",
      "*** Update File: overwrite-c.txt\n*** Move to: overwrite-b.txt\n",
      "*** Update File: back-a.txt\n*** Move to: back-b.txt\n",
      "*** Update File: back-b.txt\n*** Move to: back-a.txt\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "text-b.txt"), "utf8"), "new\n");
  assert.deepEqual(await readFile(join(cwd, "pure-b.bin")), Buffer.from([0xff]));
  assert.equal(await readFile(join(cwd, "consume-b.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "dead-add-a.txt"), "utf8"), "replacement\n");
  assert.equal(await readFile(join(cwd, "recreate-a.txt"), "utf8"), "updated\n");
  assert.deepEqual(await readFile(join(cwd, "chain-c.bin")), Buffer.from([0x00, 0xff]));
  assert.equal(await readFile(join(cwd, "overwrite-b.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(cwd, "back-a.txt"), "utf8"), "back\n");
});

void test("skips a failed move only when every entry effect is safely dominated", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source.txt"), "source\n");
  await writeFile(join(cwd, "destination.txt"), "destination\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: source.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-missing\n",
      "+unknown\n",
      "*** Add File: source.txt\n+new source\n",
      "*** Add File: destination.txt\n+new destination\n",
    ),
  );

  assert.equal(details.instructions?.[0]?.status, "dead");
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "new source\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new destination\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: source.txt\n",
        "*** Move to: nested/destination.txt\n",
        "@@\n",
        "-missing\n",
        "+unknown\n",
        "*** Delete File: source.txt\n",
        "*** Delete File: nested/destination.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "new source\n");
  await assertMissing(join(cwd, "nested"));
});

void test("rejects observed unknown updates and binary text edits before any writes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "a.txt"), "source\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Add File: should-not-exist.txt\n+blocked\n",
        "*** Update File: a.txt\n*** Move to: b.txt\n",
        "*** Update File: a.txt\n@@\n-missing\n+unknown\n",
        "*** Update File: a.txt\n*** Move to: c.txt\n",
        "*** Delete File: a.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "source\n");
  await assertMissing(join(cwd, "b.txt"));
  await assertMissing(join(cwd, "should-not-exist.txt"));

  await writeFile(join(cwd, "binary.bin"), Buffer.from([0xff]));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: binary.bin\n*** Move to: moved.bin\n",
        "*** Update File: moved.bin\n@@\n+text\n",
      ),
    ),
    /encoded data was not valid/,
  );
  assert.deepEqual(await readFile(join(cwd, "binary.bin")), Buffer.from([0xff]));
  await assertMissing(join(cwd, "moved.bin"));
});

void test("keeps empty files distinct from absent paths", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "only-line.txt"), "only line\n");

  await applyPatch(cwd, patch("*** Update File: only-line.txt\n@@\n-only line\n"));
  assert.deepEqual(await readFile(join(cwd, "only-line.txt")), Buffer.alloc(0));

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: absent.txt\n@@\n-only line\n")),
    ApplyPatchVerificationError,
  );
  const dead = await applyPatch(
    cwd,
    patch("*** Update File: absent.txt\n@@\n-only line\n", "*** Delete File: absent.txt\n"),
  );
  assert.deepEqual(dead.changes, []);
  await assertMissing(join(cwd, "absent.txt"));
});

void test("handles self moves, hard links, and proven repeated moves", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "self.bin"), Buffer.from([0xff]));
  await writeFile(join(cwd, "hard-a.txt"), "hard linked\n");
  await link(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  await writeFile(join(cwd, "repeat-a.txt"), "repeat\n");

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: self.bin\n*** Move to: ./self.bin\n",
      "*** Update File: hard-a.txt\n*** Move to: hard-b.txt\n",
      "*** Update File: repeat-a.txt\n*** Move to: repeat-b.txt\n",
      "*** Update File: repeat-a.txt\n*** Move to: repeat-b.txt\n",
    ),
  );

  assert.deepEqual(await readFile(join(cwd, "self.bin")), Buffer.from([0xff]));
  await assertMissing(join(cwd, "hard-a.txt"));
  assert.equal(await readFile(join(cwd, "hard-b.txt"), "utf8"), "hard linked\n");
  assert.equal(await readFile(join(cwd, "repeat-b.txt"), "utf8"), "repeat\n");
  assert.equal(details.changes.length, 2);
});

void test("preserves hard-link observations across sequential content writes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "alias-a.txt"), "before\n");
  await link(join(cwd, "alias-a.txt"), join(cwd, "alias-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: alias-a.txt\n@@\n-before\n+after\n",
      "*** Update File: alias-b.txt\n@@\n-after\n+final\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "alias-a.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias-b.txt"), "utf8"), "final\n");
});

void test("follows symlinks for updates but replaces them for adds", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "before\n");
  await symlink("target.txt", join(cwd, "alias.txt"));

  const details = await applyPatch(
    cwd,
    patch(
      "*** Update File: alias.txt\n@@\n-before\n+after\n",
      "*** Update File: target.txt\n@@\n-after\n+final\n",
      "*** Add File: alias.txt\n+independent\n",
      "*** Update File: alias.txt\n@@\n-independent\n+done\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias.txt"), "utf8"), "done\n");
  await assert.rejects(readlink(join(cwd, "alias.txt")), { code: "EINVAL" });
  const feedback = formatApplyPatchSummary(details, cwd);
  assert.match(feedback, /1\. APPLIED - Update alias\.txt - Updated the link target/u);
  assert.match(
    feedback,
    /3\. APPLIED - Add alias\.txt - Replaced alias\.txt; Link target for alias\.txt was unchanged\./u,
  );
});

void test("replaces live and dangling symlinks on add without touching their targets", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "same\n");
  await symlink("target.txt", join(cwd, "live.txt"));
  await symlink("missing.txt", join(cwd, "dangling.txt"));

  const details = await applyPatch(
    cwd,
    patch("*** Add File: live.txt\n+same\n", "*** Add File: dangling.txt\n+created here\n"),
  );

  assert.equal(details.exact, true);
  assert.equal(await readFile(join(cwd, "live.txt"), "utf8"), "same\n");
  assert.equal(await readFile(join(cwd, "dangling.txt"), "utf8"), "created here\n");
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "same\n");
  await assertMissing(join(cwd, "missing.txt"));
  await assert.rejects(readlink(join(cwd, "live.txt")), { code: "EINVAL" });
  await assert.rejects(readlink(join(cwd, "dangling.txt")), { code: "EINVAL" });
});

void test("tracks symlink chains and rejects links made dangling earlier in the patch", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "before\n");
  await symlink("target.txt", join(cwd, "middle.txt"));
  await symlink("middle.txt", join(cwd, "outer.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: outer.txt\n@@\n-before\n+after\n",
      "*** Update File: middle.txt\n@@\n-after\n+final\n",
    ),
  );
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");

  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Delete File: target.txt\n",
        "*** Update File: outer.txt\n@@\n-final\n+should not happen\n",
      ),
    ),
    /symbolic link target does not exist/,
  );
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "final\n");
});

void test("proves dead updates across symlink, hard-link, and path aliases", async (t) => {
  const cwd = await workspace(t);

  await writeFile(join(cwd, "symlink-target.txt"), "before\n");
  await symlink("symlink-target.txt", join(cwd, "symlink-alias.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: symlink-alias.txt\n@@\n-missing\n+after\n",
        "*** Delete File: symlink-alias.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "symlink-target.txt"), "utf8"), "before\n");
  assert.equal(await readlink(join(cwd, "symlink-alias.txt")), "symlink-target.txt");

  await writeFile(join(cwd, "hard-a.txt"), "before\n");
  await link(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: hard-a.txt\n@@\n-missing\n+after\n", "*** Delete File: hard-a.txt\n"),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "hard-a.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "hard-b.txt"), "utf8"), "before\n");

  await writeFile(join(cwd, "dominated-target.txt"), "before\n");
  await symlink("dominated-target.txt", join(cwd, "dominated-alias.txt"));
  const symlinkTargetDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: dominated-alias.txt\n@@\n-missing\n+after\n",
      "*** Delete File: dominated-target.txt\n",
    ),
  );
  assert.deepEqual(
    symlinkTargetDominated.instructions?.map(({ status }) => status),
    ["dead", "applied"],
  );
  await assertMissing(join(cwd, "dominated-target.txt"));
  assert.equal(await readlink(join(cwd, "dominated-alias.txt")), "dominated-target.txt");

  await writeFile(join(cwd, "all-hard-a.txt"), "before\n");
  await link(join(cwd, "all-hard-a.txt"), join(cwd, "all-hard-b.txt"));
  const allHardLinksDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: all-hard-a.txt\n@@\n-missing\n+after\n",
      "*** Delete File: all-hard-a.txt\n",
      "*** Delete File: all-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    allHardLinksDominated.instructions?.map(({ status }) => status),
    ["dead", "applied", "applied"],
  );
  await assertMissing(join(cwd, "all-hard-a.txt"));
  await assertMissing(join(cwd, "all-hard-b.txt"));

  await writeFile(join(cwd, "prior-hard-a.txt"), "before\n");
  await link(join(cwd, "prior-hard-a.txt"), join(cwd, "prior-hard-b.txt"));
  const priorHardLinkRemoved = await applyPatch(
    cwd,
    patch(
      "*** Delete File: prior-hard-a.txt\n",
      "*** Update File: prior-hard-b.txt\n@@\n-missing\n+after\n",
      "*** Delete File: prior-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    priorHardLinkRemoved.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  await assertMissing(join(cwd, "prior-hard-a.txt"));
  await assertMissing(join(cwd, "prior-hard-b.txt"));

  await writeFile(join(cwd, "replaced-hard-a.txt"), "before\n");
  await link(join(cwd, "replaced-hard-a.txt"), join(cwd, "replaced-hard-b.txt"));
  const priorHardLinkReplaced = await applyPatch(
    cwd,
    patch(
      "*** Add File: replaced-hard-a.txt\n+independent\n",
      "*** Update File: replaced-hard-b.txt\n@@\n-missing\n+after\n",
      "*** Delete File: replaced-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    priorHardLinkReplaced.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  assert.equal(await readFile(join(cwd, "replaced-hard-a.txt"), "utf8"), "independent\n");
  await assertMissing(join(cwd, "replaced-hard-b.txt"));

  await writeFile(join(cwd, "replayed-hard-a.txt"), "old\n");
  await link(join(cwd, "replayed-hard-a.txt"), join(cwd, "replayed-hard-b.txt"));
  const replayedFutureState = await applyPatch(
    cwd,
    patch(
      "*** Update File: replayed-hard-a.txt\n@@\n-missing\n+ignored\n",
      "*** Delete File: replayed-hard-a.txt\n",
      "*** Add File: replayed-hard-a.txt\n+old\n",
      "*** Delete File: replayed-hard-b.txt\n",
    ),
  );
  assert.deepEqual(
    replayedFutureState.instructions?.map(({ status }) => status),
    ["dead", "applied", "applied", "applied"],
  );
  assert.deepEqual(replayedFutureState.instructions?.[0]?.reason?.dominatingInstructions, [2, 4]);
  assert.equal(await readFile(join(cwd, "replayed-hard-a.txt"), "utf8"), "old\n");
  assert.equal((await stat(join(cwd, "replayed-hard-a.txt"))).nlink, 1);
  await assertMissing(join(cwd, "replayed-hard-b.txt"));

  const plannedEntryDominated = await applyPatch(
    cwd,
    patch(
      "*** Add File: planned-entry.txt\n+known\n",
      "*** Update File: planned-entry.txt\n@@\n-missing\n+after\n",
      "*** Delete File: planned-entry.txt\n",
    ),
  );
  assert.deepEqual(
    plannedEntryDominated.instructions?.map(({ status }) => status),
    ["applied", "dead", "applied"],
  );
  await assertMissing(join(cwd, "planned-entry.txt"));

  await writeFile(join(cwd, "moved-hard-a.txt"), "before\n");
  await link(join(cwd, "moved-hard-a.txt"), join(cwd, "moved-hard-b.txt"));
  await assert.rejects(
    applyPatch(
      cwd,
      patch(
        "*** Update File: moved-hard-a.txt\n*** Move to: moved-hard-c.txt\n",
        "*** Update File: moved-hard-b.txt\n@@\n-missing\n+after\n",
        "*** Delete File: moved-hard-b.txt\n",
      ),
    ),
    ApplyPatchVerificationError,
  );
  assert.equal(await readFile(join(cwd, "moved-hard-a.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "moved-hard-b.txt"), "utf8"), "before\n");
  await assertMissing(join(cwd, "moved-hard-c.txt"));

  await mkdir(join(cwd, "real-parent"));
  await symlink("real-parent", join(cwd, "alias-parent"));
  await writeFile(join(cwd, "real-parent", "file.txt"), "before\n");
  const parentAliasDominated = await applyPatch(
    cwd,
    patch(
      "*** Update File: alias-parent/file.txt\n@@\n-missing\n+after\n",
      "*** Delete File: real-parent/file.txt\n",
    ),
  );
  assert.deepEqual(
    parentAliasDominated.instructions?.map(({ status }) => status),
    ["dead", "applied"],
  );
  await assertMissing(join(cwd, "real-parent", "file.txt"));
});

void test("materializes state-changing symlink moves without modifying either target", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source-target.txt"), "source old\n");
  await writeFile(join(cwd, "destination-target.txt"), "destination old\n");
  await symlink("source-target.txt", join(cwd, "source-link.txt"));
  await symlink("destination-target.txt", join(cwd, "destination-link.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: source-link.txt\n",
      "*** Move to: destination-link.txt\n",
      "@@\n",
      "-source old\n",
      "+moved new\n",
    ),
  );

  await assertMissing(join(cwd, "source-link.txt"));
  assert.equal(await readFile(join(cwd, "destination-link.txt"), "utf8"), "moved new\n");
  await assert.rejects(readlink(join(cwd, "destination-link.txt")), { code: "EINVAL" });
  assert.equal(await readFile(join(cwd, "source-target.txt"), "utf8"), "source old\n");
  assert.equal(await readFile(join(cwd, "destination-target.txt"), "utf8"), "destination old\n");
});

void test("moves dangling symlink entries opaquely", async (t) => {
  const cwd = await workspace(t);
  await symlink("missing-source-target", join(cwd, "source-link"));
  await symlink("missing-destination-target", join(cwd, "destination-link"));

  await applyPatch(cwd, patch("*** Update File: source-link\n*** Move to: destination-link\n"));

  await assertMissing(join(cwd, "source-link"));
  assert.equal(await readlink(join(cwd, "destination-link")), "missing-source-target");
  await assertMissing(join(cwd, "missing-source-target"));
  await assertMissing(join(cwd, "missing-destination-target"));
});

void test("preserves hard-link semantics across replacements, moves, and planned unlinks", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "add-a.txt"), "old add\n");
  await chmod(join(cwd, "add-a.txt"), 0o754);
  await link(join(cwd, "add-a.txt"), join(cwd, "add-b.txt"));

  await writeFile(join(cwd, "move-a.txt"), "old move\n");
  await chmod(join(cwd, "move-a.txt"), 0o751);
  await link(join(cwd, "move-a.txt"), join(cwd, "move-b.txt"));
  await writeFile(join(cwd, "destination.txt"), "old destination\n");
  await link(join(cwd, "destination.txt"), join(cwd, "destination-b.txt"));

  await writeFile(join(cwd, "delete-a.txt"), "delete then update\n");
  await link(join(cwd, "delete-a.txt"), join(cwd, "delete-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Add File: add-a.txt\n+new add\n",
      "*** Update File: move-a.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-old move\n",
      "+new move\n",
      "*** Delete File: delete-a.txt\n",
      "*** Update File: delete-b.txt\n@@\n-delete then update\n+updated survivor\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "add-a.txt"), "utf8"), "new add\n");
  assert.equal(await readFile(join(cwd, "add-b.txt"), "utf8"), "old add\n");
  assert.notEqual(
    (await stat(join(cwd, "add-a.txt"))).ino,
    (await stat(join(cwd, "add-b.txt"))).ino,
  );
  assert.equal((await stat(join(cwd, "add-a.txt"))).mode & 0o777, 0o754);

  await assertMissing(join(cwd, "move-a.txt"));
  assert.equal(await readFile(join(cwd, "move-b.txt"), "utf8"), "old move\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new move\n");
  assert.equal(await readFile(join(cwd, "destination-b.txt"), "utf8"), "old destination\n");
  assert.equal((await stat(join(cwd, "destination.txt"))).mode & 0o777, 0o751);
  assert.notEqual(
    (await stat(join(cwd, "destination.txt"))).ino,
    (await stat(join(cwd, "destination-b.txt"))).ino,
  );

  await assertMissing(join(cwd, "delete-a.txt"));
  assert.equal(await readFile(join(cwd, "delete-b.txt"), "utf8"), "updated survivor\n");
});

void test("keeps hard-link topology for no-op adds and pure native moves", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "same-a.txt"), "same\n");
  await link(join(cwd, "same-a.txt"), join(cwd, "same-b.txt"));

  await writeFile(join(cwd, "source-a.txt"), "source\n");
  await link(join(cwd, "source-a.txt"), join(cwd, "source-b.txt"));
  await writeFile(join(cwd, "destination-a.txt"), "destination\n");
  await link(join(cwd, "destination-a.txt"), join(cwd, "destination-b.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Add File: same-a.txt\n+same\n",
      "*** Update File: source-a.txt\n*** Move to: destination-a.txt\n",
    ),
  );

  assert.equal(
    (await stat(join(cwd, "same-a.txt"))).ino,
    (await stat(join(cwd, "same-b.txt"))).ino,
  );
  await assertMissing(join(cwd, "source-a.txt"));
  assert.equal(await readFile(join(cwd, "destination-a.txt"), "utf8"), "source\n");
  assert.equal(await readFile(join(cwd, "source-b.txt"), "utf8"), "source\n");
  assert.equal(
    (await stat(join(cwd, "destination-a.txt"))).ino,
    (await stat(join(cwd, "source-b.txt"))).ino,
  );
  assert.equal(await readFile(join(cwd, "destination-b.txt"), "utf8"), "destination\n");
  assert.notEqual(
    (await stat(join(cwd, "destination-a.txt"))).ino,
    (await stat(join(cwd, "destination-b.txt"))).ino,
  );
});

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

  await writeFile(join(cwd, "installed-source.txt"), "installed\n");
  await assert.rejects(
    applyPatch(
      cwd,
      patch("*** Update File: installed-source.txt\n*** Move to: installed-destination.txt\n"),
      undefined,
      {
        selectMoveStrategy: () => "copy-unlink",
        filesystem: {
          async unlink(path) {
            if (path === join(cwd, "installed-source.txt")) {
              throw filesystemError("EACCES", "injected source removal failure");
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
      assert.match(feedback, /Files changed:\nA installed-destination\.txt/u);
      assert.match(
        feedback,
        /1\. FAILED - Move installed-source\.txt -> installed-destination\.txt - Created installed-destination\.txt; installed-source\.txt remains; Move failed: injected source removal failure\./u,
      );
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as unknown as Theme;
      const tui = new ApplyPatchDiffComponent(error.details, theme, cwd, true)
        .render(120)
        .join("\n");
      assert.match(tui, /A installed-destination\.txt/u);
      assert.match(tui, /Created installed-destination\.txt/u);
      assert.doesNotMatch(tui, /Moved installed-source\.txt/u);
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "installed-source.txt"), "utf8"), "installed\n");
  assert.equal(await readFile(join(cwd, "installed-destination.txt"), "utf8"), "installed\n");

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
              throw filesystemError("EACCES", "injected replacement source removal failure");
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
      assert.match(feedback, /Replaced replaced-destination\.txt; replaced-source\.txt remains/u);
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
              throw filesystemError("EACCES", "injected source removal failure");
            }
            await unlink(path);
          },
          lstat: (async (path) => {
            if (path === join(cwd, "unverified-move-destination.txt")) {
              throw filesystemError("EIO", "injected final-state inspection failure");
            }
            return lstat(path);
          }) as typeof lstat,
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
              throw filesystemError("EACCES", "injected text-move source removal failure");
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
        /1\. FAILED - Update text-move-source\.txt -> text-move-destination\.txt - Created text-move-destination\.txt; text-move-source\.txt remains; Source removal failed: injected text-move source removal failure\./u,
      );
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "text-move-source.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "text-move-destination.txt"), "utf8"), "after\n");

  await writeFile(join(cwd, "removed-source.txt"), "source\n");
  await writeFile(join(cwd, "removed-destination.txt"), "destination\n");
  let failedInstallAttempts = 0;
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
              failedInstallAttempts += 1;
              if (failedInstallAttempts === 1) {
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
        /2\. FAILED - Move removed-source\.txt -> removed-destination\.txt - Deleted removed-destination\.txt; removed-source\.txt remains; Move failed: injected destination replacement failure\./u,
      );
      assert.match(feedback, /3\. NOT RUN - Add not-run\.txt - Instruction 2 failed\./u);
      return true;
    },
  );
  assert.equal(await readFile(join(cwd, "committed-prefix.txt"), "utf8"), "committed\n");
  assert.equal(await readFile(join(cwd, "removed-source.txt"), "utf8"), "source\n");
  await assertMissing(join(cwd, "removed-destination.txt"));
  await assertMissing(join(cwd, "not-run.txt"));

  await writeFile(join(cwd, "windows-source.txt"), "source\n");
  await writeFile(join(cwd, "windows-destination.txt"), "old destination\n");
  let windowsInstallAttempts = 0;
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
            windowsInstallAttempts += 1;
            if (windowsInstallAttempts === 1) {
              throw filesystemError("EPERM", "injected Windows rename-over-existing behavior");
            }
          }
          await rename(source, destination);
        },
      },
    },
  );
  assert.equal(windowsReplacement.exact, true);
  assert.equal(windowsInstallAttempts, 2);
  await assertMissing(join(cwd, "windows-source.txt"));
  assert.equal(await readFile(join(cwd, "windows-destination.txt"), "utf8"), "source\n");
});

void test("reports deterministic file states after write failures", async (t) => {
  const cwd = await workspace(t);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
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
        /Write failed: injected requested write failure; requested\.txt contains the requested content\./u,
    },
    {
      name: "different",
      before: "before\n",
      mutate: true,
      mutation: "different\n",
      summary: /Files changed:\nM different\.txt/u,
      result:
        /Write failed: injected different write failure; different\.txt contains unexpected content\./u,
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
          readFile: (async (target, options) => {
            if (target === unverifiedPath) {
              throw filesystemError("EIO", "injected final-state read failure");
            }
            return readFile(target, options);
          }) as typeof readFile,
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
  } as unknown as Theme;

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
        /2\. FAILED - Delete planned-delete\.txt - Delete failed: injected planned delete failure; planned-delete\.txt is unchanged\./u,
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

void test("does not expose missing previous-content history to the model", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "unreadable.txt");
  await writeFile(target, "private\n");
  await chmod(target, 0);

  const details = await applyPatch(cwd, patch("*** Add File: unreadable.txt\n+replacement\n"));
  const feedback = formatApplyPatchSummary(details, cwd);
  await chmod(target, 0o600);
  assert.equal(await readFile(target, "utf8"), "replacement\n");
  assert.match(feedback, /A unreadable\.txt/u);
  assert.match(feedback, /1\. APPLIED - Add unreadable\.txt/u);
  assert.doesNotMatch(feedback, /previous content|diff|history|Committed prefix|exact|inexact/u);
});

void test("serializes same-process filesystem aliases with deterministic logical keys", async (t) => {
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

void test("honors cancellation before, during, and between apply_patch phases", async (t) => {
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
  const matcherSignal = {
    get aborted() {
      signalReads += 1;
      return signalReads >= 6;
    },
  } as AbortSignal;
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

void test(
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

void test("deletes symbolic-link entries without deleting their targets", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "preserved\n");
  await symlink("target.txt", join(cwd, "alias.txt"));

  const direct = await applyPatch(cwd, patch("*** Delete File: alias.txt\n"));

  await assertMissing(join(cwd, "alias.txt"));
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "preserved\n");
  assert.deepEqual(direct.changes, [
    {
      kind: "delete",
      path: "alias.txt",
      entryType: "symbolic-link",
      displayDiff: "",
      additions: 0,
      deletions: 0,
    },
  ]);

  await symlink("missing.txt", join(cwd, "dangling.txt"));
  const dangling = await applyPatch(cwd, patch("*** Delete File: dangling.txt\n"));
  assert.equal(
    dangling.changes[0]?.kind === "delete" ? dangling.changes[0].entryType : undefined,
    "symbolic-link",
  );
  await assertMissing(join(cwd, "dangling.txt"));

  await writeFile(join(cwd, "followed-target.txt"), "old target\n");
  await symlink("followed-target.txt", join(cwd, "followed-link.txt"));
  const followed = await applyPatch(
    cwd,
    patch(
      "*** Update File: followed-link.txt\n@@\n-old target\n+new target\n",
      "*** Delete File: followed-link.txt\n",
    ),
  );
  assert.equal(await readFile(join(cwd, "followed-target.txt"), "utf8"), "new target\n");
  await assertMissing(join(cwd, "followed-link.txt"));
  assert.deepEqual(followed.changes[1], {
    kind: "delete",
    path: "followed-link.txt",
    entryType: "symbolic-link",
    displayDiff: "",
    additions: 0,
    deletions: 0,
  });
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const rendered = formatApplyPatchRenderText(followed, theme, cwd);
  assert.match(rendered, /followed-link\.txt \(deleted symbolic link\)/u);
  assert.doesNotMatch(JSON.stringify(followed.changes[1]), /old target|new target/u);
});

void test("does not dereference cyclic symlinks for entry-only operations or no-ops", async (t) => {
  const cwd = await workspace(t);
  const createCycle = async (prefix: string): Promise<void> => {
    await symlink(`${prefix}-b`, join(cwd, `${prefix}-a`));
    await symlink(`${prefix}-a`, join(cwd, `${prefix}-b`));
  };

  await createCycle("empty");
  const empty = await applyPatch(cwd, patch("*** Update File: empty-a\n"));
  assert.equal(empty.instructions?.[0]?.reason?.code, "empty-update");
  assert.equal(await readlink(join(cwd, "empty-a")), "empty-b");

  await createCycle("identity");
  const identity = await applyPatch(cwd, patch("*** Update File: identity-a\n@@\n-same\n+same\n"));
  assert.equal(identity.instructions?.[0]?.reason?.code, "identity-update");
  assert.equal(await readlink(join(cwd, "identity-a")), "identity-b");

  await createCycle("text");
  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: text-a\n@@\n-old\n+new\n")),
    /symbolic link cycle/u,
  );

  await createCycle("add");
  await applyPatch(cwd, patch("*** Add File: add-a\n+replacement\n"));
  assert.equal(await readFile(join(cwd, "add-a"), "utf8"), "replacement\n");
  assert.equal(await readlink(join(cwd, "add-b")), "add-a");

  await createCycle("delete");
  await applyPatch(cwd, patch("*** Delete File: delete-a\n"));
  await assertMissing(join(cwd, "delete-a"));
  assert.equal(await readlink(join(cwd, "delete-b")), "delete-a");

  await createCycle("move");
  await applyPatch(cwd, patch("*** Update File: move-a\n*** Move to: moved-link\n"));
  await assertMissing(join(cwd, "move-a"));
  assert.equal(await readlink(join(cwd, "moved-link")), "move-b");
  assert.equal(await readlink(join(cwd, "move-b")), "move-a");

  await writeFile(join(cwd, "destination-source.txt"), "source\n");
  await createCycle("destination");
  await applyPatch(
    cwd,
    patch("*** Update File: destination-source.txt\n", "*** Move to: destination-a\n"),
  );
  await assertMissing(join(cwd, "destination-source.txt"));
  assert.equal(await readFile(join(cwd, "destination-a"), "utf8"), "source\n");
  assert.equal(await readlink(join(cwd, "destination-b")), "destination-a");
});

void test("shares virtual state through a symlinked parent without moving the entry twice", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));
  await writeFile(join(cwd, "real", "file.txt"), "before\n");

  await applyPatch(
    cwd,
    patch(
      "*** Update File: real/file.txt\n@@\n-before\n+after\n",
      "*** Update File: alias/file.txt\n@@\n-after\n+final\n",
      "*** Update File: real/file.txt\n*** Move to: alias/file.txt\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "real", "file.txt"), "utf8"), "final\n");
  assert.equal(await readFile(join(cwd, "alias", "file.txt"), "utf8"), "final\n");
  assert.deepEqual(await readdir(join(cwd, "real")), ["file.txt"]);
});

void test("updates same-entry moves safely through a symlinked parent", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "real"));
  await symlink("real", join(cwd, "alias"));
  await writeFile(join(cwd, "real", "file.txt"), "before\n");
  await link(join(cwd, "real", "file.txt"), join(cwd, "other-link.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: real/file.txt\n",
      "*** Move to: alias/file.txt\n",
      "@@\n",
      "-before\n",
      "+after\n",
    ),
  );

  assert.equal(await readFile(join(cwd, "real", "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "other-link.txt"), "utf8"), "before\n");
  assert.notEqual(
    (await stat(join(cwd, "real", "file.txt"))).ino,
    (await stat(join(cwd, "other-link.txt"))).ino,
  );
});

void test("replaces a destination symlink that points back to the move source", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "source.txt"), "old\n");
  await symlink("source.txt", join(cwd, "destination.txt"));

  await applyPatch(
    cwd,
    patch(
      "*** Update File: source.txt\n",
      "*** Move to: destination.txt\n",
      "@@\n",
      "-old\n",
      "+new\n",
    ),
  );

  await assertMissing(join(cwd, "source.txt"));
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new\n");
  await assert.rejects(readlink(join(cwd, "destination.txt")), { code: "EINVAL" });
});

void test(
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

void test(
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

void test("rejects directories and unproven missing-source moves", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "directory"));
  await writeFile(join(cwd, "destination.txt"), "unrelated\n");

  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: directory\n*** Move to: moved-directory\n")),
    /source is a directory/,
  );
  await assert.rejects(
    applyPatch(cwd, patch("*** Update File: missing.txt\n*** Move to: destination.txt\n")),
    /destination provenance is unproven/,
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

void test("detects external drift after preflight and before mutation", async (t) => {
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

void test("detects external changes to text content and planned parent paths", async (t) => {
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

void test("renders opaque moves as path-only structured history", async (t) => {
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
  } as unknown as Theme;
  const rendered = formatApplyPatchRenderText(details as ApplyPatchDetails, theme, cwd);
  assert.match(
    rendered,
    /• Moved binary\.bin → old-target\.bin \(replaced destination\) \(\+0 -0\)/,
  );
  assert.doesNotMatch(rendered, /\ufffd/);
});
