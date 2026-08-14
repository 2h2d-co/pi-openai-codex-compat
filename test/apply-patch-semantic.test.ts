import assert from "node:assert/strict";
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
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchVerificationError,
  formatApplyPatchSummary,
  parsePatch,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import { formatApplyPatchRenderText } from "../extensions/openai-codex-compat/apply-patch-render.ts";

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
  assert.equal(formatApplyPatchSummary(details), "Success. No files were changed.\n");
  const after = await stat(join(cwd, "same.txt"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
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

  await applyPatch(
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

void test("deletes symbolic-link entries without deleting their targets", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "target.txt"), "preserved\n");
  await symlink("target.txt", join(cwd, "alias.txt"));

  await applyPatch(cwd, patch("*** Delete File: alias.txt\n"));

  await assertMissing(join(cwd, "alias.txt"));
  assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "preserved\n");
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
