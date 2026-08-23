# `apply_patch` Open Safety Work

## Status

Formatter-tolerant matching has been removed permanently. Text updates now use
only the official Codex-compatible exact, trailing-trim, full-trim, and Unicode
matcher.

The matching incident that initiated this review is closed. S-001, S-002, and
S-003 are implemented and verified. One independent semantic finding remains
open. This document tracks that finding and its approval-gated implementation
work.

No open work described here has been approved for implementation. Before
starting a workstream:

1. present its behavioral contract, implementation scope, tests, and expected
   compatibility changes to Kaan;
2. resolve any open decision;
3. obtain Kaan's approval; and
4. implement only the approved scope.

## Dictionary

- **Entry identity:** The filesystem identity of a directory entry, including
  device and inode information that can affect hard-link topology.
- **Identity chunk:** An update chunk whose old and replacement line sequences
  are structurally identical.
- **No-change assertion:** A read-only execution step that proves a
  state-dependent no-change classification still holds.
- **No-change postcondition:** A filesystem state that made an instruction
  safely produce no mutation during planning.
- **Virtual state:** The ordered in-memory filesystem model used to classify
  every instruction before execution.

## Closed matching decision

The removed formatter-recovery path could derive candidates without proving
that the complete old hunk matched one source location. In particular,
insertion boundaries derived independently from before and after context could
be combined as alternatives. Distinct candidates were sometimes rejected as
ambiguous, but byte-identical candidate outputs could still authorize an
unintended write.

The permanent matching policy is:

1. search exact, trailing-trim, full-trim, and Unicode tiers in that order;
2. select the first location in the first successful tier;
3. use the same matcher for `@@` anchors and advance the cursor;
4. require each nonempty old-line sequence to be contiguous;
5. retain official EOF, pure-addition, and trailing-newline-sentinel behavior;
6. preserve local line endings after a successful match; and
7. run no other matcher after failure.

This decision is normative in:

- `OFFICIAL_CODEX_CLI_RELEASES.md`;
- `APPLY_PATCH_SEMANTIC_OPERATIONS.md`; and
- `README.md`.

Strict-matcher regressions cover the four tiers, tier priority, first-location
selection, anchors, intervening lines, pure additions, EOF, trailing-newline
sentinels, and local CRLF preservation.

## Findings

### S-001 — Identity chunks on a move are not validated

**Severity:** High

**Status:** Implemented and verified

Before the correction, an update-and-move whose old and replacement sequences
were structurally identical was treated as an opaque pure move. Supplied
context and expected content were not matched.

Example:

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

Previous result: `unexpected` was moved successfully.

Implemented correction:

- only a move with no chunks may bypass text validation;
- supplied identity or context chunks must validate source preconditions; and
- chunkless moves must remain byte-opaque and binary-safe.

Validation:

- stale identity chunks reject without moving the source;
- valid identity chunks permit the move;
- context-only chunks constrain the source;
- invalid UTF-8 still moves through chunkless syntax; and
- symlink and hard-link pure-move behavior remains unchanged.

### S-002 — Byte-identical entry replacement can broaden the write set

**Severity:** High

**Status:** Implemented and verified

Before the correction, execution accepted a changed entry identity when its
bytes still equaled the planned bytes. Byte equality does not prove equivalent
hard-link topology.

Example:

1. preflight observes `source.txt` containing `old`;
2. an external action replaces it with a hard link to `collateral.txt`, also
   containing `old`;
3. execution accepts the byte-identical replacement; and
4. updating `source.txt` also changes `collateral.txt`.

An equivalent ancestor-symlink variant could redirect the write:

1. preflight resolves a regular parent directory and target containing `old`;
2. an external action replaces that parent with a symlink to another tree
   whose target also contains `old`;
3. execution accepts the byte-identical target; and
4. the update writes outside the preflighted tree.

Implemented correction:

- in-place text updates reject entry-identity drift even when bytes are
  unchanged;
- preflight records the resolved regular-file target and every directory and
  symlink route entry;
- execution opens the source without truncating, verifies the opened inode and
  bytes, revalidates the route, and writes through that descriptor;
- a pathname swap after opening cannot redirect the write to the replacement
  inode;
- expected link counts use exact physical deltas from earlier committed
  operations instead of accepting any link-count difference after a release;
  and
- entries and parent directories created by earlier instructions receive
  committed identities for later route and target validation.

Validation:

- byte-identical inode replacement rejects before writing;
- a replacement hard-linked to collateral content cannot modify that content;
- an alternate symlink route to the same hard-linked target inode rejects;
- replaced source symlinks and resolved target inodes reject;
- externally increased link counts reject;
- a final pathname swap writes only the validated inode and reports the lost
  binding;
- changed bytes and changed entry types continue to reject; and
- exact link-count changes and parent creation produced by the same plan remain
  accepted.

### S-003 — No-change postconditions are not revalidated

**Severity:** High under concurrent mutation

**Status:** Implemented and verified

Before the correction, no-change instructions created no planned mutation and
therefore received no execution-time validation.

Examples:

- an identical add is classified `NO CHANGE`, the file changes before
  execution, and the patch still reports success;
- an absent delete is classified `NO CHANGE`, the path is created before
  completion, and the patch still reports success.

Implemented correction:

- state-dependent no-change assertions execute in source order alongside
  mutations rather than in one final pass;
- identical adds revalidate bytes, regular-file type, and exact spelling while
  allowing a byte-identical replacement inode;
- absent deletes revalidate absence without dynamically promoting a stale
  no-op into a deletion;
- unchanged updates reapply only the official strict matcher and require the
  current derived output to remain unchanged;
- same-entry moves revalidate alias identity and supplied text chunks;
- fulfilled moves require an absent source and the destination identity
  committed by the referenced earlier instruction, while chunkless moves leave
  content unconstrained; and
- empty updates, identity updates without moves, and chunkless lexical
  self-moves remain unconditional no-ops.

Validation:

- identical-add byte, type, and spelling drift rejects, while byte-identical
  inode replacement remains accepted;
- absent-delete creation drift rejects and source-order delete/add chains
  remain valid;
- unchanged-update constrained drift rejects while unrelated drift accepted by
  strict reapplication remains valid;
- same-entry alias and identity-chunk drift rejects;
- fulfilled-move source recreation, destination replacement, and supplied
  chunk drift reject;
- fulfilled checks run before later same-patch mutations and chunkless content
  remains unconstrained;
- later state-dependent no-ops become `NOT RUN` after an earlier failure; and
- a stable no-change plan performs no filesystem mutation.

### S-004 — Repeated identical adds ignore earlier virtual spelling

**Severity:** Medium

**Status:** Confirmed; implementation not approved

Two identical adds to one initially absent path are both planned and executed.
The second instruction should observe the first instruction's virtual result
and become `NO CHANGE`.

Required correction:

- identical-add classification must use virtual content and exact virtual
  spelling;
- live filesystem spelling must not override earlier planned operations; and
- case, Unicode, and symlink-parent aliases must use the established virtual
  identity rules.

Required tests:

- repeated identical adds produce one mutation and one `NO CHANGE`;
- equivalent case and Unicode spellings follow host alias behavior;
- a different second add remains a replacement; and
- instruction feedback attributes the mutation and no-change result correctly.

## Planned workstreams

### Workstream 1 — Move preconditions and virtual add state

**Status:** Partially implemented; S-004 remains not approved

Completed scope:

- implemented S-001;
- preserved chunkless opaque moves;
- updated the semantic and user-facing documentation while retaining the
  existing feedback format; and
- added the required S-001 regressions.

Remaining scope:

- implement S-004 only after separate approval; and
- update its semantic and feedback documentation and regressions.

Completion criteria:

- stale identity chunks cannot move an unexpected entry;
- repeated identical adds produce one mutation followed by `NO CHANGE`; and
- chunkless moves retain existing byte, symlink, hard-link, and move semantics.

### Workstream 2 — Execution identity and no-change revalidation

**Status:** Completed

Completed scope:

- implemented S-002;
- rejected unsafe entry and route drift for in-place writes;
- bound writes to a validated open descriptor;
- preserved exact identity and link-count changes caused by the current plan;
- added inode replacement, hard-link collateral, route drift, and descriptor
  binding regressions.
- implemented S-003 with source-ordered, read-only assertions for every
  state-dependent no-change classification;
- preserved unconditional no-op semantics; and
- added drift, ordering, compatibility, and no-mutation regressions.

Completion criteria:

- byte-identical external replacement cannot broaden the write set; and
- no-change success depends on a postcondition still true at the instruction's
  source-order position.

## Safeguards that remain unchanged

The strict-matching cleanup did not change:

- complete semantic planning before writes;
- symlink, hard-link, case, Unicode, or parent-alias modeling;
- source and destination mutation-queue participation;
- native or cross-filesystem move execution;
- pure-move byte preservation;
- low-level failure inspection; or
- per-instruction effect attribution.

## Completed validation

The permanent strict-matching cleanup passed:

- 9 focused strict-matcher tests;
- 283 full-suite tests, with 2 live tests skipped;
- `npm run check`; and
- `npm run pack:dry`.

The full suite included the existing symlink, hard-link, repeated-path,
same-filesystem move, and cross-filesystem move coverage.

The S-001 correction passed:

- all 45 semantic-planner and execution tests;
- 289 full-suite tests, with 287 passed and 2 live tests skipped; and
- `npm run check`.

The S-002 correction passed:

- all 49 semantic-planner and execution tests, including byte-identical inode,
  hard-link, route, descriptor-binding, and exact planned-link-count cases;
- 293 full-suite tests, with 291 passed and 2 live tests skipped; and
- `npm run check`.

The S-003 correction passed:

- all 58 semantic-planner and execution tests, including nine source-order,
  drift, compatibility, and no-mutation cases;
- 302 full-suite tests, with 300 passed and 2 live tests skipped; and
- `npm run check`.

## Decision log

| Date       | Decision                                                   | Rationale                                                                                            |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2026-08-20 | Disable formatter-tolerant mutation after strict failure.  | Immediate containment prevented the unsafe fallback from writing.                                    |
| 2026-08-20 | Remove formatter-tolerant matching permanently.            | Strict Codex compatibility provides one source-traceable eligibility path.                           |
| 2026-08-22 | Retain only unresolved semantic and execution safety work. | Completed trackers and superseded matcher redesign plans duplicated current normative documentation. |
| 2026-08-23 | Validate supplied chunks before pure moves.                | Text preconditions now constrain moves while chunkless syntax preserves opaque entry semantics.      |
| 2026-08-23 | Bind in-place writes to validated filesystem identity.     | Matching bytes cannot authorize a different inode, route, or hard-link write set.                    |
| 2026-08-23 | Revalidate state-dependent no-change results.              | A stale preflight no-op cannot silently report success or be promoted into an unplanned mutation.    |
