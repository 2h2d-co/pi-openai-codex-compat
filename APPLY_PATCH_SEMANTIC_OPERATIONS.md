# Semantic `apply_patch` Operations

## Status

This document is the implementation reference for extending
`pi-openai-codex-compat` beyond official Codex CLI behavior where the
`apply_patch` Lark grammar already permits semantically valid operations.

The extension intentionally accepts move-only update hunks and harmless
redundant operations even when the official Codex parser rejects them. This is
a conscious compatibility divergence, not an accidental parser discrepancy.

The objective is semantic correctness, not pedantic tool-call validation:

> Accept a grammar-valid operation when it can be applied safely, is already
> satisfied, or can be proven irrelevant to the final filesystem state.
> Reject an operation only when its intended effect is ambiguous, conflicting,
> or unsafe.

## Dictionary

- **Directory entry:** A named filesystem entry such as a regular file or
  symbolic link. A pure move operates on this entry, not on decoded text.
- **Dominating operation:** A later operation that unconditionally determines
  a path's state, making an earlier result at that path irrelevant.
- **Dead operation:** An operation whose removal provably leaves the same final
  observable filesystem state and does not change anything observed by an
  intervening operation.
- **Identity update:** An update whose old and new line sequences are
  structurally identical and therefore has no content effect.
- **Opaque content:** File content that has not been decoded as text. It may be
  valid UTF-8, binary data, or an empty byte sequence.
- **Pure move:** An `Update File` hunk with a `Move to` destination and no
  state-changing content chunks.
- **Virtual filesystem:** The ordered, in-memory model used during preflight to
  simulate every operation before performing writes.

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** use
their usual requirements-language meanings.

## Grammar baseline

The relevant official Lark rule is:

```lark
update_hunk: "*** Update File: " filename LF change_move? change?
```

Both `change_move` and `change` are optional. The grammar therefore allows all
of the following:

### Empty update

```text
*** Begin Patch
*** Update File: A
*** End Patch
```

### Pure move

```text
*** Begin Patch
*** Update File: A
*** Move to: B
*** End Patch
```

### Move followed by another operation at the old path

```text
*** Begin Patch
*** Update File: A
*** Move to: B
*** Update File: A
@@
-old
+new
*** End Patch
```

The grammar does not require distinct paths across operations. Repeated and
aliased paths are therefore valid syntax and MUST be evaluated semantically in
source order.

The grammar itself does not change as part of this work. The parser and
executor are being brought into alignment with structures the grammar already
accepts.

## Governing principles

### 1. Operations are evaluated sequentially

Each operation consumes the virtual state produced by preceding operations.
Operations are not simultaneous, and the implementation MUST NOT invent
swap-like behavior.

For example:

```text
Move A -> B
Move B -> C
```

leaves the original `A` entry at `C`.

```text
Move A -> B
Move B -> A
```

moves the original entry back to `A`; it is not a swap.

### 2. Harmless redundancy is accepted

An operation MUST NOT be rejected merely because its desired postcondition
already holds.

Examples:

- deleting an absent path;
- an empty update without a move;
- an identity update without a move;
- adding bytes that are already exactly present;
- a self-move whose source and destination are the same resolved path.

Such operations become successful no-ops.

### 3. Unobservable dead operations may be skipped

An otherwise inapplicable operation MAY be skipped when the planner proves
that removing it produces the same final observable filesystem state.

The proof MUST account for:

- every source path read by intervening operations;
- every source and destination path written by the candidate operation;
- path existence and entry type, not only content;
- parent directories that would be created;
- move source removal;
- destination overwrite behavior; and
- relevant metadata or directory-entry effects.

If equivalence cannot be proven, the patch MUST be rejected before writes.
The implementation MUST NOT guess that an operation was probably redundant.

### 4. A valid final state does not excuse an observed invalid intermediate state

A later dominating operation makes an earlier result dead only when no
intervening operation observes that result.

Safe:

```text
Move A -> B
Update A       # Cannot apply because A is absent.
Delete A       # Unconditionally leaves A absent.
```

The failed update may be skipped because no operation reads its hypothetical
result and `Delete A` determines the final state.

Not safe:

```text
Move A -> B
Update A       # Cannot apply.
Move A -> C    # Reads the unknown result of the failed update.
Delete A
```

This patch MUST be rejected because `Move A -> C` observes the result that the
planner cannot derive.

### 5. Preflight is side-effect free

The complete patch MUST be parsed, resolved, simulated, and classified before
the first filesystem mutation.

Each operation is classified as one of:

- **apply** — a concrete safe mutation;
- **no-op** — its postcondition already holds or it has no semantic effect;
- **dead** — it is inapplicable, but its removal is proven unobservable; or
- **conflict** — its effect is ambiguous, unsafe, or observable but cannot be
  derived.

Any conflict rejects the complete patch without writes.

### 6. Content is decoded only when content is edited

A pure move is byte-opaque. It MUST NOT decode, normalize, hash, diff, or
rewrite file contents merely to move the entry.

A state-changing update chunk is a line-oriented text operation and therefore
continues to require valid UTF-8.

## Operation semantics

### Add file

`Add File: P` unconditionally writes its grammar-provided content to `P`.
Existing destination overwrite behavior is retained.

- If `P` already contains exactly the requested bytes, the operation is a
  no-op.
- If `P` is absent, it is created along with missing parent directories.
- If `P` is an existing regular file, it is overwritten.
- If `P` is a directory or another unsupported special entry, reject.
- The operation does not semantically depend on previous file content, even
  though rendering or history code may inspect it.

An add is a dominating operation for the resulting content and existence of
its target path.

### Delete file

`Delete File: P` has the postcondition that the directory entry `P` is absent.

- If `P` is already absent, succeed as a no-op.
- If `P` is a regular file or symbolic link, remove that entry.
- If `P` is a directory, reject; never reinterpret the operation as recursive
  deletion.

A delete is a dominating operation for absence at its target path.

### Empty update without a move

An `Update File` hunk with neither a move nor content chunks has no observable
effect and succeeds as a no-op, regardless of whether the path currently
exists.

### Identity update without a move

An update is structurally identity-only when every chunk's old and new line
sequences are equal and the operation has no other content effect.

An identity-only update without a move succeeds as a no-op. It MUST NOT rewrite
the file, normalize line endings, add a trailing newline, or require the target
to exist.

### Text update without a move

A state-changing text update:

1. requires the source path to resolve to an updatable file;
2. decodes its bytes as UTF-8;
3. applies ordered chunks using the established Codex context and fuzzy
   matching behavior; and
4. writes the derived bytes back to the same path.

If the source is absent or cannot be decoded, reject unless the operation is
proven dead.

If normal old-line matching fails, the planner MAY accept the operation as
already satisfied only when it can prove that every requested replacement is
already present at the uniquely identified location. Merely finding similar
new text somewhere in the file is insufficient.

Pure insertion chunks require particular care: existing matching text does
not by itself prove that another insertion would be a no-op because duplicate
insertion may be intentional.

### Pure move

A pure move is represented by:

```text
*** Update File: SOURCE
*** Move to: DESTINATION
```

It has these postconditions:

- the source directory entry is absent; and
- the same entry is present at the destination, replacing an existing
  destination according to established overwrite semantics.

Pure moves:

- MUST support arbitrary regular-file bytes, including invalid UTF-8, NUL
  bytes, empty files, BOMs, CRLF, CR, mixed line endings, and files without a
  trailing newline;
- MUST NOT pass content through the text update engine;
- MUST preserve content bytes exactly;
- SHOULD use a native filesystem rename when source and destination are on the
  same filesystem;
- SHOULD preserve file metadata through the native rename;
- MUST move a source symbolic link as a directory entry rather than
  dereferencing and rewriting its target;
- MUST replace a destination symbolic link as an entry rather than writing
  through it;
- MUST reject source directories and unsupported special files; and
- MUST create missing destination parent directories consistently with
  existing move behavior.

If source and destination are on different filesystems, a byte-preserving
copy-to-temporary, destination-replace, and source-unlink fallback MAY be used.
The fallback MUST:

1. copy bytes without decoding or transforming them;
2. avoid exposing a partially copied destination;
3. replace the destination only after the temporary copy is complete;
4. remove the source only after destination installation succeeds; and
5. report the exact committed prefix if source removal or cleanup fails.

Metadata SHOULD be preserved where the platform permits it. Byte preservation
is mandatory.

### Move with identity chunks

If all supplied chunks are structurally identity-only, they have no content
effect. An accompanying move is therefore treated as a pure move.

The implementation MUST NOT force a byte-opaque file through UTF-8 decoding
solely to validate chunks that cannot alter its contents.

### Move with state-changing chunks

An update that both changes content and moves the result remains a textual
operation:

1. read and decode the source as UTF-8;
2. derive the new text;
3. write the result at the destination; and
4. remove the source entry.

Existing destination overwrite and partial-failure tracking behavior remains
in force.

This operation is not byte-opaque because it intentionally changes content.

### Deletion-only update chunks do not delete paths

This:

```text
*** Update File: A
@@
-only line
*** End Patch
```

leaves `A` present as an empty file. It is not equivalent to:

```text
*** Delete File: A
```

Therefore, an update that removes all text from an already absent path is not
harmless: skipping it would leave the path absent instead of present and
empty. Reject it unless a later dominating operation makes that distinction
unobservable.

## Repeated and related paths

Repeated operations on the same resolved path MUST NOT be rejected merely
because the path is repeated. They are evaluated sequentially against virtual
state.

Path identity must account for:

- relative and absolute spelling;
- `.` and `..` components;
- platform path separators;
- filesystem case behavior; and
- directory-entry identity where required for safe move execution.

Path normalization is used to understand dependencies, not to impose the
official Codex current-main rule that rejects all duplicate resolved targets.
This extension intentionally does not adopt that blanket rejection.

### Required examples

#### Update-and-move followed by deletion at the old path

The patch syntax combines update and move in one update hunk:

```text
*** Begin Patch
*** Update File: A
*** Move to: B
@@
-old
+new
*** Delete File: A
*** End Patch
```

After the first operation, `A` is absent and the updated content is at `B`.
Deleting `A` is a harmless no-op. The patch succeeds.

#### Pure move followed by deletion at the old path

```text
Move A -> B
Delete A
```

The delete is a no-op and the patch succeeds.

#### Move followed by an update at the old path

```text
Move A -> B
Update A
```

The update is handled as follows:

- empty update: no-op;
- identity-only update: no-op;
- state-changing update: conflict because `A` is absent;
- state-changing update followed by a dominating `Delete A`: dead and
  skippable if nothing observes `A` first;
- state-changing update followed by a dominating `Add File: A`: dead and
  skippable if nothing observes `A` first; or
- state-changing update after an intervening operation recreates `A`: apply to
  the recreated content normally.

The implementation MUST NOT silently redirect the update from `A` to `B`.

#### Move followed by an update at the destination

```text
Move A -> B
Update B
```

This is valid. The update consumes the moved entry.

If the moved entry contains arbitrary binary bytes and the second update is
state-changing, UTF-8 decoding fails and the patch is rejected before writes,
unless that text update is proven dead.

#### Recreate the old path

```text
Move A -> B
Add File: A
Update A
```

This is valid. The update applies to the newly added `A`.

#### Move chain

```text
Move A -> B
Move B -> C
```

This is valid for text and opaque binary entries.

#### Destination overwrite chain

```text
Move A -> B
Move C -> B
```

This is valid under established overwrite semantics. The second move replaces
the entry produced by the first move.

#### Missing source with an existing destination

```text
Move A -> B
```

If `A` is absent and `B` exists in the initial filesystem, do not assume the
move already happened. Destination content may be unrelated. Reject unless
same-patch provenance or filesystem identity proves that the move's
postcondition is already satisfied.

## Dead-operation analysis

The planner should model unknown results symbolically rather than immediately
rejecting them.

An unknown result can be eliminated only if all of its effects are dominated
before observation.

### Clear dominating operations

- `Add File: P` completely determines the resulting bytes and existence of
  `P`.
- `Delete File: P` completely determines that `P` is absent.

### Read and write sets

At minimum, dependency analysis uses these semantic sets:

| Operation                     | Reads             | Writes                                                 |
| ----------------------------- | ----------------- | ------------------------------------------------------ |
| Add `P`                       | none              | `P`, possibly missing parents                          |
| Delete `P`                    | entry type at `P` | absence at `P`                                         |
| Text update `P`               | bytes at `P`      | bytes at `P`                                           |
| Pure move `P -> Q`            | entry at `P`      | absence at `P`, entry at `Q`, possibly missing parents |
| Text update and move `P -> Q` | bytes at `P`      | absence at `P`, bytes at `Q`, possibly missing parents |

Rendering and history inspection do not make content semantically required for
an otherwise unconditional add, delete, or pure move.

### General elimination condition

An inapplicable operation may be marked dead only when:

1. no intervening operation reads any unknown value or entry state it would
   produce;
2. every unknown path state is replaced by a dominating operation;
3. its source-removal effect is already satisfied or later dominated;
4. any parent-directory effects are also reproduced or irrelevant; and
5. omitting it cannot change symlink, hard-link, metadata, or entry-type
   behavior visible in the final state.

The implementation MAY begin with conservative proofs for clear
add/delete-dominated cases. Unsupported proofs must become conflicts, not
unsafe acceptance.

## Filesystem identity edge cases

### Lexical self-move

These resolve to the same path and are no-ops when no content change is
requested:

```text
Move A -> A
Move A -> ./A
Move dir/../A -> A
```

The implementation MUST NOT perform write-then-unlink for a self-move because
that can delete the result.

For a self-move with state-changing chunks, perform an in-place text update.

### Case-only renames

On a case-insensitive filesystem, `A -> a` may be a meaningful directory-entry
rename even though both names resolve to the same underlying entry. Use a
filesystem-native rename strategy that preserves the result. Never resolve
this case by blindly unlinking the source after writing the destination.

### Hard links

Distinct hard-linked paths are distinct directory entries even though they
share an inode.

For a pure move `A -> B` where `A` and existing `B` are hard links to the same
file, the required postcondition remains:

- `A` absent;
- `B` present; and
- bytes unchanged.

Some native rename implementations report success without removing `A` when
both names identify the same inode. The executor must account for that case
without deleting `B`.

### Symbolic links

Pure moves operate on links themselves:

- moving a source symlink moves the link entry;
- overwriting a destination symlink replaces the link entry; and
- a pure move does not modify either link target.

Text updates retain the existing text-operation behavior and are not silently
converted into link-entry moves.

### Unsupported entry types

Directories, sockets, devices, FIFOs, and other special entries are outside
the pure-file move extension and MUST be rejected.

## Virtual filesystem and planning model

The virtual filesystem should distinguish at least:

```text
Absent
Directory
RegularFile(KnownTextBytes | OpaqueBytesReference)
SymbolicLink(LinkTarget)
UnsupportedEntry
UnknownResult
```

Opaque content should be represented by provenance and filesystem entry
metadata sufficient to execute the planned move. The planner does not need to
load or serialize bytes merely to move them.

Text decoding is lazy:

- pure move, delete, and unconditional overwrite do not decode;
- a state-changing text update decodes only the entry it consumes; and
- a moved opaque entry remains opaque until a later operation genuinely needs
  its text.

All source and destination paths, including move destinations, MUST
participate in Pi's file mutation queue. Queue acquisition order MUST be
deterministic to avoid deadlocks.

After queues are acquired, preflight reads the required state and constructs
the complete plan. Before executing each mutation, the implementation SHOULD
verify that the relevant directory entry still matches the planned identity
and metadata. Unexpected external changes cause a conflict rather than being
overwritten silently.

## Execution and failure behavior

### Ordered execution

Execute planned mutations in source order. Do not collapse operations in a way
that changes move chains, overwrite order, or intermediate observations.

No-op and dead operations produce no filesystem calls.

### Native rename

A same-filesystem pure move should use native rename semantics rather than
read/write/unlink. This preserves opaque bytes and normally preserves metadata
and atomicity.

Destination type and self-alias checks happen before rename.

### Partial failures

Low-level failures can still leave a committed prefix, especially for:

- cross-filesystem copy-and-unlink fallback;
- destination installation followed by failed source removal;
- permission changes between preflight and execution; or
- external filesystem races.

The tool result MUST retain the exact known committed path operations and mark
the result inexact when the final content or entry state cannot be proven.

The executor MUST NOT attempt destructive rollback unless a separately
designed and verified transactional mechanism exists.

### Cancellation

Cancellation is checked before preflight, after queue acquisition, and between
operations. It must not interrupt a native rename halfway, but may stop before
the next operation and report the committed prefix.

## Result history and rendering

Pure moves require a structured result that does not assume UTF-8 old/new
content. A dedicated move representation is preferred:

```text
Move {
  sourcePath
  destinationPath
  replacedDestination
  entryType
  exact
}
```

Do not store arbitrary binary file contents in Pi session history merely to
render a move. Size or non-sensitive entry metadata MAY be recorded, but
content hashes are not required for execution or display.

The collapsed and expanded TUI should render a pure move as a path operation,
for example:

```text
• Moved A -> B (+0 -0)
```

It must not attempt syntax highlighting or a textual binary diff.

If the destination was replaced, the UI should state that without exposing
opaque destination bytes.

Model-facing success output retains the existing summary style, with the move
destination reported as modified:

```text
Success. Updated the following files:
M B
```

If every operation is a no-op or dead, return successful output that clearly
states:

```text
Success. No files were changed.
```

Do not report a harmless redundant operation as an error.

Textual turn-diff aggregation must not claim reconstructable old/new text for
an opaque move. The path operation can still be exact even when no textual
delta exists; if the current history model cannot express that distinction,
invalidate or mark the aggregate textual diff inexact rather than serializing
binary content.

## Deliberate differences from official Codex

This extension intentionally differs from official Codex in these areas:

1. A grammar-valid empty update without a move succeeds as a no-op.
2. A grammar-valid move-only update is accepted.
3. Pure moves support arbitrary opaque binary files.
4. Repeated resolved target paths are evaluated sequentially instead of being
   rejected categorically.
5. Deleting an absent file succeeds as a no-op.
6. Inapplicable operations may be skipped when they are proven dead.

These differences do not authorize:

- changing the Lark grammar;
- silently redirecting old-path operations to move destinations;
- guessing that an existing destination came from a missing source;
- recursive directory operations;
- treating an empty file as an absent file;
- interpreting a deletion-only update as `Delete File`;
- decoding or rewriting opaque content during a pure move; or
- weakening Pi's mutation-queue integration.

## Required test matrix

### Parser and classification

- empty update without move parses as no-op;
- move-only update parses as pure move;
- identity chunks without move classify as no-op;
- identity chunks with move classify as pure move;
- state-changing chunks classify as text update;
- repeated and aliased paths parse without blanket rejection.

### Pure content-preserving moves

- ordinary UTF-8 file;
- invalid UTF-8 file;
- file containing NUL bytes;
- zero-byte file;
- UTF-8 BOM;
- CRLF file;
- CR-only file;
- mixed line endings;
- no trailing newline;
- executable regular file where metadata preservation is available;
- source symlink;
- destination symlink replacement;
- binary destination overwrite;
- missing destination parent;
- same-filesystem native rename;
- cross-filesystem fallback where test infrastructure permits it.

Every case must preserve source bytes exactly.

### Sequential semantics

- update-and-move `A -> B`, then delete `A`;
- pure move `A -> B`, then delete `A`;
- pure move `A -> B`, then update `B`;
- pure move `A -> B`, then state-changing update of absent `A` rejects;
- the same absent update followed directly by `Delete A` is dead;
- the same absent update followed directly by `Add File: A` is dead;
- an intervening read of the unknown `A` prevents elimination;
- move `A -> B`, add `A`, then update new `A`;
- move chain `A -> B -> C`;
- overwrite chain `A -> B`, then `C -> B`;
- move `A -> B`, then `B -> A` follows sequential, non-swap semantics;
- opaque binary move followed by delete;
- opaque binary move followed by state-changing text update rejects before
  writes unless dead.

### Identity and absence

- delete missing path succeeds;
- empty update of missing path succeeds;
- identity update of missing path succeeds;
- add of identical bytes succeeds without rewriting;
- missing source plus unrelated existing destination is rejected;
- deletion-only text update leaves an existing zero-byte file;
- deletion-only text update of an absent path rejects unless dead.

### Path identity

- `A`, `./A`, and normalized absolute aliases;
- lexical self-move;
- self-move with text changes becomes in-place update;
- case-only rename on case-insensitive filesystems;
- distinct hard links;
- source and destination hard links to the same inode;
- directory and unsupported special-entry rejection.

### Atomicity, preflight, and history

- any conflict prevents all writes;
- all involved paths participate in mutation queues;
- external drift after preflight is detected;
- native move failure leaves source intact when no mutation committed;
- cross-filesystem partial failure reports the committed prefix;
- pure binary move history contains no binary payload;
- pure move rendering is path-only;
- all-no-op patch reports success with no changed files; and
- mixed applied/no-op/dead patches report only actual filesystem changes.

## Acceptance criteria

The implementation is complete when:

1. every grammar-valid empty or move-only update is parsed;
2. harmless operations no longer reject an otherwise semantically correct
   patch;
3. conflicts are detected before writes;
4. pure moves never decode or transform file bytes;
5. binary, text, empty, symlink, and chained pure moves follow the documented
   semantics;
6. repeated paths are handled through ordered virtual state;
7. missing-file updates are skipped only under a sound no-op or dead-operation
   proof;
8. result history and rendering represent opaque moves without binary
   serialization; and
9. tests cover every required scenario above.
