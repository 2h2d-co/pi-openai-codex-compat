import { parsePatch } from "../../extensions/openai-codex-compat/apply-patch-engine.ts";
import {
  fullHunkLineCandidateSets,
  type FullHunkLineChunkCandidates,
} from "../../extensions/openai-codex-compat/apply-patch-matcher/apply-patch-matcher-full-hunk-lines.ts";
import {
  findAllSequenceMatches,
  findSequences,
} from "../../extensions/openai-codex-compat/apply-patch-matcher/apply-patch-matcher-line-matching.ts";
import { assert, test } from "./apply-patch-matcher-edge-cases-harness.ts";

function chunks(patch: string) {
  const operation = parsePatch(patch)[0];
  assert.equal(operation?.kind, "update");
  if (operation?.kind !== "update") throw new Error("Update operation required.");
  return operation.chunks;
}

function candidates(candidateSets: readonly FullHunkLineChunkCandidates[]) {
  const candidateSet = candidateSets[0];
  assert.equal(candidateSet?.kind, "witnessed");
  if (candidateSet?.kind !== "witnessed") throw new Error("Witnessed chunk required.");
  return candidateSet.candidates;
}

test("keeps strict tier priority separate from exhaustive tolerant collection", () => {
  const lines = ['"target"', '  "target"', "“target”"];
  assert.deepEqual(findSequences(lines, ['"target"'], 0, false), [0]);
  assert.deepEqual(findAllSequenceMatches(lines, ['"target"'], 0, false), [
    {
      start: 0,
      modes: ["exact", "trim-end", "trim", "unicode"],
    },
    {
      start: 1,
      modes: ["trim", "unicode"],
    },
    {
      start: 2,
      modes: ["unicode"],
    },
  ]);
});

test("deduplicates one location while retaining every proving mode", () => {
  assert.deepEqual(findAllSequenceMatches(["target"], ["target"], 0, false), [
    {
      start: 0,
      modes: ["exact", "trim-end", "trim", "unicode"],
    },
  ]);
  assert.deepEqual(findAllSequenceMatches(["target  "], ["target"], 0, false), [
    {
      start: 0,
      modes: ["trim-end", "trim", "unicode"],
    },
  ]);
});

test("prevents exact candidates from suppressing complete trim candidates", () => {
  const patchChunks = chunks(`*** Begin Patch
*** Update File: tiers.txt
@@
 block
-target
+changed
*** End Patch`);
  const exactOnly = candidates(fullHunkLineCandidateSets("block\ntarget\n", patchChunks));
  const withTrim = candidates(
    fullHunkLineCandidateSets("block\ntarget\n  block\n  target\n", patchChunks),
  );

  assert.deepEqual(
    exactOnly.map((candidate) => candidate.edits[0]?.sourceStartLine),
    [1],
  );
  assert.deepEqual(
    withTrim.map((candidate) => ({
      sourceLine: candidate.edits[0]?.sourceStartLine,
      modes: candidate.witness.oldSideModes,
    })),
    [
      {
        sourceLine: 1,
        modes: ["exact", "trim-end", "trim", "unicode"],
      },
      {
        sourceLine: 3,
        modes: ["trim", "unicode"],
      },
    ],
  );
});

test("prevents exact candidates from suppressing complete Unicode candidates", () => {
  const candidateSets = fullHunkLineCandidateSets(
    'section\n"value"\nsection\n“value”\n',
    chunks(`*** Begin Patch
*** Update File: unicode.txt
@@
 section
-"value"
+"changed"
*** End Patch`),
  );
  assert.deepEqual(
    candidates(candidateSets).map((candidate) => ({
      sourceLine: candidate.edits[0]?.sourceStartLine,
      modes: candidate.witness.oldSideModes,
    })),
    [
      {
        sourceLine: 1,
        modes: ["exact", "trim-end", "trim", "unicode"],
      },
      {
        sourceLine: 3,
        modes: ["unicode"],
      },
    ],
  );
});

test("collects every anchor tier without replacing stronger evidence", () => {
  const candidateSets = fullHunkLineCandidateSets(
    "Section\ncurrent\n  Section\ncurrent\n",
    chunks(`*** Begin Patch
*** Update File: anchors.txt
@@ Section
+inserted
*** End Patch`),
  );
  assert.deepEqual(
    candidates(candidateSets).map((candidate) => candidate.witness.anchor),
    [
      {
        patchText: "Section",
        sourceLine: 0,
        modes: ["exact", "trim-end", "trim", "unicode"],
      },
      {
        patchText: "Section",
        sourceLine: 2,
        modes: ["trim", "unicode"],
      },
    ],
  );
});

test("keeps exhaustive candidate collection monotonic", () => {
  const pattern = ["block", "target"];
  const base = findAllSequenceMatches(["block", "target"], pattern, 0, false);
  const extended = findAllSequenceMatches(
    ["block", "target", "  block", "  target"],
    pattern,
    0,
    false,
  );
  assert.deepEqual(extended.slice(0, base.length), base);
  assert.deepEqual(extended.at(-1), {
    start: 2,
    modes: ["trim", "unicode"],
  });
});

test("does not rank a later exact candidate above an earlier trim candidate", () => {
  assert.deepEqual(findAllSequenceMatches(["  target", "other", "target"], ["target"], 0, false), [
    {
      start: 0,
      modes: ["trim", "unicode"],
    },
    {
      start: 2,
      modes: ["exact", "trim-end", "trim", "unicode"],
    },
  ]);
});

test("applies exhaustive end-of-file constraints before recording candidates", () => {
  assert.deepEqual(findAllSequenceMatches(["target", "  target"], ["target"], 0, true), [
    {
      start: 1,
      modes: ["trim", "unicode"],
    },
  ]);
  assert.deepEqual(findAllSequenceMatches(["target"], ["target"], 1, true), []);
  assert.deepEqual(findAllSequenceMatches(["target"], [], 0, true), [
    {
      start: 1,
      modes: ["exact", "trim-end", "trim", "unicode"],
    },
  ]);
  assert.deepEqual(findAllSequenceMatches(["target"], [], 2, false), []);
});
