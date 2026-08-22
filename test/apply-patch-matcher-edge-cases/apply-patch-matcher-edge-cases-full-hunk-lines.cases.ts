import { parsePatch } from "../../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  fullHunkLineCandidateSets,
  orderedFullHunkLineCandidateSets,
  type FullHunkLineChunkCandidates,
} from "../../extensions/openai-codex-compat/apply-patch-matcher/apply-patch-matcher-full-hunk-lines.ts";
import { assert, test } from "./apply-patch-matcher-edge-cases-harness.ts";

function chunks(patch: string) {
  const operation = parsePatch(patch)[0];
  assert.equal(operation?.kind, "update");
  if (operation?.kind !== "update") throw new Error("Update operation required.");
  return operation.chunks;
}

function witnessed(
  candidateSets: readonly FullHunkLineChunkCandidates[],
  index: number,
): Extract<FullHunkLineChunkCandidates, { kind: "witnessed" }> {
  const candidateSet = candidateSets[index];
  assert.equal(candidateSet?.kind, "witnessed");
  if (candidateSet?.kind !== "witnessed") throw new Error("Witnessed chunk required.");
  return candidateSet;
}

test("requires complete replacement context around a line-level edit", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "## Intended\ncurrent\n## Other\nold\n",
    chunks(`*** Begin Patch
*** Update File: relocated.txt
@@
 ## Intended
-old
+new
*** End Patch`),
  );
  assert.deepEqual(witnessed(candidateSets, 0).candidates, []);

  const valid = fullHunkLineCandidateSets(
    "## Intended\nold\n## Other\ncurrent\n",
    chunks(`*** Begin Patch
*** Update File: scoped.txt
@@
 ## Intended
-old
+new
 ## Other
*** End Patch`),
  );
  const candidate = witnessed(valid, 0).candidates[0];
  assert.deepEqual(candidate?.witness.oldLines, [
    {
      patchLine: 0,
      sourceLine: 0,
      kind: "context",
      patchText: "## Intended",
      mode: "exact",
    },
    {
      patchLine: 1,
      sourceLine: 1,
      kind: "delete",
      patchText: "old",
      mode: "exact",
    },
    {
      patchLine: 3,
      sourceLine: 2,
      kind: "context",
      patchText: "## Other",
      mode: "exact",
    },
  ]);
  assert.deepEqual(candidate?.edits, [
    {
      sourceStartLine: 1,
      sourceEndLine: 2,
      newLines: ["new"],
    },
  ]);
});

test("requires supplied anchors and records their source location", () => {
  const missing = fullHunkLineCandidateSets(
    "unique-old\n",
    chunks(`*** Begin Patch
*** Update File: missing-anchor.txt
@@ Missing section
-unique-old
+new
*** End Patch`),
  );
  assert.deepEqual(witnessed(missing, 0).candidates, []);

  const present = fullHunkLineCandidateSets(
    "Section\nintervening\nunique-old\n",
    chunks(`*** Begin Patch
*** Update File: anchored.txt
@@ Section
-unique-old
+new
*** End Patch`),
  );
  assert.deepEqual(witnessed(present, 0).candidates[0]?.witness.anchor, {
    patchText: "Section",
    sourceLine: 0,
    mode: "exact",
  });
});

test("preserves context-only chunks as ordered checkpoints", () => {
  const reverse = fullHunkLineCandidateSets(
    "target\nsection\n",
    chunks(`*** Begin Patch
*** Update File: ordered.txt
@@ section
@@
-target
+changed
*** End Patch`),
  );
  assert.equal(witnessed(reverse, 0).candidates.length, 1);
  assert.equal(witnessed(reverse, 1).candidates.length, 1);
  assert.equal(orderedFullHunkLineCandidateSets(reverse), undefined);

  const forward = fullHunkLineCandidateSets(
    "section\ntarget\n",
    chunks(`*** Begin Patch
*** Update File: ordered.txt
@@ section
@@
-target
+changed
*** End Patch`),
  );
  assert.ok(orderedFullHunkLineCandidateSets(forward));

  const staleOrdinaryContext = fullHunkLineCandidateSets(
    "current checkpoint\ntarget\n",
    chunks(`*** Begin Patch
*** Update File: ordered.txt
@@
 stale checkpoint
@@
-target
+changed
*** End Patch`),
  );
  assert.equal(witnessed(staleOrdinaryContext, 0).candidates.length, 0);
  assert.equal(orderedFullHunkLineCandidateSets(staleOrdinaryContext), undefined);
});

test("derives two-sided insertions only from one complete old-side mapping", () => {
  const duplicate = fullHunkLineCandidateSets(
    "before\nitem\nafter\n",
    chunks(`*** Begin Patch
*** Update File: duplicate.txt
@@
 before
+item
 after
*** End Patch`),
  );
  assert.deepEqual(witnessed(duplicate, 0).candidates, []);

  const intervening = fullHunkLineCandidateSets(
    "repositories/dce-notification\nrepositories/dge-blackgate\nrepositories/dge-rest\n",
    chunks(`*** Begin Patch
*** Update File: AGENTS.md
@@
 repositories/dce-notification
+repositories/dge-database2
 repositories/dge-rest
*** End Patch`),
  );
  assert.deepEqual(witnessed(intervening, 0).candidates, []);

  const staleNearestContext = fullHunkLineCandidateSets(
    "section\nchanged-nearest\ntail\n",
    chunks(`*** Begin Patch
*** Update File: anchored-boundary.txt
@@ section
 expected-nearest
+inserted
*** End Patch`),
  );
  assert.deepEqual(witnessed(staleNearestContext, 0).candidates, []);

  const adjacent = fullHunkLineCandidateSets(
    "before\nafter\n",
    chunks(`*** Begin Patch
*** Update File: adjacent.txt
@@
 before
+item
 after
*** End Patch`),
  );
  assert.deepEqual(witnessed(adjacent, 0).candidates[0]?.edits, [
    {
      sourceStartLine: 1,
      sourceEndLine: 1,
      newLines: ["item"],
    },
  ]);
});

test("supports genuinely one-sided and explicitly anchored insertions", () => {
  const beforeOnly = fullHunkLineCandidateSets(
    "before\nunmentioned\n",
    chunks(`*** Begin Patch
*** Update File: before.txt
@@
 before
+inserted
*** End Patch`),
  );
  assert.deepEqual(witnessed(beforeOnly, 0).candidates[0]?.edits[0], {
    sourceStartLine: 1,
    sourceEndLine: 1,
    newLines: ["inserted"],
  });

  const afterOnly = fullHunkLineCandidateSets(
    "unmentioned\nafter\n",
    chunks(`*** Begin Patch
*** Update File: after.txt
@@
+inserted
 after
*** End Patch`),
  );
  assert.deepEqual(witnessed(afterOnly, 0).candidates[0]?.edits[0], {
    sourceStartLine: 1,
    sourceEndLine: 1,
    newLines: ["inserted"],
  });

  const anchored = fullHunkLineCandidateSets(
    "section\ncurrent\n",
    chunks(`*** Begin Patch
*** Update File: anchored.txt
@@ section
+inserted
*** End Patch`),
  );
  assert.deepEqual(witnessed(anchored, 0).candidates[0]?.edits[0], {
    sourceStartLine: 1,
    sourceEndLine: 1,
    newLines: ["inserted"],
  });

  const unanchored = fullHunkLineCandidateSets(
    "current\n",
    chunks(`*** Begin Patch
*** Update File: unanchored.txt
@@
+inserted
*** End Patch`),
  );
  assert.deepEqual(witnessed(unanchored, 0).candidates, []);

  const explicitEnd = fullHunkLineCandidateSets(
    "current\n",
    chunks(`*** Begin Patch
*** Update File: explicit-end.txt
@@
+inserted
*** End of File
*** End Patch`),
  );
  assert.deepEqual(witnessed(explicitEnd, 0).candidates[0]?.edits[0], {
    sourceStartLine: 1,
    sourceEndLine: 1,
    newLines: ["inserted"],
  });
});

test("requires complete trailing context at explicit end of file", () => {
  const mismatch = fullHunkLineCandidateSets(
    "old\nfooter1\nDIFFERENT\n",
    chunks(`*** Begin Patch
*** Update File: tail.txt
@@
-old
+new
 footer1
 footer2
*** End of File
*** End Patch`),
  );
  assert.deepEqual(witnessed(mismatch, 0).candidates, []);

  const exact = fullHunkLineCandidateSets(
    "old\nfooter1\nfooter2\n",
    chunks(`*** Begin Patch
*** Update File: tail.txt
@@
-old
+new
 footer1
 footer2
*** End of File
*** End Patch`),
  );
  const witness = witnessed(exact, 0).candidates[0]?.witness;
  assert.equal(witness?.orderEndLine, 3);
  assert.equal(witness?.explicitEndOfFile, true);
  assert.equal(witness?.oldLines.length, 3);

  const trailingContent = fullHunkLineCandidateSets(
    "old\nfooter1\nfooter2\nextra\n",
    chunks(`*** Begin Patch
*** Update File: tail.txt
@@
-old
+new
 footer1
 footer2
*** End of File
*** End Patch`),
  );
  assert.deepEqual(witnessed(trailingContent, 0).candidates, []);
});

test("does not bridge unmatched lines inside a complete old hunk", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "before\nunmentioned\nold\nafter\n",
    chunks(`*** Begin Patch
*** Update File: gap.txt
@@
 before
-old
+new
 after
*** End Patch`),
  );
  assert.deepEqual(witnessed(candidateSets, 0).candidates, []);
});

test("maps every edit group through the same complete old-side witness", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "before\nold-one\nmiddle\nold-two\nafter\n",
    chunks(`*** Begin Patch
*** Update File: groups.txt
@@
 before
-old-one
+new-one
 middle
-old-two
+new-two
 after
*** End Patch`),
  );
  const candidate = witnessed(candidateSets, 0).candidates[0];
  assert.equal(candidate?.witness.oldLines.length, 5);
  assert.deepEqual(candidate?.edits, [
    {
      sourceStartLine: 1,
      sourceEndLine: 2,
      newLines: ["new-one"],
    },
    {
      sourceStartLine: 3,
      sourceEndLine: 4,
      newLines: ["new-two"],
    },
  ]);
});

test("retains inert empty chunks without inventing a source checkpoint", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "old\n",
    chunks(`*** Begin Patch
*** Update File: empty-chunk.txt
@@
-old
+new
@@
*** End Patch`),
  );
  assert.equal(candidateSets[0]?.kind, "witnessed");
  assert.deepEqual(candidateSets[1], {
    kind: "inert",
    chunkIndex: 2,
    chunkCount: 2,
  });
  assert.ok(orderedFullHunkLineCandidateSets(candidateSets));
});

test("records the matching relation for every old-side source line", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "  before  \r\nold\r\n",
    chunks(`*** Begin Patch
*** Update File: modes.txt
@@
 before
-old
+new
*** End Patch`),
  );
  assert.deepEqual(
    witnessed(candidateSets, 0).candidates[0]?.witness.oldLines.map(({ sourceLine, mode }) => ({
      sourceLine,
      mode,
    })),
    [
      { sourceLine: 0, mode: "trim" },
      { sourceLine: 1, mode: "trim-end" },
    ],
  );
});

test("rejects internally inconsistent chunk line-role projections", () => {
  assert.throws(
    () =>
      fullHunkLineCandidateSets("old\n", [
        {
          oldLines: ["different"],
          newLines: ["new"],
          lines: [
            { kind: "delete", text: "old" },
            { kind: "add", text: "new" },
          ],
          endOfFile: false,
        },
      ]),
    /line roles disagree/u,
  );
});
