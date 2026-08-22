# `apply_patch` Safety Remediation

## Status

This document tracks the correctness remediation initiated after the
formatter-tolerant matcher produced an ambiguous insertion around an
unmentioned repository entry.

The audit established that the observed failure itself was safe, but the same
matching architecture can silently apply patches to unintended locations.
Formatter flexibility is subordinate to correctness:

> A relaxed match is acceptable only when the complete old hunk is proven to
> correspond to the current source under a closed set of formatter-equivalent
> transformations.

No implementation step begins until its scope is presented to Kaan. Kaan may
approve it, reject it, or revise it through discussion. Approval applies only
to the presented step.

## Progress protocol

Each step has one status:

- **PLANNED** — documented but not approved;
- **APPROVED** — approved by Kaan and ready to begin;
- **IN PROGRESS** — implementation has started;
- **COMPLETE** — implementation, tests, documentation, and validation pass;
- **BLOCKED** — a decision or external dependency prevents progress.

Before starting a step:

1. present its exact behavioral contract, implementation scope, tests, and
   expected compatibility changes;
2. identify any unresolved decision;
3. obtain Kaan's approval or resolve the decision through discussion;
4. record the approval and material decisions in this document; and
5. implement only the approved scope.

After completing a step:

1. run its focused tests;
2. run `npm run check` and `npm test` when the step changes behavior;
3. update this document with results and discovered follow-up work;
4. update normative documentation and the changelog when behavior is
   user-visible; and
5. commit a cohesive, valid checkpoint.

## Dictionary

- **Candidate:** One source range or insertion boundary proposed for an edit
  group.
- **Candidate completeness:** Every location allowed by the matching rules is
  considered before uniqueness is claimed.
- **Candidate superset:** Every location matched by any collected relation
  before a later eligibility policy decides which relations may authorize
  mutation.
- **Context-only chunk:** A chunk containing an `@@` anchor or unchanged lines
  but no additions or deletions.
- **Edit group:** One contiguous run of additions and deletions bounded by
  unchanged context.
- **Full-hunk witness:** A mapping proving that the complete old hunk,
  including unchanged context, corresponds to the current source.
- **Old hunk:** The context and deleted lines describing the source state
  expected by a patch.
- **Mode evidence:** Every matching relation that proves one source location
  corresponds to a patch line or sequence.
- **Output equivalence:** Different candidate mappings produce byte-identical
  final files.
- **Strict matcher:** The official Codex-compatible matching path attempted
  before formatter recovery.
- **Tolerant matcher:** The formatter-recovery path attempted after strict
  matching fails.
- **Zero-width insertion boundary:** A position between source lines where an
  insertion can occur without replacing existing bytes.

## Audit scope and validation

The read-only audit covered:

- patch parsing;
- strict line matching;
- formatter-tolerant line, insertion, Markdown, and Tree-sitter matching;
- candidate enumeration and output-equivalence checks;
- semantic planning and virtual filesystem state;
- no-change and dead-operation classification;
- path identity and mutation queues;
- execution-time verification;
- native and cross-filesystem moves;
- failure inspection and feedback;
- normative documentation;
- production fixtures; and
- the complete automated test suite.

Baseline validation during the audit:

- `npm test`: 320 passed, 2 skipped;
- `npm run check`: passed; and
- the repository remained unchanged.

Temporary adversarial probes reproduced the silent applications recorded
below. They did not modify repository files.

## Executive finding

The current formatter-tolerant matcher is unsafe.

Its effective proof is:

1. find candidates for edit payloads;
2. enumerate ordered, non-overlapping combinations;
3. apply each combination; and
4. accept when every result is byte-identical.

The missing proof obligation is:

> Every candidate must first be a valid mapping of the complete old hunk.

Without that obligation, output equivalence proves determinism over an invalid
or incomplete candidate set. It does not prove patch intent.

## Confirmed matcher defects

### M-001 — Ordinary context does not constrain replacements or deletions

**Severity:** Critical

**Status:** Contained; proof-only full-hunk replacement implemented

`editGroups()` retains context separately, but line and structural candidates
map only deleted payload lines or tokens. Ordinary before/after context is not
validated against replacement and deletion candidates.

Relevant implementation:

- `extensions/openai-codex-compat/apply-patch-matcher/apply-patch-matcher-formatter-tolerant-content.ts`
  - `editGroups()`;
  - `lineCandidates()`; and
  - `tokenCandidates()`.

Reproduction:

```text
source:
## Intended
current
## Other
old

patch:
 ## Intended
-old
+new
```

Observed result:

```text
## Intended
current
## Other
new
```

The edit was relocated to another section because `old` was globally unique.

Required correction:

- every replacement and deletion candidate must have a full-hunk witness;
- surrounding context must constrain scope and physical boundaries; and
- unique payload text elsewhere is not sufficient evidence.

### M-002 — Missing `@@` anchors become no constraint

**Severity:** Critical

**Status:** Contained; proof-only full-hunk replacement implemented

When an `@@` anchor has no source match, `anchorLines()` returns no anchors and
`candidateFollowsAnchor()` treats that as unrestricted matching.

Reproduction:

```diff
@@ Missing section
-unique-old
+new
```

The source contained only `unique-old`. The patch applied even though the
required section was absent.

Required correction:

- a supplied anchor must match;
- absence of a supplied anchor must reject tolerant recovery; and
- no-anchor and missing-anchor states must remain distinct.

### M-003 — Context-only chunks are discarded

**Severity:** Critical

**Status:** Contained; proof-only ordered-checkpoint replacement implemented

A context-only chunk creates no edit group and disappears from tolerant
matching. Its source-order and positional constraints are lost.

Reproduction:

```text
source:
target
section

patch:
@@ section
@@
-target
+changed
```

Strict matching rejected the reverse traversal. Tolerant matching discarded
the checkpoint and changed `target`.

At audit time, this behavior was explicitly accepted by:

- the `recent obsolete context-only chunk before insertion` production
  fixture; and
- the current semantic reference.

Required correction:

- context-only chunks must remain ordered mapping checkpoints;
- a stale checkpoint must reject the tolerant mapping; and
- current success fixtures that depend on discarding checkpoints must change.

### M-004 — Pure insertion boundaries are unioned rather than jointly proven

**Severity:** Critical

**Status:** Contained; proof-only joint-boundary replacement implemented

Insertion candidates are independently proposed:

- after the nearest preceding context line;
- before the nearest following context line;
- after the `@@` anchor; or
- at explicit EOF.

Those boundaries are unioned. Full before/after context is not required to
meet at one physical boundary.

This produced the original AGENTS.md ambiguity:

```text
repositories/dce-notification
repositories/dge-blackgate
repositories/dge-rest
```

The patch did not specify whether `dge-database2` belonged before or after
`dge-blackgate`.

The divergent outputs were safely rejected, but output equivalence can make
the same mechanism write the wrong result.

Reproduction:

```text
source:
before
item
after

patch:
 before
+item
 after
```

Both candidate boundaries produced:

```text
before
item
item
after
```

The fallback accepted and duplicated an already-present insertion.

Required correction:

- full before and after context must map to the same physical boundary;
- `@@` must not independently become an insertion boundary when nearer
  ordinary context exists;
- output equivalence remains secondary to contextual validity; and
- an already-present requested insertion must not be duplicated.

### M-005 — Matching-mode priority hides competing tolerant candidates

**Severity:** Critical

**Status:** Contained; proof-only exhaustive collector implemented

`findSequences()` returns matches from the first matching tier and omits
matches from later tiers:

1. exact;
2. trailing-whitespace trim;
3. full trim; and
4. Unicode normalization.

That priority is official strict behavior. It is not an exhaustive tolerant
candidate search.

Reproduction:

```text
source:
target
intended current
  target
```

The patch's ordinary context was stale and its deleted line was `target`. The
unrelated exact match suppressed the indented trim-equivalent candidate. The
unrelated first line was changed successfully.

Required correction:

- preserve official tier priority on the strict path;
- on the tolerant path, collect every candidate admitted by the approved
  equivalence relation;
- deduplicate complete byte effects only after collection; and
- reject when those complete candidates produce different outputs.

### M-006 — Tree-sitter failure can remove ambiguity and authorize a wrong write

**Severity:** Critical

**Status:** Contained; remediation planned for Step 4

`parseStructuralDocument()` converts parser initialization, grammar loading,
source parsing, and many unexpected failures into no structural document.
Line candidates then proceed alone.

Reproduction:

- an exact multiline decoy existed inside a TypeScript comment;
- the intended formatter-collapsed expression existed in executable code;
- with Tree-sitter available, the edit was ambiguous and rejected;
- with an injected parser initialization failure, only the comment candidate
  remained and was edited successfully.

Observed result:

```ts
/*
const result = merge(
  alpha,
  beta
);
*/
const result = combine(alpha, beta);
```

Required correction:

- parser/runtime failure must never reduce the candidate set and turn
  rejection into success;
- unexpected structural-runtime failure must reject tolerant recovery;
- malformed source requires a defined fail-closed policy; and
- parser availability needs decoy regression coverage.

### M-007 — Markdown ordinary matches can suppress intended table recovery

**Severity:** Critical

**Status:** Contained; remediation planned for Step 4

Ordinary line matches are returned before Markdown table-cell recovery.
Ordinary exact matches can occur inside fenced blocks, while table recovery
correctly excludes fenced blocks.

Reproduction:

````text
```text
| alpha | one |
```

| alpha      | one |
````

A patch intended for the formatter-aligned table row modified the exact row
inside the `text` fence instead.

Required correction:

- ordinary, table, and structural Markdown candidates must be considered
  together;
- source fence scope must participate in candidate validity;
- exact fenced decoys must not suppress table candidates; and
- complete Markdown context must constrain the target.

### M-008 — EOF validates remaining line count, not trailing context

**Severity:** Critical

**Status:** Contained; proof-only complete-EOF replacement implemented

The tolerant EOF condition checks:

```text
candidate end + number of after-context lines == source line count
```

It does not verify the content of those trailing lines.

Reproduction:

```text
source:
old
footer1
DIFFERENT

patch:
-old
+new
 footer1
 footer2
*** End of File
```

Observed result:

```text
new
footer1
DIFFERENT
```

Required correction:

- the complete old side, including every trailing context line, must map; and
- the mapped old side must end exactly at EOF.

### M-009 — Output equivalence is treated as intent equivalence

**Severity:** Critical

**Status:** Contained; normative remediation planned for Step 5

Multiple mappings that produce one byte-identical output are currently
accepted. This is safe only after every mapping has a full-hunk witness.

The pure-insertion duplication demonstrates that byte identity alone can
produce a deterministic but unintended result.

Required correction:

- output equivalence remains a final ambiguity check;
- it cannot establish candidate validity;
- same-output insertion mappings without a complete old-side witness reject;
- the existing normative prohibition against rejecting all same-output
  mappings must be narrowed or removed.

## Confirmed semantic and execution defects

### S-001 — Identity chunks on a move are not validated

**Severity:** High

**Status:** Confirmed and intentional

An update-and-move whose old and new sequences are structurally identical is
treated as an opaque pure move. Supplied context and expected content are not
matched.

Reproduction:

```text
source content:
unexpected

patch:
*** Update File: source.txt
*** Move to: destination.txt
@@
-expected
+expected
```

Observed: `unexpected` moved successfully.

Required correction:

- only a move with no chunks may bypass text validation;
- supplied identity or context chunks must be validated as source
  preconditions; and
- binary-safe opaque moves remain available through chunkless move syntax.

### S-002 — Byte-identical external entry replacement can mutate collateral links

**Severity:** High

**Status:** Confirmed and currently documented as an accepted risk

Execution accepts a changed inode when its bytes equal the planned bytes.
Entry identity controls hard-link topology and therefore the write set.

Reproduction:

1. preflight observed `source.txt` containing `old`;
2. an external action replaced it with a hard link to `collateral.txt`, also
   containing `old`;
3. execution accepted the byte-identical replacement; and
4. updating `source.txt` also changed `collateral.txt`.

Required correction:

- in-place text updates must reject entry-identity drift;
- byte equality cannot replace topology validation;
- any tolerated identity change must prove equivalent metadata and alias
  effects, not only content.

### S-003 — No-change postconditions are not revalidated

**Severity:** High under concurrent mutation

**Status:** Confirmed

No-change instructions create no planned mutation and therefore receive no
execution-time final validation.

Reproductions:

- an identical add was classified `NO CHANGE`, the file changed before
  execution, and the patch still returned success;
- an absent delete was classified `NO CHANGE`, the path was created before
  execution, and the patch still returned success.

Required correction:

- externally observable no-change postconditions must be revalidated before
  successful completion;
- identical-add content and spelling must still hold;
- absent-delete paths must still be absent; and
- fulfilled-move and update-result-unchanged cases need equivalent review.

### S-004 — Repeated identical adds ignore earlier virtual spelling

**Severity:** Medium

**Status:** Confirmed

Two identical adds to one initially absent path are both planned and executed.
The second should observe the first operation's virtual result and become
`NO CHANGE`.

Required correction:

- identical-add classification must use virtual content and virtual exact
  spelling;
- live filesystem spelling is insufficient after earlier planned operations;
- add regression coverage for repeated paths and aliases.

## Official-compatible safety decisions requiring review

These behaviors precede formatter recovery but conflict with an absolute
fail-closed policy.

### C-001 — Strict matching selects the first complete match

Duplicate strict matches are not considered ambiguous. This is official Codex
behavior and an explicit compatibility decision.

Decision needed:

- retain official first-match semantics; or
- reject ambiguous strict matches for stronger safety.

### C-002 — Strict trim matching can erase semantic indentation

Full trim matching ignores leading indentation. Indentation can be semantic in
Python, YAML, Markdown, and other formats.

Decision needed:

- retain unrestricted official trim behavior;
- restrict it by file type or syntax proof; or
- make it configurable.

### C-003 — Unicode normalization can equate semantic punctuation

Unicode matching equates smart and straight quotes, multiple dash/minus
characters, and Unicode spaces. This also applies inside code and literals.

Decision needed:

- retain official behavior globally;
- restrict it to non-code formats; or
- require stronger surrounding context.

### C-004 — Anchor-only strict insertion appends at EOF

Patch:

```diff
@@ anchor
+inserted
```

Source:

```text
anchor
tail
```

Current result:

```text
anchor
tail
inserted
```

Decision needed:

- retain official-compatible behavior;
- reject anchor-only insertion without explicit EOF; or
- define the anchor as the insertion boundary, intentionally deviating from
  official behavior.

## Bounded-work and cancellation gaps

### R-001 — Line scans are not cancellable

`findSequences()` and related line scans do not receive or check an abort
signal.

### R-002 — Candidate limits are enforced after complete scans

The 64-candidate limit bounds acceptance but does not stop source scanning as
soon as the limit is exceeded.

### R-003 — Fragment parsing is not cancellable

`parseFragment()` does not receive an abort signal or Tree-sitter progress
callback.

### R-004 — Structural window matching can be multiplicative

Sliding token-window comparison can approach:

```text
source token count × old-fragment token count
```

### R-005 — Markdown source scanning repeats per group

Fence and table scans can repeat across many edit groups.

Required correction:

- thread cancellation through every potentially long loop;
- stop candidate collection immediately after a fail-closed bound;
- add source/token indexing where required;
- preserve conservative failure on cancellation or limits.

## Existing safeguards that remain valuable

The audit did not invalidate these mechanisms:

- strict matching runs before tolerant recovery;
- the complete patch is semantically planned before writes;
- recognized conflicts prevent all writes;
- candidate mappings are ordered and non-overlapping;
- complete-mapping enumeration has a fail-closed bound;
- structural old-side punctuation and token text are exact;
- structural replacements cover complete physical lines;
- replacement lines remain opaque;
- line endings are preserved locally;
- path identity models symlinks, hard links, case aliases, and Unicode aliases;
- source and move destination paths participate in mutation queues;
- pure moves preserve opaque bytes;
- low-level failures receive deterministic final-state inspection; and
- confirmed partial effects are attributed to the responsible instruction.

These safeguards do not compensate for invalid or incomplete matcher
candidates.

## Required matching invariant

For every tolerant update:

1. every supplied `@@` anchor maps;
2. every context-only chunk maps and preserves source order;
3. every unchanged and deleted old-hunk element maps;
4. adjacent old-hunk elements remain physically adjacent unless an approved
   formatter transformation proves the intervening source bytes equivalent;
5. every edit boundary derives from that complete mapping;
6. EOF constrains both content and terminal position;
7. every candidate admitted by the approved equivalence relation is retained;
8. structural-runtime failure cannot shrink the candidate set into success;
9. every complete candidate mapping is ordered and non-overlapping; and
10. only then may byte-identical final output establish a unique result.

Approved formatter transformations are limited to:

- whitespace and physical line-boundary changes proven by exact Tree-sitter
  tokens and concrete syntax shape;
- Markdown table-cell padding with exact cell content and column count; and
- local line-ending differences.

The following are source drift, not formatter equivalence:

- additional or removed semantic lines;
- stale bullets, headings, repository entries, or prose;
- absent anchors;
- relocation to another scope or fenced block;
- changed concrete tokens or punctuation;
- parser/runtime unavailability; and
- unrelated context-only checkpoints.

## Regression-test requirements

Add direct regressions for every confirmed reproduction and the following
metamorphic properties:

1. changing any context line semantically cannot relocate an edit;
2. adding an exact decoy cannot turn rejection into success;
3. adding a lower-tier tolerant candidate cannot be hidden by an exact decoy;
4. parser failure cannot turn rejection into success;
5. missing anchors cannot weaken matching;
6. context-only chunks preserve order;
7. semantic content inserted between adjacent old-hunk lines causes rejection;
8. EOF success implies that every trailing old-hunk line matched;
9. already-present insertion content is never duplicated accidentally;
10. fenced, table, comment, literal, and executable candidates are considered
    without cross-scope suppression;
11. every accepted insertion has one contextually proven physical boundary;
12. every accepted replacement or deletion has a full-hunk witness;
13. identity-chunk moves validate their supplied source state;
14. entry-identity drift cannot change collateral hard links;
15. no-change postconditions are revalidated; and
16. repeated identical adds observe virtual state.

Tests must assert both:

- the intended final file tree; and
- that every unrelated path and source region remains byte-identical.

## Existing fixtures requiring reconsideration

Current success fixtures intentionally accept behavior that conflicts with the
new invariant:

- insertion after an extra unrelated Markdown bullet;
- insertion after formatter-collapsed preceding context using only the
  following boundary;
- obsolete context-only chunk before insertion;
- stale Markdown heading context with globally unique edit payloads; and
- any same-output mapping lacking a complete old-hunk witness.

Each fixture must be reviewed individually. It must either:

- become a fail-closed fixture;
- gain a complete formatter-equivalence proof; or
- be removed with a recorded reason.

## Remediation plan

### Step 1 — Immediate containment and contract reset

**Status:** COMPLETE

Approved decision:

> Disable formatter-tolerant mutation after strict failure until the complete
> old-hunk mapper is available. Return the original strict mismatch with
> concise diagnostics. Do not provide an unsafe opt-in.

Implementation:

- strict matching is the only active text-update matching path;
- strict mismatches do not initialize Tree-sitter or enumerate tolerant
  candidates;
- every M-series reproduction is a no-write containment regression;
- former tolerant-success fixtures now expect strict verification failure;
- normative, compatibility, feedback, and user documentation record the
  temporary containment; and
- the user-visible change is recorded under `Unreleased`.

Completion criteria:

- no confirmed M-series reproduction can write;
- strict matching remains unchanged unless a C-series decision is explicitly
  approved;
- focused tests, `npm run check`, and `npm test` pass.

### Step 2 — Full-hunk line and insertion mapping

**Status:** COMPLETE

Scope:

- represent context-only chunks;
- map complete ordinary context and deleted lines;
- require supplied anchors;
- derive insertion boundaries from complete before/after mappings;
- validate complete EOF content;
- preserve source order across chunks; and
- add M-001 through M-004 and M-008 regressions.

Implementation:

- each ordinary candidate records every unchanged and deleted old-side line,
  its source line, and its matching relation;
- all old-side lines map contiguously, while an `@@` anchor remains a required
  positional scope witness rather than a substitute edit boundary;
- each edit group is derived from that one complete old-side mapping;
- context-only chunks participate in forward and backward source-order
  reachability;
- two-sided insertions derive one internal boundary from one complete old-side
  mapping, while genuine one-sided, anchor-only, and explicit-EOF forms remain
  distinct;
- complete trailing context must end at EOF;
- inconsistent parser line-role projections reject; and
- the proof-only mapper remains disconnected from production mutation pending
  Steps 3 through 5.

Completion criteria:

- every accepted line-level mapping has a full-hunk witness;
- no unmatched semantic line can be bridged;
- all focused and complete tests pass.

### Step 3 — Candidate completeness and matching tiers

**Status:** COMPLETE

Scope:

- separate strict tier priority from tolerant exhaustive collection;
- collect and deduplicate every potential line-level candidate with complete
  mode evidence;
- prevent exact decoys from suppressing trim or Unicode candidates;
- retain C-002/C-003 eligibility and file-type restrictions as a separate
  Step 9 reactivation gate; and
- add M-005 regressions.

Implementation:

- the strict matcher retains its official mode priority and first-match
  behavior unchanged;
- a separate proof-only collector scans exact, trailing-trim, full-trim, and
  Unicode relations at every eligible source location;
- one location is returned once with every mode that proves it;
- anchors, individual old-side lines, and complete old-side sequences retain
  their full mode evidence;
- candidates remain source-ordered without mode ranking, so exact evidence
  cannot hide or displace trim or Unicode evidence;
- candidate collection is monotonic when additional non-EOF source locations
  are introduced;
- all four modes form a conservative candidate superset only; C-002 and C-003
  eligibility and file-type restrictions remain a mandatory Step 9 gate; and
- production mutation remains strict-only.

Completion criteria:

- adding a collected source location never removes or redirects an existing
  candidate;
- output-level preservation or ambiguity remains the Step 5 integration gate.

### Step 4 — Structural and Markdown proof integration

**Status:** PLANNED

Scope:

- integrate structural mappings into the complete old-hunk proof;
- fail closed on structural-runtime unavailability;
- preserve typed-fence source scope;
- consider ordinary, table, and structural Markdown candidates together;
- validate complete table context and insertion boundaries; and
- add M-006 and M-007 regressions.

Completion criteria:

- parser failure cannot authorize a write;
- decoys in comments, literals, fences, tables, or other scopes cannot
  suppress the intended candidate;
- complete tests pass with packaged grammars.

### Step 5 — Output-equivalence policy

**Status:** PLANNED

Scope:

- retain output equivalence only after complete candidate validity;
- decide treatment of already-present requested new hunks;
- distinguish insertion, replacement, and deletion semantics;
- revise same-output normative language and fixtures; and
- add M-009 regressions.

Default recommendation:

> Reject an insertion when its old hunk has no complete mapping, even if the
> complete requested new hunk already appears. Do not infer duplication or
> no-change intent.

Completion criteria:

- every accepted same-output mapping has a full-hunk witness;
- no accepted mapping duplicates an already-present insertion accidentally.

### Step 6 — Identity move and virtual-state semantics

**Status:** PLANNED

Scope:

- validate supplied identity/context chunks on moves;
- keep chunkless opaque moves binary-safe;
- classify repeated identical adds from virtual state;
- add S-001 and S-004 regressions; and
- update semantic and feedback documentation.

Completion criteria:

- stale identity chunks cannot move an unexpected entry;
- repeated identical adds produce one mutation followed by `NO CHANGE`;
- opaque chunkless moves remain byte-preserving.

### Step 7 — Execution identity and no-change revalidation

**Status:** PLANNED

Scope:

- reject unsafe entry-identity drift for in-place writes;
- revalidate externally observable no-change postconditions;
- preserve safe same-plan link-count changes;
- add hard-link collateral and no-change drift regressions; and
- revise the previously accepted external-replacement risk.

Completion criteria:

- byte-identical inode replacement cannot broaden or change the write set;
- no-change success is based on a postcondition still true immediately before
  completion.

### Step 8 — Bounded work and cancellation

**Status:** PLANNED

Scope:

- thread abort signals through line, Markdown, and fragment matching;
- stop candidate collection at fail-closed bounds;
- reduce multiplicative token-window work;
- avoid repeated full-source scans where practical; and
- add deterministic cancellation and workload tests.

Completion criteria:

- cancellation interrupts every long matcher phase before writes;
- candidate and mapping limits bound actual work, not only acceptance;
- complete tests remain stable.

### Step 9 — Official-compatible strict-policy decisions

**Status:** PLANNED

Scope:

- resolve C-001 through C-004 individually;
- compare each change with official behavior;
- document every retained deviation or accepted compatibility risk;
- add tests for every decision.

No strict-path behavior changes without separate approval.

### Step 10 — Final adversarial review and release documentation

**Status:** PLANNED

Scope:

- rerun the complete adversarial matrix;
- add randomized and metamorphic matching coverage;
- review parser, planner, executor, queue, and failure paths after matcher
  changes;
- reconcile README, semantic reference, feedback reference, release
  compatibility log, remaining-work tracker, and changelog;
- run `npm run check`, `npm test`, and `npm run pack:dry`; and
- record residual risks explicitly.

Completion criteria:

- no confirmed finding remains unresolved or undocumented;
- every accepted tolerant case has a traceable full-hunk proof;
- package contents and documentation match implemented behavior.

## Decision log

| Date       | Step   | Decision                                                                            | Rationale                                                                |
| ---------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 2026-08-20 | Step 1 | Disable all tolerant mutation after strict matching fails; retain no unsafe opt-in. | Kaan approved immediate fail-closed containment before matcher redesign. |
| 2026-08-20 | Step 2 | Build the full-hunk line mapper behind containment; do not reactivate mutation.     | Candidate completeness and output-equivalence work remain pending.       |
| 2026-08-20 | Step 3 | Collect all line-match modes as a proof superset without changing strict behavior.  | C-002/C-003 eligibility remains a separate pre-reactivation gate.        |

## Progress log

| Date       | Step              | Status   | Validation and notes                                                                                                                                                                                           |
| ---------- | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-20 | Audit             | COMPLETE | Read-only audit; `npm run check` passed; `npm test` passed with 320 tests and 2 skips; critical silent-misapplication probes reproduced in temporary directories.                                              |
| 2026-08-20 | Tracking document | COMPLETE | Findings, invariants, decisions, tests, and approval-gated remediation plan recorded.                                                                                                                          |
| 2026-08-20 | Step 1            | COMPLETE | Disabled tolerant mutation with no opt-in; all 77 focused tests and the full 328-test suite passed with 2 live tests skipped; `npm run check` passed.                                                          |
| 2026-08-20 | Step 2            | COMPLETE | Added a proof-only full-hunk line mapper and M-001/M-002/M-003/M-004/M-008 regressions; all 88 focused tests and 339 full-suite tests passed with 2 live tests skipped; `npm run check` passed.                |
| 2026-08-20 | Step 3            | COMPLETE | Added exhaustive mode collection and M-005 regressions without changing strict or production behavior; all 96 focused tests and 347 full-suite tests passed with 2 live tests skipped; `npm run check` passed. |
