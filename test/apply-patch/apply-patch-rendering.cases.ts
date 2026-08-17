import {
  assert,
  mkdir,
  readFile,
  writeFile,
  homedir,
  join,
  parse,
  test,
  applyPatch,
  parsePatch,
  previewPatch,
  formatApplyPatchRenderText,
  workspace,
  type Theme,
  type ApplyPatchDetails,
} from "./apply-patch-harness.ts";

void test("renders paths relative to cwd, home-abbreviated, or absolute", async (t) => {
  const cwd = await workspace(t);
  const localPath = join(cwd, "nested", "local.ts");
  const homePath = join(homedir(), ".pi-codex-render-home.ts");
  const externalPath = join(parse(cwd).root, "pi-codex-render-external.ts");
  const details: ApplyPatchDetails = {
    status: "completed",
    exact: true,
    changes: [
      {
        kind: "add",
        path: localPath,
        content: "local\n",
        displayDiff: "+1 local",
        additions: 1,
        deletions: 0,
      },
      {
        kind: "update",
        path: homePath,
        moveTo: externalPath,
        oldContent: "before\n",
        newContent: "after\n",
        displayDiff: "-1 before\n+1 after",
        additions: 1,
        deletions: 1,
      },
    ],
    added: [localPath],
    modified: [externalPath],
    deleted: [],
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;

  const rendered = formatApplyPatchRenderText(details, theme, cwd);

  assert.ok(rendered.includes(join("nested", "local.ts")));
  assert.ok(rendered.includes(`${join("~", ".pi-codex-render-home.ts")} → ${externalPath}`));
});

void test("applies add, update, and delete hunks with Codex result details", async (t) => {
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
  assert.deepEqual(
    parsePatch(patch).map((operation) => operation.kind),
    ["add", "update", "delete"],
  );

  const details = await applyPatch(cwd, patch);
  assert.deepEqual(details.added, ["src/added.txt"]);
  assert.deepEqual(details.modified, ["src/current.txt"]);
  assert.deepEqual(details.deleted, ["obsolete.txt"]);
  assert.equal(details.status, "completed");
  assert.equal(details.exact, true);
  assert.deepEqual(
    details.changes.map((change) => change.kind),
    ["add", "update", "delete"],
  );
  assert.equal(await readFile(join(cwd, "src/added.txt"), "utf8"), "created\n");
  assert.equal(
    await readFile(join(cwd, "src/current.txt"), "utf8"),
    "alpha\ntarget\nreplacement\n",
  );
  await assert.rejects(readFile(join(cwd, "obsolete.txt"), "utf8"), { code: "ENOENT" });
});

void test("renders repeated operations on one path as one final-state diff", async (t) => {
  const cwd = await workspace(t);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  await writeFile(join(cwd, "replaced.txt"), "shared\nold\n");

  const replacementPatch = `*** Begin Patch
*** Delete File: replaced.txt
*** Add File: replaced.txt
+shared
+new
+extra
*** End Patch`;
  const replacementPreview = await previewPatch(cwd, replacementPatch);
  assert.equal(replacementPreview.changes.length, 1);
  assert.equal(replacementPreview.changes[0]?.kind, "update");
  assert.match(
    formatApplyPatchRenderText(replacementPreview, theme, cwd),
    /^• Edited replaced\.txt \(\+2 -1\)/,
  );

  const replacement = await applyPatch(cwd, replacementPatch);

  assert.deepEqual(
    replacement.changes.map((change) => change.kind),
    ["delete", "add"],
  );
  const replacementText = formatApplyPatchRenderText(replacement, theme, cwd);
  assert.match(replacementText, /^• Edited replaced\.txt \(\+2 -1\)/);
  assert.doesNotMatch(replacementText, /Edited 2 files/);
  assert.match(replacementText, /-2 old/);
  assert.match(replacementText, /\+2 new/);

  await writeFile(join(cwd, "updated.txt"), "first\nsecond\nthird\n");
  const repeatedUpdate = await applyPatch(
    cwd,
    `*** Begin Patch
*** Update File: updated.txt
@@
-first
+FIRST
*** Update File: updated.txt
@@
-second
+SECOND
*** End Patch`,
  );

  assert.equal(repeatedUpdate.changes.length, 2);
  const repeatedUpdateText = formatApplyPatchRenderText(repeatedUpdate, theme, cwd);
  assert.match(repeatedUpdateText, /^• Edited updated\.txt \(\+2 -2\)/);
  assert.doesNotMatch(repeatedUpdateText, /Edited 2 files/);
  assert.match(repeatedUpdateText, /-1 first/);
  assert.match(repeatedUpdateText, /\+1 FIRST/);
  assert.match(repeatedUpdateText, /-2 second/);
  assert.match(repeatedUpdateText, /\+2 SECOND/);
});
