import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyPatch,
  ApplyPatchVerificationError,
  parsePatch,
} from "../extensions/openai-codex-compat/apply-patch-engine.ts";
import { findSequence } from "../extensions/openai-codex-compat/apply-patch-matcher/apply-patch-matcher-line-matching.ts";

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-strict-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function rejectWithoutWrite(
  cwd: string,
  path: string,
  content: string,
  patch: string,
  expected: RegExp,
): Promise<void> {
  const absolutePath = join(cwd, path);
  await writeFile(absolutePath, content);
  await assert.rejects(applyPatch(cwd, patch), (error: unknown) => {
    assert.ok(error instanceof ApplyPatchVerificationError);
    assert.match(error.message, expected);
    return true;
  });
  assert.equal(await readFile(absolutePath, "utf8"), content);
}

test("matches official Codex tiers in priority order", () => {
  assert.equal(findSequence(["target"], ["target"], 0, false), 0);
  assert.equal(findSequence(["target  "], ["target"], 0, false), 0);
  assert.equal(findSequence(["  target  "], ["target"], 0, false), 0);
  assert.equal(findSequence(["“target” — value"], ['"target" - value'], 0, false), 0);
  assert.equal(findSequence(["target\u0085"], ["target"], 0, false), 0);

  // Official Codex searches a complete tier before trying the next tier.
  assert.equal(findSequence(["  target", "other", "target"], ["target"], 0, false), 2);
  // Within the selected tier, official Codex uses the first location.
  assert.equal(findSequence(["  target", "  target"], ["target"], 0, false), 0);
});

test("matches official Codex empty, oversized, cursor, and EOF behavior", () => {
  assert.equal(findSequence(["one"], [], 1, false), 1);
  assert.equal(findSequence(["one"], ["one", "two"], 0, false), undefined);
  assert.equal(findSequence(["target", "target"], ["target"], 1, false), 1);
  assert.equal(findSequence(["target", "tail"], ["target"], 0, true), undefined);
  assert.equal(findSequence(["target", "tail"], ["tail"], 0, true), 1);
  // The official EOF search starts at the final legal position, even when it
  // precedes the current cursor.
  assert.equal(findSequence(["target", "tail"], ["tail"], 2, true), 1);
});

test("retains parsed context, addition, and deletion roles for strict writes", () => {
  const operation = parsePatch(`*** Begin Patch
*** Update File: sample.ts
@@
 before
-old
+new
 after
*** End Patch`)[0];

  assert.equal(operation?.kind, "update");
  if (operation?.kind !== "update") return;
  assert.deepEqual(operation.chunks[0]?.lines, [
    { kind: "context", text: "before" },
    { kind: "delete", text: "old" },
    { kind: "add", text: "new" },
    { kind: "context", text: "after" },
  ]);
});

test("uses anchors as official forward-search checkpoints", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "anchored.txt"), "target\nanchor\ntarget\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: anchored.txt
@@ anchor
-target
+changed
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "anchored.txt"), "utf8"), "target\nanchor\nchanged\n");
});

test("retains official anchor-only insertion placement at EOF", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "insert.txt"), "anchor\ntail\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: insert.txt
@@ anchor
+inserted
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "insert.txt"), "utf8"), "anchor\ntail\ninserted\n");
});

test("rejects an old sequence interrupted by an unmentioned line", async (t) => {
  const cwd = await workspace(t);
  const content = [
    "repositories/dce-id",
    "repositories/dce-notification",
    "repositories/dge-blackgate",
    "repositories/dge-rest",
    "repositories/dge-stream-manger",
    "",
  ].join("\n");

  await rejectWithoutWrite(
    cwd,
    "AGENTS.md",
    content,
    `*** Begin Patch
*** Update File: AGENTS.md
@@
 repositories/dce-id
 repositories/dce-notification
+repositories/dge-database2
 repositories/dge-rest
 repositories/dge-stream-manger
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("requires explicit EOF updates to match the file tail", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "tail.txt",
    "target\nnot-the-end\n",
    `*** Begin Patch
*** Update File: tail.txt
@@
-target
+changed
*** End of File
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("retries without the official trailing-newline sentinel", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "newline.txt"), "tail\n");

  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: newline.txt
@@
-tail
-
+new tail
+
*** End Patch`,
  );

  assert.equal(await readFile(join(cwd, "newline.txt"), "utf8"), "new tail\n");
});

test("preserves local line endings after strict matching", async (t) => {
  const cwd = await workspace(t);

  await writeFile(join(cwd, "single.txt"), "old\r\nnext\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: single.txt
@@
-old
+new
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "single.txt"), "utf8"), "new\r\nnext\r\n");

  await writeFile(join(cwd, "multi.txt"), "head\r\nold one\r\nold two\r\ntail\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: multi.txt
@@
 head
-old one
-old two
+new one
+new two
 tail
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "multi.txt"), "utf8"),
    "head\r\nnew one\r\nnew two\r\ntail\r\n",
  );

  await writeFile(join(cwd, "insert-crlf.txt"), "before\r\nafter\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: insert-crlf.txt
@@
 before
+inserted
 after
*** End Patch`,
  );
  assert.equal(
    await readFile(join(cwd, "insert-crlf.txt"), "utf8"),
    "before\r\ninserted\r\nafter\r\n",
  );

  await writeFile(join(cwd, "mixed.txt"), "one\r\ntwo\nthree\r\n");
  await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: mixed.txt
@@
-two
+changed
*** End Patch`,
  );
  assert.equal(await readFile(join(cwd, "mixed.txt"), "utf8"), "one\r\nchanged\nthree\r\n");
});
