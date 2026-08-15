# `apply_patch` Instruction Feedback

## Status

This document is the standalone implementation reference for model and TUI
feedback produced by `apply_patch`. It defines the agreed result structure,
terminology, rendering, failure inspection, and test requirements.

`APPLY_PATCH_SEMANTIC_OPERATIONS.md` remains authoritative for filesystem and
matching semantics. This document is authoritative for presenting those
semantics to the model and user.

## Goals

Feedback must:

1. retain the aggregate changed-file summary;
2. report every instruction without a model-facing limit;
3. attribute filesystem effects, errors, and matching evidence to the
   instruction that produced them;
4. report failed and not-run instructions;
5. use concise, simplified technical English;
6. report deterministic facts rather than speculative outcomes; and
7. avoid repeating old or replacement text supplied in the patch.

## Aggregate summary

Successful results retain the current summary:

```text
Success. Updated the following files:
A added.txt
M updated.txt
D deleted.txt
```

When every instruction has no filesystem effect:

```text
Success. No files were changed.
```

Failed results identify the failed instruction and list confirmed changed
paths:

```text
Patch failed at instruction 3 of 5.
Files changed:
M updated.txt
A destination.txt
```

The changed-file list includes completed effects from failed instructions. A
path whose final state is not verified is not listed as changed unless another
completed, verified effect on that path is available.

When a failed instruction creates only a directory or leaves only a temporary
entry, use:

```text
Filesystem changed.
```

The directory or temporary-entry path remains on its instruction instead of
being mislabelled as an added file.

`No files were changed.` is valid only when every relevant path was verified
unchanged. When no changed path is confirmed and at least one relevant final
state is not verified, omit the global changed/unchanged statement and report
the unverified state on its instruction.

Keep the existing exit-code and wall-time envelope where the tool currently
uses it.

## Instruction results

The aggregate summary is followed by this exact heading:

```text
Instruction results:
```

Every instruction is listed in source order. Model feedback has no instruction
limit and no omitted-count message.

Visible statuses are:

- `APPLIED`
- `NO CHANGE`
- `SKIPPED`
- `FAILED`
- `NOT RUN`

Patch previews may additionally use `PLANNED`; executed tool results use only
the statuses above.

Example:

```text
Instruction results:
1. APPLIED - Update a.txt
2. NO CHANGE - Delete missing.txt - Path already absent.
3. FAILED - Move source.txt -> destination.txt - Created destination.txt; source.txt remains; source removal failed: permission denied.
4. NOT RUN - Update other.txt - Instruction 3 failed.
```

Model-facing separators and move arrows are ASCII. The TUI may use styled
Unicode symbols and arrows.

## Concision rules

An ordinary applied instruction needs only its status and operation:

```text
1. APPLIED - Add a.txt
2. APPLIED - Update b.txt
3. APPLIED - Move c.txt -> d.txt
4. APPLIED - Delete e.txt
```

Add a short clause only for:

- a no-change or skipped reason;
- a failure;
- a non-obvious externally visible filesystem effect;
- a partial effect;
- a final state that is not verified; or
- concise matcher evidence.

Do not include:

- old or replacement patch blocks;
- a diff-availability warning;
- verbose proof sections;
- a duplicated raw error section;
- a detached matcher section; or
- prose that merely restates an ordinary successful operation.

## Terminology

Do not expose these terms in model or TUI feedback:

- `Committed prefix`
- `exact`
- `inexact`
- `dead`
- `dominated`
- `no-op`
- `preflight`
- `installed`

Prefer:

- `created`
- `replaced`
- `updated`
- `deleted`
- `removed`
- `moved`
- `present`
- `absent`
- `remains`
- `not verified`
- `validation`
- `patch format`

Generated explanatory text must not speculate with words such as `may`,
`might`, `possibly`, `probably`, or `likely`. When inspection cannot determine
a path's state, say:

```text
Final state not verified for a.txt.
```

## No-change results

Render semantic no-ops as `NO CHANGE`:

```text
1. NO CHANGE - Update a.txt - The instruction contains no changes.
2. NO CHANGE - Update b.txt - Old and replacement content are identical.
3. NO CHANGE - Add c.txt - Requested content already present.
4. NO CHANGE - Delete d.txt - Path already absent.
5. NO CHANGE - Move e.txt -> e.txt - Source and destination identify the same entry.
6. NO CHANGE - Move a.txt -> b.txt - Instruction 2 already moved this entry.
```

The fulfilled-move result records and references the earlier instruction that
performed the move.

## Skipped results

Render a semantically eliminated operation as `SKIPPED`, not `DEAD`.

```text
2. SKIPPED - Update a.txt - Instruction 4 deletes a.txt before another instruction reads it.
```

For a shared hard-linked file:

```text
2. SKIPPED - Update a.txt - Instructions 4 and 6 delete every link before another instruction reads the file.
```

The concise reason and related instruction numbers remain on the skipped
instruction. Do not create a separate proof section.

## Per-instruction filesystem effects

Each instruction result stores:

- its status;
- an optional concise reason;
- completed externally visible filesystem effects;
- relevant final path states;
- an optional error;
- optional matcher evidence; and
- related instruction numbers.

The operation label is sufficient for ordinary successful effects. Explicit
effects are required for:

- a partial effect from a failed instruction;
- destination replacement;
- symbolic-link entry versus target behavior;
- a parent directory that remains after failure;
- deletion of a destination before replacement failure;
- a temporary entry remaining after cleanup failure;
- a source remaining after destination creation or replacement; and
- a final state that is not verified.

Effects from a failed instruction remain attached to that instruction. They
must not be called earlier changes.

Examples:

```text
3. FAILED - Move a.txt -> b.txt - Created b.txt; a.txt remains; source removal failed: permission denied.
```

```text
3. FAILED - Move a.txt -> b.txt - Replaced b.txt; a.txt remains; source removal failed: permission denied.
```

```text
3. FAILED - Move a.txt -> b.txt - Deleted the previous b.txt; b.txt is absent; replacement failed: permission denied.
```

```text
3. FAILED - Move a.txt -> dir/b.txt - Created directory dir; move failed: permission denied.
```

## Post-failure inspection

After a low-level filesystem operation fails, inspect every relevant source,
destination, parent, followed target, and temporary path before constructing
feedback.

Path-state feedback uses only deterministic states:

- present as a regular file;
- present as a symbolic link;
- absent;
- unchanged;
- contains the requested content;
- contains unexpected content;
- is a different filesystem entry;
- entry type changed; or
- not verified.

Examples:

```text
3. FAILED - Update a.txt - Write failed: permission denied; a.txt is unchanged.
```

```text
3. FAILED - Update a.txt - Write reported an error; a.txt contains the requested content.
```

```text
3. FAILED - Update a.txt - Write failed: input/output error; final state not verified for a.txt.
```

An empty recorded-change list is not proof that no file changed.

## Unreadable previous content

Replacing a file without reading its previous content produces ordinary
success feedback:

```text
Success. Updated the following files:
A file.txt

Instruction results:
1. APPLIED - Add file.txt
```

Do not tell the model that previous content was unreadable, a diff is
unavailable, history is incomplete, or the result is inexact. Diff
availability is a TUI/history concern, not an operation result.

## Matcher feedback

Matcher feedback belongs to the failed update instruction. Do not emit a
detached `Matcher diagnostics:` section or repeat old/replacement patch text.

Examples:

```text
3. FAILED - Update file.ts - Old content was not found.
```

```text
3. FAILED - Update file.ts - Edit group 2 matches before edit group 1; matches at lines 10-12 and 30-32.
```

```text
3. FAILED - Update file.ts - Matching locations at lines 10-12 and 40-42 produce different results.
```

```text
3. FAILED - Update file.ts - Matching stopped after 256 complete mappings.
```

```text
3. FAILED - Update file.ts - Requested replacement found at lines 40-44, but old content was not found.
```

## Not-run results

Every not-run instruction identifies why it did not run:

```text
4. NOT RUN - Update other.txt - Instruction 3 failed.
```

For errors not owned by an instruction:

```text
1. NOT RUN - Update a.txt - Patch format error.
```

```text
1. NOT RUN - Update a.txt - Filesystem setup failed.
```

## Patch-level failures

Use a patch-level statement only when no instruction owns the error.

```text
Patch format error at line 1: the patch must begin with "*** Begin Patch".

Instruction results:
1. NOT RUN - Update a.txt - Patch format error.
```

```text
Patch setup failed: filesystem access failed for path.

Instruction results:
1. NOT RUN - Update a.txt - Filesystem setup failed.
```

If cancellation or an integration callback stops the patch after an
instruction completed and before another instruction became active:

```text
Patch stopped after instruction 3.
```

Completed instruction effects remain listed normally.

## TUI

The TUI retains its aggregate visual summary, followed by
`Instruction results:` and every instruction row.

Collapsed rendering keeps each row concise:

```text
• Edited 2 files (+3 -1)

Instruction results:
✓ 1. Update a.txt
○ 2. Delete missing.txt — Path already absent.
✘ 3. Move source.txt → destination.txt — Created destination.txt; source.txt remains; source removal failed.
– 4. Update other.txt — Instruction 3 failed.
```

Expanded rendering nests these details beneath the relevant instruction:

- applied textual diffs;
- non-obvious filesystem effects;
- final-state verification;
- concise matcher locations; and
- useful system-error details.

Partial effects are not rendered as detached successful operations. Failed
matching feedback does not repeat old or replacement patch blocks.

## Canonical data

Model and TUI formatters consume one canonical instruction-result structure:

```ts
type InstructionResult = {
  index: number;
  operation: OperationLabel;
  status: "applied" | "planned" | "no-change" | "skipped" | "failed" | "not-run";
  reason?: InstructionReason;
  effects: InstructionEffect[];
  finalStates: FinalPathState[];
  error?: InstructionError;
  matching?: MatchingEvidence;
  relatedInstructions?: number[];
};
```

Only presentation differs:

- ASCII versus styled Unicode symbols;
- path presentation;
- expanded TUI diffs;
- syntax highlighting; and
- expanded system-error details.

Semantic wording and facts remain shared.

## Matcher candidate deduplication

Before applying candidate and mapping limits:

1. canonicalize candidates by complete byte-edit effect;
2. remove byte-identical duplicate candidates;
3. retain every semantically distinct candidate; and
4. do not rank candidates or use heuristic preference.

This prevents duplicate line-level and structural candidates from consuming
the exhaustive mapping bound.

## Required tests

### Completeness

- model and TUI results with 1, 8, 9, 100, and 500 instructions;
- every instruction appears;
- no omitted-count message exists.

### Summary and attribution

- successful A/M/D summary remains;
- all-no-change summary remains;
- failed summary lists confirmed changed paths;
- effects from failed instructions appear under that instruction;
- an unverified final state does not produce `No files were changed.`.

### Terminology

Generated model and TUI feedback does not contain:

- `Committed prefix`
- `exact`
- `inexact`
- `installed`
- `dead`
- `dominated`
- `Matcher diagnostics`
- the heading `Instructions:`

The heading is `Instruction results:`.

### Deterministic failures

Cover:

- patch-level input and format errors appear once;
- cancelled and input-error instructions use distinct reasons;
- unchanged after failure;
- requested content present after a reported write failure;
- different content after failure;
- same-content entry replacement after failure;
- entry-type change after failure;
- unchanged planned content from an earlier instruction;
- final state not verified;
- a confirmed partial move remains in the changed-file summary when later
  inspection cannot verify the destination;
- destination created while source remains;
- destination replaced while source remains;
- destination deleted and replacement absent;
- parents created without a false no-change statement;
- temporary entry remains without a false no-change statement; and
- post-operation verification failure.

### No patch-content repetition

Model feedback does not reproduce old or replacement hunk blocks.

### Model/TUI parity

Every fixture has the same statuses, concise reasons, filesystem effects,
final path states, and instruction attribution in model and TUI output.

### Matcher deduplication

A multi-group formatter-recovery fixture proves duplicate candidates do not
consume the mapping limit.

## Documentation

Implementation changes must also update:

- `APPLY_PATCH_SEMANTIC_OPERATIONS.md`
- `APPLY_PATCH_REMAINING_WORK.md`
- `README.md`
- `CHANGELOG.md`
