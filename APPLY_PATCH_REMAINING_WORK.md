# Remaining `apply_patch` Work

## Status

All agreed work in this tracker is complete. It records the implementation and
test decisions identified by the fresh review after commit `9efb4dc`.

The semantic decisions in `APPLY_PATCH_SEMANTIC_OPERATIONS.md` remain
authoritative. This document records confirmed defects, agreed follow-up work,
open decisions, required tests, and documentation corrections so the work can
continue independently of the conversation that produced it.

Official Codex was compared at:

```text
0bdce9f424eb9b39d7b3a8811742d10b6fbf8d54
```

Final validation baseline:

- `npm test`: 279 passed, 2 skipped
- `npm run check`: passed

The final fresh-review pass additionally closed:

- operation-aware queue keys for cyclic or inaccessible symbolic links;
- sequential future add/delete replay in hard-link dead-update proofs;
- cancellation preservation inside Tree-sitter parsing; and
- source-entry device selection for pure-move strategy planning.

The implementation pass also corrected destination-relative target resolution
and fresh identity for moved symbolic links.

The final feedback pass:

- retained the aggregate changed-file summary;
- added unlimited source-ordered model and TUI instruction results;
- colocated no-change, skipped, failed, and not-run feedback;
- recorded partial filesystem effects on the instruction that produced them;
- added deterministic post-failure path inspection;
- retained confirmed partial-move effects when later inspection is unavailable;
- avoided rendering a partial move as a completed rename;
- reported parent-directory and temporary-entry effects without claiming that
  no filesystem change occurred;
- removed model-facing committed-prefix and diff-availability terminology;
- stopped repeating old or replacement patch blocks in model feedback; and
- deduplicated byte-identical matcher candidates before exhaustive-search
  limits.

The subsequent presentation pass added a default-off `applyPatchDebug`
setting. Completed collapsed results can show the exact model-facing text,
while expanded results retain the normal visual summary and complete diffs.

The full feedback contract is recorded in
`APPLY_PATCH_INSTRUCTION_FEEDBACK.md`.

## Dictionary

- **Strict matching path:** The official Codex-compatible exact,
  trailing-whitespace, fully trimmed, and Unicode matching path used before
  formatter-tolerant recovery.
- **EXDEV:** The operating-system error returned when a native rename crosses
  filesystem boundaries and must instead use copy-and-unlink behavior.
- **Mutation-queue alias:** A different path or physical identity that can
  mutate the same filesystem state but may receive a different Pi mutation
  queue key.
- **Opaque entry operation:** A path operation whose correctness does not
  require decoding or recording the entry's bytes as text.

## Completed foundation

The following decisions are implemented and are not reopened by this tracker:

- grammar-valid empty and move-only updates are accepted;
- harmless operations become no-ops;
- repeated operations are evaluated sequentially through virtual state;
- inapplicable operations are skipped only through a semantic dead-operation
  proof;
- pure moves preserve opaque bytes and use native rename when possible;
- the agreed case, Unicode, hard-link, and symbolic-link semantics are
  implemented for the covered same-filesystem paths;
- official Codex strict matching priority and first-match behavior remain
  first;
- formatter recovery uses exhaustive final-byte equivalence without candidate
  scoring;
- Tree-sitter recovery requires complete physical lines and at least two
  concrete old-side tokens;
- every old-side token, including punctuation, is exact;
- replacement lines are opaque instructions and are not parsed, normalized,
  dedented, reindented, or token-mapped;
- optional-comma normalization and Markdown prose recovery are removed;
- rigid Markdown table and typed-fence recovery remain;
- formatter failures have structured matcher diagnostics; and
- pure moves have path-only history and rendering.

The following previously rejected review proposals remain rejected:

- requiring a dedicated `UnknownResult` data type rather than an equivalent
  semantic proof;
- rejecting grammar-valid bare or repeated `@@` chunks merely because
  Codex's streaming parser rejects them;
- accepting an update because its requested replacement already appears;
- heuristic candidate ranking;
- language-specific contextual-keyword blacklists;
- generic Markdown prose recovery; and
- sub-line or single-token structural recovery.

## Workstream 1: Preserve CRLF on the strict matching path

**Status:** Complete.

### Current behavior

Official Codex splits source content on `\n`. In a CRLF file, the retained
source lines therefore end in `\r`. Its trailing-whitespace matching tier can
match those lines against patch lines without `\r`, after which the patch's new
lines are inserted without `\r` and the result is joined with `\n`.

Our strict path currently follows that behavior. For example:

```text
source: old\r\nnext\r\n
patch:  old -> new
result: new\nnext\r\n
```

Official Codex therefore has the same mixed-line-ending behavior. We have
already decided to improve on it rather than preserve this defect.

### Existing CRLF fix

The existing fix applies only after strict matching fails:

- line replacements use `lineEndingForLine`;
- insertions use `lineEndingAtBoundary`; and
- structural replacements inspect the matched source line ending.

These formatter-tolerant paths preserve local CRLF correctly. They are bypassed
when strict matching succeeds.

### Required implementation

- Preserve the local source line ending when applying strict-path replacements
  and insertions.
- Do not alter untouched line endings.
- Keep official matching-mode priority and first-match location behavior.
- Preserve explicit replacement text other than converting parsed line
  separators to the local source convention.

### Required tests

- strict single-line CRLF replacement;
- strict multi-line CRLF replacement;
- strict insertion into a CRLF file;
- strict deletion from a CRLF file;
- strict replacement with unchanged context lines;
- EOF replacement and insertion in a CRLF file; and
- mixed-line-ending input where only the matched region's local convention is
  used.

## Workstream 2: External replacement with identical bytes

**Status:** Accepted current behavior; no implementation required.

### Current behavior

If an entry fingerprint changes after preflight, `assertEntryMatches` accepts
the new entry when planned content bytes still match. This also applies when
there is no earlier mutation in the same plan proving where the replacement
came from.

The following was reproduced:

```text
1. Preflight observes inode A containing "old".
2. An external actor atomically installs inode B containing the same "old".
3. apply_patch accepts inode B and writes "new" into it.
```

### Practical risk

The ordinary text result is usually still what the user requested, so the risk
is low in a single-session workflow with no external file writers. The
identity difference becomes material when the replacement changed:

- hard-link topology, causing the edit to propagate to unexpected aliases or
  stop propagating to intended aliases;
- file mode, ownership, ACLs, extended attributes, or other metadata;
- the identity of a symbolic-link target while retaining the same bytes; or
- another actor's deliberate atomic replacement or safe-save result.

The vulnerable interval is narrow: after preflight and before the relevant
mutation. Plausible actors include editors using atomic save, formatters,
package managers, Git operations, watchers, and concurrent agent sessions.

### Decision

The practical risk is accepted. Byte-identical external replacement remains
eligible even when the entry fingerprint changed. This tolerance is not used
to justify a match when source bytes differ.

No new external-identity rejection or tests are required by this tracker.

Tests that already reject changed content and incompatible entry types remain
required.

## Workstream 3: Model cross-filesystem move topology correctly

**Status:** Complete.

### Defect

A native pure move preserves the source inode and its relationship with
remaining hard links. An EXDEV copy-and-unlink creates an independent
destination entry.

The virtual filesystem currently models every pure regular-file move as
preserving the source content cell. For example:

```text
x and y are hard links on filesystem A
Move x -> z on filesystem B
Update z
Update y
```

After the real cross-filesystem move, `z` is independent and `y` retains the
old inode. The virtual plan currently treats changes through `z` as visible
through `y`.

### Required implementation

Select and record the move strategy during preflight:

1. Determine the source-entry filesystem from its `lstat` fingerprint.
2. Determine the destination filesystem from its existing parent or nearest
   existing ancestor, following a directory symlink when applicable.
3. For a same-filesystem native move, preserve the source physical-content
   relationship.
4. For a cross-filesystem move, create a fresh destination identity and
   independent content cell while decrementing the source inode's remaining
   link count.
5. Execute the strategy that was planned. A same-filesystem rename that
   unexpectedly returns EXDEV must not silently switch to a topology that
   invalidates later planned operations. It should fail before mutation unless
   the planner has explicitly proven both outcomes equivalent.

The destination receives the same bytes and relevant supported metadata, but
it must not retain the source inode or hard-link identity in virtual state.

### Required tests

- cross-filesystem regular-file move with one source link;
- cross-filesystem source with another hard link;
- update destination after cross-filesystem move;
- update remaining source hard link after cross-filesystem move;
- delete or move destination after cross-filesystem move;
- destination overwrite;
- destination creation or replacement followed by failed source removal;
- destination removal followed by failed replacement;
- per-instruction effect and deterministic final-state reporting; and
- same-filesystem native hard-link behavior remains unchanged.

Tests should use an injectable filesystem-operation boundary or deterministic
EXDEV simulation rather than depending exclusively on host mount layout.

## Workstream 4: Represent symbolic-link deletion as an entry operation

**Status:** Complete.

### Defect

After a text update follows a symbolic link, the symlink's virtual content cell
can share the target's loaded text. Deleting the symlink later then records the
target bytes as deleted content.

The filesystem result is correct—the link is removed and the target remains—but
history and coalesced rendering can imply that the target text was deleted.

### Required implementation

- Extend delete history with entry type, at least:

  ```text
  regular-file | symbolic-link
  ```

- A symbolic-link deletion must be path-only:
  - no target bytes;
  - no textual deletion diff;
  - `+0 -0`; and
  - optionally render as `Deleted symbolic link <path>`.
- Never obtain symbolic-link delete content from the target's content cell.
- Keep an earlier update-through-link and the later link-entry deletion as
  separate rendered changes.

The coalescer already avoids collapsing repeated changes when a delete has no
textual content; this behavior should be retained and tested.

### Required tests

- direct live-symlink deletion;
- direct dangling-symlink deletion;
- update through symlink followed by deletion of the symlink;
- update target directly followed by deletion of an alias symlink;
- repeated rendering does not claim target text was deleted; and
- model/session history contains no target bytes for the symlink deletion.

## Workstream 5: Account for earlier planned hard-link removals in dead proofs

**Status:** Complete.

### Defect

Given hard-linked `a.txt` and `b.txt`:

```text
Delete a.txt
Update b.txt with an inapplicable old side
Delete b.txt
```

The update is unobservable because every remaining link is deleted. It
currently rejects because dead-update analysis compares future deletions with
the original `nlink` and does not subtract the earlier planned deletion.

### Required implementation

- Track the effective physical link count in virtual state.
- Apply link-count deltas for earlier planned operations:
  - delete or replacement of one hard-link entry decrements the count;
  - state-changing move removal decrements it;
  - native pure move is link-count neutral;
  - cross-filesystem copy-and-unlink decrements the source count and creates an
    independent destination;
  - no-op add and same-entry operations remain neutral.
- Dead-update analysis must compare future dominating removals with the
  effective count at the failed update, not the original filesystem count.
- Case, Unicode, and symbolic-link-parent aliases must not be double-counted as
  distinct hard links.

### Required tests

- earlier delete plus later deletion of the last link makes the update dead;
- earlier replacement plus later deletion of the last link;
- earlier native move does not reduce link count;
- cross-filesystem move does reduce source link count;
- deleting only some remaining links still rejects;
- an intervening read through any remaining link still rejects; and
- alias spellings of one entry count once.

## Workstream 6: Explain instructions without filesystem effects

**Status:** Complete.

### Current behavior

Model and TUI output retain the aggregate summary:

```text
Success. No files were changed.
```

It is followed by every source-ordered result:

```text
Patch instruction results:
1. [NO CHANGE] Update missing.txt - The instruction contains no changes.
2. [NO CHANGE] Update same.txt - Old and replacement content are identical.
3. [SKIPPED] Update old.txt - Instruction 4 determines the final filesystem state before another instruction reads it.
```

Model and TUI feedback have no instruction limit. Concise reasons remain on
their instructions, and the TUI may style status labels while model feedback
remains plain ASCII.

A structured reason should use stable codes rather than unrelated free-form
strings, for example:

```text
empty-update
identity-update
content-already-present
path-already-absent
same-entry-move
move-already-fulfilled
dead-dominated
```

Semantic elimination returns related instruction numbers so the concise
`SKIPPED` result can identify them without a detached proof section.

### Required tests

- one fixture for every no-op reason;
- dead update dominated by delete;
- dead update dominated by add;
- all-no-change model output;
- all-skipped model output;
- mixed applied/no-change/skipped model output;
- collapsed and expanded TUI instruction results; and
- 1, 8, 9, 100, and 500-instruction results contain every instruction.

## Workstream 7: Add structured context to execution failure model output

**Status:** Complete.

### Current behavior

Model and TUI feedback now share an aggregate changed-file summary and, when
any instruction is not applied or an applied instruction has feedback, an
unlimited source-ordered `Patch instruction results:` ledger.

### Required implementation

- Attribute concise errors, completed filesystem effects, and deterministic
  final path states to the failed instruction.
- Include every instruction without an omitted-count limit.
- Omit the ledger only when every instruction is applied without feedback.
- Explain every not-run instruction by referencing the failed instruction.
- Avoid duplicating raw errors or old/replacement patch text.
- Preserve the current exit-code and wall-time wrapper.
- Reuse the canonical instruction-result formatter for model and TUI output.
- Model-facing move labels use `->`, not a Unicode arrow.
- Model-facing status output uses plain ASCII words rather than TUI symbols.

### Required tests

- failure before the first mutation;
- failure after one completed instruction;
- partial write with deterministic post-failure inspection;
- failed state-changing move after destination creation or replacement;
- failed cross-filesystem replacement;
- cancellation after a committed operation; and
- model output and TUI details describe the same statuses.

## Workstream 8: Mutation-queue aliases

**Status:** Complete for same-process `apply_patch` calls.

### Current behavior

Pi's mutation queue serializes calls by a canonical path string. Existing
symlink targets generally collapse through `realpath`, and our
`realpathWithMissingTail` handles missing descendants below an existing
symlinked parent.

Two kinds of aliases can still receive different queue keys:

1. On a case- or Unicode-insensitive filesystem, two missing leaf spellings
   such as `Foo` and `foo` may identify the same future entry, but neither can
   be resolved before creation.
2. Existing hard-link paths have different real paths even though text writes
   mutate the same inode.

Therefore, two concurrent in-process calls can each acquire a different lock,
preflight simultaneously, and mutate shared state without serialization.

### Practical scope

- `apply_patch` uses sequential execution within one Pi session.
- Pi's current queue is a module-local in-memory map. It can coordinate only
  callers sharing one Pi process and module instance.
- Ordinary separately launched Pi sessions are separate processes and do not
  share Pi's queue.
- The risk inside the supported scope requires concurrent sessions, agents, or
  tools hosted in the same Pi process.
- Cross-process serialization, including ordinary separate Pi CLI sessions,
  remains outside both Pi's queue contract and this extension-local queue.
- The risk is low for ordinary single-session use but real for concurrent
  agent workflows and hard-linked files.

### Required implementation

- Add an extension-local logical-key queue shared by `apply_patch` calls in the
  same process.
- Continue to acquire Pi's ordinary path queues as well.
- Acquire every logical and path key in deterministic sorted order.
- Missing case/Unicode leaf keys use the planner's proven filesystem alias
  policy.
- Existing regular files additionally acquire physical `device:inode` keys.
- Hard-linked entries still acquire distinct directory-entry keys because
  replacement operations affect only one link.
- Document that the local queue does not coordinate with separate Pi processes
  or unrelated Pi edit/write tools.

### Required tests

- concurrent missing case-only aliases;
- concurrent missing Unicode-normalization aliases;
- concurrent hard-link text updates;
- hard-link replacement locks the entry path and shared physical identity;
- existing symlink-parent aliases use one logical queue; and
- deterministic multi-key ordering prevents deadlocks.

## Accepted non-work: Structural source/token bounds

No new source-size or token-count limit is required. Existing candidate and
mapping bounds remain. Deterministic scanning and cancellation checks should
not be weakened, but this tracker does not require an additional file-size
policy.

## Additional required test coverage

**Status:** Complete on supported host facilities; block-device coverage runs
when a block-device entry is available.

The following gaps must be closed in addition to the workstream-specific
tests:

- cancellation before queue acquisition, after queue acquisition, during
  matcher work, before the first mutation, and between mutations;
- FIFO, Unix socket, character-device, block-device where available, and
  directory rejection;
- parser initialization failure followed by a successful retry;
- grammar-language load failure followed by a successful retry;
- mutation-queue path participation for every source and move destination;
- missing-tail paths below symlinked parents;
- native move failure with no committed mutation;
- Windows rename-over-existing behavior, either through Windows CI or an
  injectable filesystem-operation test boundary;
- exact committed-prefix details after every injected execution failure; and
- no target or opaque binary bytes leak into textual history.

Tests that cannot depend portably on host filesystem facilities should use
injectable filesystem operations rather than silently remaining uncovered.

## Documentation corrections

**Status:** Complete.

### `APPLY_PATCH_SEMANTIC_OPERATIONS.md`

- Remove the false claim that official Codex categorically rejects duplicate
  resolved targets. Official verification stores changes in a `HashMap` and
  can replace preview entries, while runtime hunks are executed sequentially.
- Expand the deliberate-differences section to include identity no-ops,
  identical-add no-ops, self-moves, operation-specific symlink behavior,
  semantic preflight, dead-operation handling, and formatter recovery.
- Mark the strict CRLF, cross-filesystem, history, queue, and remaining test
  requirements accurately until completed.
- Keep the exact-token, opaque-replacement, and no-heuristic decisions
  unchanged.

### `README.md`

- Replace “symlinks follow normal host filesystem semantics” with the
  operation-specific policies.
- Document move-only opaque moves, sequential repeated-path behavior, no-op and
  dead instructions, exact formatter recovery boundaries, and failure
  rendering.
- Describe mutation-queue scope accurately.
- Explain that optional punctuation differences and plain Markdown reflow are
  intentionally rejected.

### `CHANGELOG.md`

- Record each completed runtime correction under `Unreleased`.
- Do not claim complete CRLF, cross-filesystem, or no-op explanation behavior
  before the corresponding tests pass.

## Implementation order

1. Fix strict-path CRLF preservation.
2. Implement effective hard-link count tracking.
3. Implement planned same-filesystem versus cross-filesystem move topology.
4. Correct symbolic-link deletion history.
5. Implement the extension-local logical-key queue.
6. Improve no-op/dead model and TUI explanations.
7. Improve execution-failure model output through the shared explanation
   formatter.
8. Close the remaining failure, cancellation, special-entry, queue, parser
   retry, and platform test gaps.
9. Reconcile the semantic reference, README, and changelog.
10. Run the complete test and check suites and perform a final official Codex
    comparison.

## Completion criteria

This follow-up is complete when:

1. every agreed workstream has implementation and regression tests;
2. every open decision above is resolved and recorded in the semantic
   reference;
3. strict and formatter-tolerant paths preserve the agreed line-ending
   behavior;
4. virtual and executed hard-link topology agree for native and
   cross-filesystem moves;
5. symlink entry deletion never records target bytes as deleted;
6. every no-op/dead result explains its reason to both the model and TUI;
7. model feedback remains ASCII-only while TUI feedback may use Unicode
   symbols;
8. every failure phase gives the model and TUI consistent structured context;
9. same-process aliasing `apply_patch` calls share extension-local logical
   queues;
10. the required test matrix contains no unimplemented entries; and
11. documentation accurately distinguishes official alignment, intentional
    divergence, and remaining limitations.
