import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
