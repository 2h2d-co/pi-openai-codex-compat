# Semantic `apply_patch` Operations

## Status

This document is the implementation reference for extending
`pi-openai-codex-compat` beyond official Codex CLI behavior where the
`apply_patch` Lark grammar already permits semantically valid operations.

The extension intentionally accepts move-only update hunks and harmless
redundant operations even when the official Codex parser rejects them. This is
a conscious compatibility divergence, not an accidental parser discrepancy.

The objective is semantic correctness, not pedantic tool-call validation:

> Accept a grammar-valid operation when it can be applied safely, has a
> directly verifiable no-op postcondition, or can be proven irrelevant to the
> final filesystem state.
> Reject an operation only when its intended effect is ambiguous, conflicting,
> or unsafe.

## Dictionary

- **Directory entry:** A named filesystem entry such as a regular file or
  symlink. A pure move operates on this entry rather than rewriting decoded
  text; supplied text chunks can still constrain whether the move is valid.
- **Dominating operation:** A later operation that unconditionally determines
  a path's state, making an earlier result at that path irrelevant.
- **Dead operation:** An operation whose removal provably leaves the same final
  observable filesystem state and does not change anything observed by an
  intervening operation.
- **Identity update:** An update whose old and new line sequences are
  structurally identical and therefore has no content effect.
- **Opaque content:** File content that has not been decoded as text. It may be
  valid UTF-8, binary data, or an empty byte sequence.
- **Path alias:** A different path spelling that identifies the same directory
  entry because of filesystem case or Unicode normalization behavior, or
  because a parent directory is reached through a symlink.
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
- unlinking a move source;
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

### 6. Content is decoded only when edited or explicitly constrained

A chunkless pure move is byte-opaque. It MUST NOT decode, normalize, hash,
diff, or rewrite file contents merely to move the entry.

A pure move with supplied identity or context chunks decodes the applicable
text target only to validate those chunks. Successful validation does not
rewrite, normalize, or otherwise transform the moved entry.

A state-changing update chunk is a line-oriented text operation and therefore
continues to require valid UTF-8.

## Operation semantics

### Add file

`Add File: P` establishes a regular-file entry at the exact requested path
spelling.

- If `P` already contains exactly the requested bytes, the operation is a
  no-op only when `P` is already a regular file at the requested exact
  spelling. This no-op does not break an existing hard-link relationship.
- Content and exact spelling are evaluated against source-ordered virtual
  state. An identical add after an earlier instruction established the same
  regular file is a no-op; live pre-execution spelling MUST NOT override that
  virtual result.
- If `P` is absent, it is created along with missing parent directories.
- If `P` is an existing regular file with different bytes, only the named
  directory entry is replaced by an independent regular file. Other hard links
  retain their original inode and contents. The replacement preserves the
  replaced regular file's permission bits.
- If `P` is a symlink, including a dangling link, the link entry is
  replaced by a regular file without writing through the symlink.
- If a case- or Unicode-normalized alias of `P` exists, that entry is replaced
  and the exact spelling requested by the add is established. A later
  identical add is a no-op only when it requests that established spelling.
- If `P` is a directory or another unsupported special entry, reject.
- The operation does not semantically depend on previous file content, even
  though rendering or history code may inspect it.

An add is a dominating operation for the resulting content and existence of
its target path.

### Delete file

`Delete File: P` has the postcondition that the directory entry `P` is absent.

- If `P` is already absent, succeed as a no-op.
- If `P` is a regular file or symlink, remove that entry.
- A symlink deletion is recorded as a path-only entry deletion. History
  and rendering MUST NOT serialize or claim deletion of the target bytes.
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
3. applies ordered chunks using the official-compatible strict matching
   behavior described below; and
4. writes the derived bytes back to the same path.

If the source is absent or cannot be decoded, reject unless the operation is
proven dead.

If the old side cannot be mapped, the update MUST be rejected. Finding the
requested replacement text in the current file does not prove that this update
was previously applied and MUST NOT make the operation a no-op.

After a valid strict mapping is found, derive the complete requested output.
If those derived bytes already equal the current file byte-for-byte, the
update is a verified no-op. This does not claim that the patch's old text
previously existed verbatim; it states only that applying the valid mapping
would not change the file.

Pure insertion chunks require particular care: existing matching text does
not by itself prove that another insertion would be a no-op because duplicate
insertion may be intentional.

An ordinary text update follows a symlink and edits its target. It also
edits the shared inode reached through a hard link, so every hard-linked entry
observes the new content and the hard-link relationship remains intact.

A state-changing update through a dangling symlink rejects during
preflight. This applies whether the link was initially dangling or an earlier
operation in the same patch deleted or moved away its target. The update MUST
NOT recreate the old target or redirect itself to a move destination. Empty
and identity-only updates retain their no-op semantics.

### Official-compatible strict text matching

Text matching uses the official Codex sequence algorithm and no additional
fallback:

1. search for an exact contiguous line sequence;
2. if none exists, search after trimming trailing Rust whitespace;
3. if none exists, search after trimming leading and trailing Rust
   whitespace; and
4. if none exists, search after trimming and normalizing Codex's supported
   Unicode dashes, quotes, and spaces.

The first location in the first successful tier is selected. A later exact
match therefore takes precedence over an earlier trim-only match, and
duplicate locations within one tier are not treated as ambiguous. These rules
apply without file-type or syntax restrictions.

Replacement lines are applied as provided. The matcher does not lint, repair,
reinterpret, or reject replacement content based on language syntax.

An `@@ context` value is matched with the same algorithm and advances the
forward-search cursor to the following line. The chunk's complete `oldLines`
sequence, containing every unchanged and deleted patch line, must then match
contiguously at or after that cursor. An unmentioned source line between two
old lines prevents a match.

`*** End of File` starts sequence matching at the final legal source position.
A pure addition with no old lines retains official behavior and is inserted
at EOF, including when an `@@` anchor was supplied.

If a direct search fails and the old sequence ends in the empty
trailing-newline sentinel, matching retries without that sentinel. No
Tree-sitter, Markdown-table, typed-fence, formatter-reflow, candidate-ranking,
ambiguity, or output-equivalence matcher runs afterward.

After a successful match, replacement and insertion lines adopt the local
source line ending. This deliberately preserves CRLF or mixed-line-ending
regions even though official Codex can convert an edited region to LF; it does
not change which patches are eligible to match.

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

Chunkless pure moves:

- MUST support arbitrary regular-file bytes, including invalid UTF-8, NUL
  bytes, empty files, BOMs, CRLF, CR, mixed line endings, and files without a
  trailing newline;
- MUST NOT pass content through the text update engine;
- MUST preserve content bytes exactly;
- SHOULD use a native filesystem rename when source and destination are on the
  same filesystem;
- SHOULD preserve file metadata through the native rename;
- MUST move a source symlink as a directory entry rather than
  dereferencing and rewriting its target;
- MUST replace a destination symlink as an entry rather than writing
  through it;
- MUST reject source directories and unsupported special files; and
- MUST create missing destination parent directories consistently with
  existing move behavior.

A move destination is always the exact path named by the patch. A directory at
that path rejects; the implementation does not append the source basename or
replace the directory. Replacing an existing destination replaces only that
directory entry, so other hard links to the former destination remain
unchanged.

If source and destination are on different filesystems, a byte-preserving
copy-to-temporary, destination-replace, and source-unlink fallback MAY be used.
The fallback MUST:

1. copy bytes without decoding or transforming them;
2. avoid exposing a partially copied destination;
3. replace the destination only after the temporary copy is complete;
4. remove the source only after destination creation or replacement succeeds;
   and
5. attach every completed effect and inspected final path state to the failed
   instruction if unlinking the source or cleanup fails.

Metadata SHOULD be preserved where the platform permits it. Byte preservation
is mandatory.

When the source has other hard links, a same-filesystem native rename preserves
the relationship between the destination and those remaining links. A
cross-filesystem move follows ordinary copy-and-remove behavior: the
destination has an independent inode while the remaining source-filesystem
links retain the original inode.

### Move with identity chunks

If all supplied chunks are structurally identity-only, they have no content
effect. An accompanying move is therefore treated as a pure move.

Supplied chunks are nevertheless text preconditions:

1. the applicable source text must be valid UTF-8;
2. every `@@` context and old-line sequence must match through the
   official-compatible exact, trailing-trim, full-trim, and Unicode tiers;
3. a mismatch rejects the complete patch before writes; and
4. successful validation moves the original entry without applying the
   matcher's derived replacement text.

This includes blank `@@` chunks: they require a valid textual source even
though they contain no useful content assertion. A model that intends an
opaque move must use chunkless move syntax.

For a source symlink, validation follows its text target while successful
execution still moves the symlink entry. For a source hard link, validation
reads the shared file while successful execution preserves normal pure-move
hard-link topology. Same-entry and same-patch fulfilled moves validate their
supplied chunks before producing a no-change result.

### Move with state-changing chunks

An update that both changes content and moves the result remains a textual
operation:

1. read and decode the source as UTF-8;
2. derive the new text;
3. create an independent regular file at the destination; and
4. unlink only the named source entry.

The independent destination:

- replaces only the named destination directory entry;
- replaces a destination symlink without writing through it;
- detaches the named destination from any former hard-link set without
  modifying the other links;
- preserves the source regular file's permission bits;
- receives normal new-file ownership, ACL, extended-attribute, and timestamp
  behavior; and
- is created with normal new-file permissions when the source is a symlink
  rather than a regular file.

If the source is a symlink, its target supplies the text to edit, the
updated result is created as a regular destination file, the source symlink is
unlinked, and the updated text is not written through the source symlink. A
target path that is also named as the move destination can still be replaced
directly by the destination operation. A dangling source symlink rejects
because its old text cannot be verified.

If another hard link refers to the source inode, that other entry retains the
original inode and content. The state-changing move does not mutate the shared
source inode before creating the result.

For case- or Unicode-only moves, update the content and establish the requested
destination spelling with a native rename strategy. If source and destination
reach the same entry through a symlink parent, update in place and treat
the move effect as already satisfied.

Partial-failure tracking remains in force.

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

Path normalization is used to understand dependencies, not to impose a
blanket duplicate-target rejection. Official Codex does not categorically
reject duplicate resolved targets: verification previews are stored by path
and runtime hunks are applied sequentially. This extension makes the
sequential semantics explicit and keeps preview, preflight, and execution
coherent across aliases.

Case-, Unicode-, and symlink-parent aliases share one virtual directory
entry. Later operations observe earlier changes regardless of which equivalent
spelling they use. Hard-linked paths do not: they are distinct directory
entries whose content state is shared until an operation deliberately replaces
one entry.

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

- A non-no-op `Add File: P` completely determines the resulting bytes and
  existence of `P`.
- `Delete File: P` completely determines that `P` is absent.

An add that is a no-op against the current entry MUST NOT be assumed to
dominate an unknown earlier update. If that update had changed the bytes, the
later add would replace the entry rather than remain a no-op, which could
change inode or hard-link topology. Domination is accepted only from the
filesystem effect the planner can prove.

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

The write set of an ordinary text update follows filesystem identity:

- an update through a symlink writes the resolved target, not the link
  entry;
- an update through one hard-link name writes the shared inode and is visible
  through every surviving hard link; and
- case, Unicode, and symlink-parent aliases of one entry share the same
  effect.

Deleting or replacing only a symlink does not dominate an update of its
target. Deleting only one hard-link name does not dominate content still
visible through another name. A dead-update proof MUST account for the resolved
target and every surviving link to the affected inode. When all aliases cannot
be identified and dominated safely, the update remains a conflict.

Dead-update analysis replays later unconditional adds and deletes in source
order. A delete followed by an add is evaluated against the virtually absent
entry, not against the filesystem state that existed before both operations.
This replay preserves effective hard-link counts and prevents an add that only
looked like a no-op in the old state from blocking an otherwise exact proof.

### General elimination condition

An inapplicable operation may be marked dead only when:

1. no intervening operation reads any unknown value or entry state it would
   produce;
2. every unknown path state is replaced by a dominating operation;
3. its source-removal effect is already satisfied or later dominated;
4. any parent-directory effects are also reproduced or irrelevant; and
5. omitting it cannot change symlink, hard-link, metadata, or entry-type
   behavior visible in the final state.

Unsupported proofs become conflicts, not unsafe acceptance. A candidate score,
likely intent, replacement text already appearing elsewhere, or preferred
mapping is never a proof.

For a failed move, domination of the source path alone is insufficient. Every
source-removal, destination-creation, destination-replacement, and
parent-directory effect must be dominated before observation. In particular,
`Move A -> B` with both paths absent does not become dead merely because a
later operation deletes `A`.

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

The same rule applies to Unicode-normalization-only renames. Pure moves
establish the requested spelling. State-changing moves update the file and then
establish the requested spelling.

### Hard links

Distinct hard-linked paths are distinct directory entries even though they
share an inode.

Ordinary text updates mutate the shared inode and are visible through every
hard link. `Add File` and state-changing moves instead replace or create only
the named entry, leaving other hard links unchanged. A pure same-filesystem move
preserves the source inode and its remaining hard-link relationship;
cross-filesystem copy-and-remove necessarily creates an independent destination
inode.

For a pure move `A -> B` where `A` and existing `B` are hard links to the same
file, the required postcondition remains:

- `A` absent;
- `B` present; and
- bytes unchanged.

Some native rename implementations report success without removing `A` when
both names identify the same inode. The executor must account for that case
without deleting `B`.

Replacing a destination that has other hard links replaces only the named
destination entry. The other hard links retain their original inode and
content for both pure and state-changing moves.

### Symlinks

Pure moves operate on links themselves:

- moving a source symlink moves the link entry;
- overwriting a destination symlink replaces the link entry; and
- a pure move does not modify either link target.

The link's stored target text remains byte-for-byte unchanged. A relative
target is resolved from the destination directory after the move, so later
same-patch text operations through the moved link observe the destination-side
target. Cross-filesystem symlink moves receive fresh entry identity.

Text updates retain the existing text-operation behavior and are not silently
converted into link-entry moves. Specifically:

- ordinary text updates follow a live source link;
- state-changing updates through dangling links reject;
- `Add File` replaces live and dangling destination links;
- pure moves move a source link entry without dereferencing it, including when
  dangling;
- pure moves replace destination link entries without modifying their targets;
- state-changing moves create a regular destination and do not modify the
  original source symlink target; and
- state-changing moves replace destination link entries without modifying
  their targets.

### Unsupported entry types

Directories, sockets, devices, FIFOs, and other special entries are outside
the pure-file move extension and MUST be rejected.

Add, delete, update, and move operations targeting a directory or unsupported
special entry reject during preflight. No operation invents shell-style
"move into directory" behavior or recursively removes a directory. Semantic
no-ops that require no filesystem interaction remain successful.

## Virtual filesystem and planning model

The virtual filesystem should distinguish at least:

```text
Absent
Directory
RegularFile(KnownTextBytes | OpaqueBytesReference)
Symlink(LinkTarget)
UnsupportedEntry
```

The planner MUST track the possible effects of an inapplicable operation while
performing dead-operation analysis. This does not require an explicit
`UnknownResult` variant when an equivalent read/write-set proof is used.

Opaque content should be represented by provenance and filesystem entry
metadata sufficient to execute the planned move. The planner does not need to
load or serialize bytes merely to move them.

Text decoding is lazy:

- chunkless pure moves, deletes, and unconditional overwrites do not decode;
- pure moves with supplied identity or context chunks decode only to validate
  their text preconditions;
- a state-changing text update decodes only the entry it consumes; and
- a moved opaque entry remains opaque until a later operation genuinely needs
  its text.

All source and destination paths, including move destinations, MUST
participate in Pi's file mutation queue. They also participate in an
extension-local logical-key queue that collapses proven case, Unicode,
symlink-parent, and physical hard-link aliases. Distinct hard-link
directory entries retain distinct entry keys while sharing a physical inode
key. Queue acquisition order MUST be deterministic to avoid deadlocks.

Queue identity is operation-aware. Entry-only adds, deletes, identity updates
without a move, and chunkless pure moves MUST NOT dereference a symlink target
merely to choose a queue key. State-changing text updates and pure moves with
supplied chunks do acquire the physical identity of a live regular-file
target. Cyclic, dangling, or inaccessible targets are left for semantic
preflight so genuinely entry-only operations and no-ops remain valid.

Both queues are in-memory and process-local. They coordinate concurrent
`apply_patch` calls sharing one Pi process and module instance. They do not
coordinate separately launched Pi sessions, other processes, or unrelated Pi
`edit` and `write` tools.

After queues are acquired, preflight reads the required state and constructs
the complete plan. Before executing each mutation, the implementation SHOULD
verify that the relevant directory entry still matches the planned identity
and metadata. External changes observed during these checks or later commit
verification cause a conflict rather than being accepted as trusted state.

## Execution and failure behavior

### Ordered execution

Execute planned mutations in source order. Do not collapse operations in a way
that changes move chains, overwrite order, or intermediate observations.

Dead operations and unconditional no-ops produce no filesystem calls.
State-dependent no-ops may perform read-only assertions but never mutate the
filesystem.

### No-change assertions

Every state-dependent no-change classification MUST be revalidated at its
source-order position. Assertions and mutations are one ordered execution
sequence; checking all no-change postconditions only at completion is invalid
because a later same-patch mutation may intentionally change that state.

The required assertions are:

- an identical add still resolves at the exact requested spelling to a regular
  file containing the requested bytes;
- an absent delete target is still absent;
- an unchanged update still maps through the official-compatible strict
  matcher and derives bytes equal to the current bytes;
- a nontrivial same-entry move still resolves its case, Unicode, or
  symlink-parent aliases to one directory entry, with supplied chunks still
  matching; and
- a fulfilled move still has an absent source and the exact destination entry
  committed by the referenced earlier instruction, with supplied chunks still
  matching.

Identical-add validation is postcondition-based: a different regular-file
inode remains valid when the exact spelling and bytes are unchanged because no
write occurs. Unchanged-update validation replays the operation against the
current file rather than requiring an unchanged whole-file snapshot, so
unconstrained lines may change only when strict reapplication still proves the
operation has no effect. A fulfilled chunkless move constrains entry provenance
and path state, not bytes; supplied chunks add their documented text
preconditions.

Empty updates without moves, identity updates without moves, and chunkless
lexical self-moves are unconditional and require no filesystem assertion.

If an assertion fails, execution MUST fail closed. It MUST NOT promote the
instruction into a mutation because every later virtual-state decision was
planned with that instruction producing no effect. Assertions after an earlier
failure are `NOT RUN`; assertions that succeed retain `NO CHANGE`. Stable
assertions perform no filesystem mutation.

### In-place write identity

An ordinary text update that does not move or replace its entry MUST remain
bound to the filesystem topology observed during preflight:

1. preflight records the named source entry, every traversed ancestor directory
   and symlink, the resolved regular-file target, its bytes, and its link count;
2. execution rejects a changed source entry, route entry, resolved target
   inode, content, or unexplained link count;
3. byte equality MUST NOT authorize a different inode or route;
4. execution opens the target without truncating, verifies the opened
   descriptor, and revalidates the source and route before writing;
5. the content write and truncation use that descriptor rather than resolving
   the pathname again; and
6. the resulting descriptor identity, link count, route, and pathname binding
   are revalidated after writing.

Physical link-count changes from earlier committed instructions are accepted
only when their exact net delta explains the observed count. A generic
“earlier operation released this inode” condition is insufficient. When an
earlier instruction creates an entry or parent directory whose inode could not
exist during preflight, execution captures its committed identity for later
instructions.

Every mutation MUST establish operation-owned commit evidence before its
instruction becomes `APPLIED` or its result becomes trusted virtual state:

- replacement writes retain the temporary regular-file identity, requested
  bytes, and requested final spelling through destination rename;
- created parents retain the directory identities established by recursive
  creation;
- descriptor-bound writes retain the resulting descriptor identity and bytes
  without requiring an alias spelling to change;
- native moves retain the validated source entry identity and raw symlink
  target at the exact destination spelling;
- cross-filesystem moves retain the temporary copied entry identity, preserve
  known bytes or the raw symlink target, and revalidate source continuity
  before source removal; and
- successful deletes and move-source removals still require an absent source.

Entry type alone is not commit evidence. If a same-type entry has replaced an
operation result, the instruction MUST fail and partial-effect inspection MUST
report the observed final state. A state-changing text move also revalidates
the original source identity and constrained bytes immediately before unlink,
after writing its independent destination.

Unrelated processes can still mutate filesystem state because the extension
does not own an operating-system transaction or cross-process lock.
Descriptor-bound writing prevents a pathname replacement after opening from
redirecting the write to the replacement inode. If the final pathname or route
no longer binds to the validated inode, execution fails and normal
partial-failure inspection reports the completed effect.

`rename` and `unlink` remain pathname-based host operations. Standard Node
filesystem APIs cannot condition either operation on the device and inode
verified immediately beforehand. An uncoordinated actor can therefore replace
a source or destination after the final check but before the pathname syscall
takes effect. The syscall can remove or overwrite that replacement while the
requested final pathname state still appears valid, leaving no observable
evidence that identifies the intervening entry.

This check/use race is an accepted limitation. The implementation does not
replace native rename and unlink semantics with a multi-step quarantine
protocol, does not introduce platform-specific native filesystem helpers, and
does not claim cross-process transactional isolation. Operation-owned commit
evidence detects substituted results that remain observable afterward; it
cannot recover an entry already removed or overwritten inside a successful
pathname operation.

### Native rename

A same-filesystem pure move should use native rename semantics rather than
read/write/unlink. This preserves opaque bytes and normally preserves metadata
and atomicity.

Destination type and self-alias checks happen before rename.
The source filesystem is taken from the existing source entry's `lstat`
fingerprint. The destination filesystem is taken from its existing parent or
nearest existing ancestor.

### Partial failures

Low-level failures can still complete part of an instruction, especially for:

- cross-filesystem copy-and-unlink fallback;
- destination creation or replacement followed by failure to unlink the source;
- permission changes between preflight and execution; or
- external filesystem races.

The tool result MUST attach every completed filesystem effect to the
instruction that produced it. After a low-level failure, inspect each relevant
path and report its deterministic final state. If inspection fails, report
that the final state was not verified. Do not speculate about possible states
and do not describe a partial effect as an earlier successful instruction.

The executor MUST NOT attempt destructive rollback unless a separately
designed and verified transactional mechanism exists.

### Cancellation

Cancellation is checked before validation, after queue acquisition, and between
operations. It must not interrupt a native rename halfway, but may stop before
the next operation and report every completed instruction and filesystem
effect.

## Result history and rendering

Pure moves require a structured result that does not assume UTF-8 old/new
content. A dedicated move representation is preferred:

```text
Move {
  sourcePath
  destinationPath
  replacedDestination
  entryType
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

If every operation has no filesystem effect, return successful output that clearly
states:

```text
Success. No files were changed.
```

When any instruction is not applied or an applied instruction has feedback,
the aggregate summary is followed by `Patch instruction results:` and every
instruction in source order. The ledger is omitted when every instruction is
applied without feedback. There is no model or TUI instruction limit. Visible
rows use `N. [STATUS] operation`, with statuses `APPLIED`, `NO CHANGE`,
`SKIPPED`, `FAILED`, and `NOT RUN`. Ordinary applied instructions need only
their status and operation when the ledger is present.
An update hunk that also has a move destination is labeled
`Update & Move source -> destination`; a move-only hunk remains
`Move source -> destination`.
Reasons, non-obvious effects, deterministic final states, and errors remain on
the relevant instruction.

Symlink effects retain the raw target pathname returned by `readlink`.
Every replacement effect records the verified previous and resulting entry
types. A resulting symlink also records its raw target pathname. Missing
replacement information is invalid. If neither execution nor post-failure
inspection can verify the result, feedback reports that state as not verified
rather than claiming a replacement.

Model-facing status labels and separators are ASCII, while the TUI may use
Unicode separators. Failed matcher feedback does not repeat old or replacement
patch blocks. Model feedback does not discuss diff availability or unreadable
previous content.

The default-off `applyPatchDebug` presentation setting replaces a completed
collapsed TUI result with the exact model-facing text. It does not change tool
execution, stored result data, or model feedback. Expanded results continue to
show the normal visual summary and complete diffs.

`APPLY_PATCH_INSTRUCTION_FEEDBACK.md` defines the complete normative feedback
contract.

Do not report a harmless redundant operation as an error.

Textual turn-diff aggregation must not claim reconstructable old/new text for
an opaque move. Internal history can record that a textual delta is
unavailable, but that rendering concern is not model feedback and must never
cause a successful operation to be described as uncertain.

## Deliberate extensions and differences from official Codex

This extension intentionally differs from official Codex in these areas:

1. A grammar-valid empty update without a move succeeds as a no-op.
2. Identity-only updates succeed without requiring or rewriting a target.
3. A grammar-valid move-only update is accepted.
4. Pure moves support arbitrary opaque binary files and move symlink
   entries without dereferencing them.
5. Adding already-present bytes, deleting an absent path, self-moves, and
   same-patch fulfilled moves succeed as verified no-ops.
6. Repeated and aliased paths receive one coherent sequential virtual
   filesystem interpretation across preview, preflight, and execution.
7. Inapplicable operations may be skipped only when exact read/write and
   filesystem-identity analysis proves them dead.
8. Strict edits preserve local CRLF or mixed line endings instead of retaining
   Codex's current edited-region LF conversion.
9. Preflight classifies the complete operation sequence, models native versus
   cross-filesystem topology, and reports structured no-op, dead, and failure
   evidence.

Matching itself is aligned with Codex's mode priority, first-match behavior,
anchor and pure-insertion placement, explicit EOF meaning, and unrestricted
file-type eligibility.

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
- identity chunks with move validate their text preconditions and then
  classify as pure move;
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
- add replaces live and dangling symlinks without modifying or creating their
  targets;
- add replaces only the named member of a hard-link set, preserves its mode,
  and leaves other links unchanged;
- add through a case or Unicode alias establishes the requested spelling;
- missing source plus unrelated existing destination is rejected;
- missing source plus missing destination is rejected unless the move is dead;
- deletion-only text update leaves an existing zero-byte file;
- deletion-only text update of an absent path rejects unless dead.

### Official-compatible strict matching

- parsed update hunks retain context, addition, and deletion roles;
- exact, trailing-trim, full-trim, and Unicode matching run in official order;
- a later exact location takes precedence over an earlier trim-only location;
- the first location in the successful tier is selected without ambiguity
  rejection;
- anchors use the same matching tiers and advance the forward cursor;
- complete old-line sequences are contiguous and cannot bridge an unmentioned
  source line;
- pure additions retain official EOF placement, including anchor-only
  additions;
- `*** End of File` searches only the final legal source position;
- trailing-newline sentinels receive the official retry behavior;
- no syntax-aware or formatter-recovery matcher runs after failure; and
- successful insertions and replacements preserve the local source line
  ending.

### Path identity

- `A`, `./A`, and normalized absolute aliases;
- lexical self-move;
- self-move with text changes becomes in-place update;
- case-only rename on case-insensitive filesystems;
- Unicode-normalization-only rename where the filesystem aliases spellings;
- equivalent case, Unicode, and symlink-parent spellings share virtual
  sequential state;
- distinct hard links;
- source and destination hard links to the same inode;
- ordinary updates remain visible through all hard links;
- add and state-changing moves detach only the named hard-link entry;
- pure move through a symlink-parent self-alias preserves the entry;
- ordinary text update follows a live source symlink;
- ordinary text update through an initially or virtually dangling symlink
  rejects before writes;
- state-changing move from a live source symlink creates a regular
  destination and leaves the target unchanged;
- state-changing move from a dangling source symlink rejects;
- pure move of a live or dangling source symlink moves the link entry;
- pure and state-changing moves replace destination symlink entries without
  modifying targets;
- directory and unsupported special-entry rejection.

### Atomicity, preflight, and history

- any conflict prevents all writes;
- all involved paths participate in mutation queues;
- missing-tail paths below symlink parents use the same in-process queue;
- external drift observed at execution or commit-verification points is
  detected;
- pathname replacement between the final check and a successful `rename` or
  `unlink` remains an accepted cross-process race;
- link-count changes caused by earlier planned operations do not masquerade as
  external drift;
- native move failure leaves source intact when no mutation committed;
- cross-filesystem move followed by update, delete, or another move succeeds;
- cross-filesystem partial failure reports every completed effect on the
  failed instruction;
- partial writes and destination-replacement retry failures inspect and report
  deterministic final path states;
- pure binary move history contains no binary payload;
- pure move rendering is path-only;
- parse-failure instruction details ignore header-looking hunk context lines;
- production fixtures compare complete trees including directories, symlinks,
  entry types, modes, and collateral paths;
- model-facing summaries report add, modify/move destination, and delete paths
  accurately;
- all-no-change patch reports success with no changed files; and
- mixed applied/no-change/skipped patches report only confirmed filesystem
  changes.

## Acceptance criteria

The implementation is complete when:

1. every grammar-valid empty or move-only update is parsed;
2. harmless operations no longer reject an otherwise semantically correct
   patch;
3. conflicts are detected before writes;
4. chunkless pure moves never decode file bytes, while identity-chunk pure
   moves decode only for validation and never transform the moved entry;
5. binary, text, empty, symlink, and chained pure moves follow the documented
   semantics;
6. repeated paths are handled through ordered virtual state;
7. missing-file updates are skipped only under a sound no-op or dead-operation
   proof;
8. result history and rendering represent opaque moves without binary
   serialization;
9. matching uses only the official-compatible strict algorithm with no
   formatter-recovery fallback; and
10. tests cover every required scenario above.
