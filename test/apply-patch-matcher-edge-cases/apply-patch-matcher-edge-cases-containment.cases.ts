import {
  assert,
  readFile,
  writeFile,
  join,
  test,
  applyPatch,
  workspace,
  rejectWithoutWrite,
} from "./apply-patch-matcher-edge-cases-harness.ts";
import { setApplyPatchStructuralRuntimeForTesting } from "../../extensions/openai-codex-compat/apply-patch-matcher.ts";

test("containment rejects replacement relocation after ordinary context drift", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "relocated.txt",
    "## Intended\ncurrent\n## Other\nold\n",
    `*** Begin Patch
*** Update File: relocated.txt
@@
 ## Intended
-old
+new
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("containment rejects a missing anchor and preserves context-only ordering", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "missing-anchor.txt",
    "unique-old\n",
    `*** Begin Patch
*** Update File: missing-anchor.txt
@@ Missing section
-unique-old
+new
*** End Patch`,
    /Failed to find context/u,
  );
  await rejectWithoutWrite(
    cwd,
    "context-order.txt",
    "target\nsection\n",
    `*** Begin Patch
*** Update File: context-order.txt
@@ section
@@
-target
+changed
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("containment rejects unproven insertion boundaries and duplicate insertion", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "duplicate-insertion.txt",
    "before\nitem\nafter\n",
    `*** Begin Patch
*** Update File: duplicate-insertion.txt
@@
 before
+item
 after
*** End Patch`,
    /Failed to find expected lines/u,
  );
  await rejectWithoutWrite(
    cwd,
    "anchor-boundary.txt",
    "section\nchanged-nearest\ntail\n",
    `*** Begin Patch
*** Update File: anchor-boundary.txt
@@ section
 expected-nearest
+inserted
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("containment rejects exact decoys that suppress other tolerant tiers", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "tier-decoy.txt",
    "target\nintended current\n  target\n",
    `*** Begin Patch
*** Update File: tier-decoy.txt
@@
 intended old
-target
+changed
*** End Patch`,
    /Failed to find expected lines/u,
  );
});

test("containment never starts structural recovery after strict mismatch", async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, "parser-decoy.ts");
  const content = [
    "/*",
    "const result = combine(",
    "  alpha,",
    "  beta",
    ");",
    "*/",
    "const result = combine(alpha, beta);",
    "",
  ].join("\n");
  await writeFile(path, content);
  let parserInitializationAttempts = 0;
  const restore = setApplyPatchStructuralRuntimeForTesting({
    async initializeParser() {
      parserInitializationAttempts += 1;
      throw new Error("injected unavailable parser");
    },
  });
  try {
    await assert.rejects(
      applyPatch(
        cwd,
        `*** Begin Patch
*** Update File: parser-decoy.ts
@@ intended scope
-const result = combine(
-  alpha,
-  beta
-);
+const result = merge(
+  alpha,
+  beta
+);
*** End Patch`,
      ),
      /Failed to find context/u,
    );
    assert.equal(parserInitializationAttempts, 0);
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    restore();
  }
});

test("containment rejects fenced Markdown decoys for aligned table rows", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "table-decoy.md",
    "```text\n| alpha | one |\n```\n\n| alpha      | one |\n",
    `*** Begin Patch
*** Update File: table-decoy.md
@@ stale
-| alpha | one |
+| beta | two |
*** End Patch`,
    /Failed to find context/u,
  );
});

test("containment validates trailing EOF context content", async (t) => {
  const cwd = await workspace(t);
  await rejectWithoutWrite(
    cwd,
    "tail.txt",
    "old\nfooter1\nDIFFERENT\n",
    `*** Begin Patch
*** Update File: tail.txt
@@
-old
+new
 footer1
 footer2
*** End of File
*** End Patch`,
    /Failed to find expected lines/u,
  );
});
