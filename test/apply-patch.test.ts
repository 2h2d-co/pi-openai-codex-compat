import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerApplyPatch, {
  APPLY_PATCH_LARK_GRAMMAR,
  applyPatch,
  parsePatch,
} from "../extensions/openai-codex-compat/apply-patch.ts";

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-apply-patch-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

void test("parses and applies add, update, and delete hunks", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/current.txt"), "alpha\ntarget\nomega\n");
  await writeFile(join(cwd, "obsolete.txt"), "remove me\n");

  const patch = `*** Begin Patch
*** Add File: src/added.txt
+created
*** Update File: src/current.txt
@@ target
-omega
+replacement
*** Delete File: obsolete.txt
*** End Patch`;
  const operations = parsePatch(patch);
  assert.deepEqual(
    operations.map((operation) => operation.kind),
    ["add", "update", "delete"],
  );
  assert.equal(
    parsePatch("*** Begin Patch\n*** Add File: @scope.txt\n+content\n*** End Patch")[0]?.path,
    "@scope.txt",
  );

  const details = await applyPatch(cwd, patch);
  assert.deepEqual(details, {
    added: ["src/added.txt"],
    updated: ["src/current.txt"],
    deleted: ["obsolete.txt"],
  });
  assert.equal(await readFile(join(cwd, "src/added.txt"), "utf8"), "created\n");
  assert.equal(
    await readFile(join(cwd, "src/current.txt"), "utf8"),
    "alpha\ntarget\nreplacement\n",
  );
  await assert.rejects(readFile(join(cwd, "obsolete.txt"), "utf8"), { code: "ENOENT" });
});

void test("supports end-of-file updates and moves", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "before.txt"), "first\nlast\n");

  const details = await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
-last
+changed
*** End of File
*** End Patch`,
  );

  assert.deepEqual(details.updated, ["before.txt -> nested/after.txt"]);
  assert.equal(await readFile(join(cwd, "nested/after.txt"), "utf8"), "first\nchanged\n");
  await assert.rejects(readFile(join(cwd, "before.txt"), "utf8"), { code: "ENOENT" });
});

void test("validates every hunk before writing and rejects workspace escapes", async (t) => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "current.txt"), "original\n");

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: created.txt
+should not be written
*** Update File: current.txt
@@
-missing
+replacement
*** End Patch`,
    ),
    /Failed to find expected lines/,
  );
  await assert.rejects(readFile(join(cwd, "created.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "current.txt"), "utf8"), "original\n");

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: ../escape.txt
+blocked
*** End Patch`,
    ),
    /escapes the working directory/,
  );
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Add File: .git/config
+blocked
*** End Patch`,
    ),
    /Git metadata/,
  );
});

void test("rejects symlink escapes and duplicate aliases", async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(cwd, "current.txt"), "original\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git/config"), "protected\n");
  await symlink(join(cwd, "current.txt"), join(cwd, "alias.txt"));
  await symlink(join(outside, "secret.txt"), join(cwd, "outside.txt"));
  await symlink(join(cwd, ".git"), join(cwd, "metadata"));

  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: current.txt
@@
-original
+first
*** Update File: alias.txt
@@
-original
+second
*** End Patch`,
    ),
    /multiple path aliases/,
  );
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: outside.txt
@@
-secret
+exposed
*** End Patch`,
    ),
    /resolves outside the working directory/,
  );
  await assert.rejects(
    applyPatch(
      cwd,
      `*** Begin Patch
*** Update File: metadata/config
@@
-protected
+exposed
*** End Patch`,
    ),
    /Git metadata/,
  );
});

void test("registers apply_patch as a sequential OpenAI grammar tool", () => {
  let registered: ToolDefinition | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;

  registerApplyPatch(pi);

  assert.equal(registered?.name, "apply_patch");
  assert.equal(registered?.executionMode, "sequential");
  assert.deepEqual(registered?.constrainedSampling, {
    type: "grammar",
    variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
  });
});
