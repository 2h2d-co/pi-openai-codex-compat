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
- **Edit group:** One contiguous run of added and deleted hunk lines, bounded
  by unchanged context lines.
- **Dead operation:** An operation whose removal provably leaves the same final
  observable filesystem state and does not change anything observed by an
  intervening operation.
- **Formatter-tolerant matching:** Recovery that locates uniquely determined
  edit groups after formatting changed line boundaries or nearby context.
- **Identity update:** An update whose old and new line sequences are
  structurally identical and therefore has no content effect.
- **Mapping:** One ordered, non-overlapping selection of candidate locations,
  with one location selected for each edit group.
- **Opaque content:** File content that has not been decoded as text. It may be
  valid UTF-8, binary data, or an empty byte sequence.
- **Path alias:** A different path spelling that identifies the same directory
  entry because of filesystem case or Unicode normalization behavior, or
  because a parent directory is reached through a symbolic link.
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

`Add File: P` establishes a regular-file entry at the exact requested path
spelling.

- If `P` already contains exactly the requested bytes, the operation is a
  no-op only when `P` is already a regular file at the requested exact
  spelling. This no-op does not break an existing hard-link relationship.
- If `P` is absent, it is created along with missing parent directories.
- If `P` is an existing regular file with different bytes, only the named
  directory entry is replaced by an independent regular file. Other hard links
  retain their original inode and contents. The replacement preserves the
  replaced regular file's permission bits.
- If `P` is a symbolic link, including a dangling link, the link entry is
  replaced by a regular file. Its target is not followed, created, or modified.
- If a case- or Unicode-normalized alias of `P` exists, that entry is replaced
  and the exact spelling requested by the add is established.
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

An ordinary text update follows a symbolic link and edits its target. It also
edits the shared inode reached through a hard link, so every hard-linked entry
observes the new content and the hard-link relationship remains intact.

A state-changing update through a dangling symbolic link rejects during
preflight. This applies whether the link was initially dangling or an earlier
operation in the same patch deleted or moved away its target. The update MUST
NOT recreate the old target or redirect itself to a move destination. Empty
and identity-only updates retain their no-op semantics.

### Formatter-tolerant text matching

Formatter-tolerant matching is a conservative fallback after the established
Codex line matcher fails. It does not replace or weaken successful strict
matching.

The fallback MUST:

1. preserve each hunk line's context, addition, or deletion role during
   parsing;
2. partition each hunk into edit groups;
3. locate candidates for every edit group against the same pre-update file;
4. retain only the highest contextual-score candidates for each group;
5. enumerate ordered, non-overlapping mappings;
6. derive the final bytes for every retained mapping; and
7. apply the patch only when the enumeration is exhaustive and every mapping
   produces byte-identical final content.

If no complete mapping exists, matching falls back to the original context
error. If retained mappings produce different files, overlap, or exceed a
bounded exhaustive-search limit, reject the update as ambiguous before any
write.

The grammar does not provide line numbers. Matching therefore MUST NOT invent
line-number semantics. An `@@ context` value is a textual anchor, while
ordinary unchanged hunk lines are contextual evidence around an edit group.

`*** End of File` has the official Codex meaning: the complete old side of the
chunk, including unchanged trailing context, MUST end at the end of the source
file. Formatter-tolerant recovery may bridge formatter-controlled layout
changes, but it MUST preserve this boundary. EOF insertions are placed at EOF;
line, Markdown, and structural candidates in the middle of the file are
ineligible.

A present `@@ context` anchor has positional force. Candidates preceding the
matched anchor are ineligible; the anchor is not merely a scoring bonus.

#### Line-level recovery

For replacements and deletions, the fallback first searches for the actual
deleted lines without requiring every unchanged context line to remain
adjacent. The existing exact, trailing-whitespace, trimmed-whitespace, and
Unicode punctuation matching modes remain in force. Adjacent surviving
context before and after a candidate determines its contextual score.

For pure insertions, candidates may be derived only from surviving context,
an `@@ context` anchor, or an explicit end-of-file marker. An unanchored
insertion MUST NOT be guessed. Context on both sides may have formatter-added
lines between it; the insertion is accepted only if contextual scoring and
final-output equivalence make the result unique.

Only the nearest unchanged line on each side may directly establish an
insertion boundary. If that line changed semantically, an older surviving line
MUST NOT be treated as if it were adjacent; a language-aware block matcher may
still recover the boundary when it proves the complete block equivalent.

This permits harmless stale context, such as an unrelated formatter-added
line, when the requested edit itself remains uniquely identifiable. It does
not permit an old deletion to match text that is absent.

#### Structural token recovery

When deleted lines no longer match because a formatter changed line
boundaries, supported languages use the official `web-tree-sitter` runtime
with grammar assets from `@2h2d/tree-sitter-wasms`.

The supported extensions are:

| Language   | Extensions              |
| ---------- | ----------------------- |
| JavaScript | `.js`, `.mjs`, `.cjs`   |
| JSX        | `.jsx`                  |
| TypeScript | `.ts`, `.mts`, `.cts`   |
| TSX        | `.tsx`                  |
| Python     | `.py`, `.pyi`           |
| Go         | `.go`                   |
| Java       | `.java`                 |
| Scala      | `.scala`, `.sc`, `.sbt` |

Both the current file and grammar-wrapped old/new fragments MUST parse
without error. Every non-whitespace fragment byte MUST be represented by the
concrete syntax tree. Candidate matching compares leaf token types, exact
token text, and relative concrete-syntax-tree shape.

Ordinary formatter-controlled whitespace is absent from leaf-token matching.
Known optional trailing commas may be ignored only in grammar node types where
the language permits a formatter to add or remove them. Comments, identifiers,
operators, keywords, string contents, numeric contents, and JSX text remain
exact tokens; they MUST NOT be treated as trivia.

When old and new fragments have the same token-type sequence, only changed
token byte ranges are replaced so the current file's whitespace and line
wrapping remain intact. Otherwise, the matched token span is replaced using
the hunk's requested structure and the current location's indentation.

Recovery validates where the old side maps; it does not lint, repair,
reinterpret, or reject the replacement merely because the requested new code
would be invalid in its surrounding language context. The implementation MUST
nevertheless avoid corruption of its own making, including double-applying
indentation, changing unaffected line endings, or treating semantic commas such
as JavaScript array elisions as formatter-controlled trailing commas.

Line-level, Markdown, and structural candidate sources MUST be considered
together when one tier can produce a textual decoy for a viable structural
location. A verbatim block in a comment or string MUST NOT silently suppress a
different structural mapping; differing outcomes reject as ambiguous.

Unsupported extensions retain line-level recovery but do not receive
structural token recovery. The implementation does not run a formatter,
consult source-control history, or search a previous file snapshot.

Tree-sitter string input reports UTF-16 code-unit indices. Every syntax-node
range MUST be converted to UTF-8 byte offsets before byte edits are planned.
This conversion is required even when the changed token is ASCII because a
multibyte character earlier in the file otherwise shifts the edit.

#### Markdown recovery

Markdown files (`.md` and `.markdown`) have three narrowly scoped recovery
modes:

1. Table rows may match after trimming cell-edge padding. Cell contents and
   column count remain exact. Rows containing escaped pipes or inline code do
   not use this recovery. The table fallback does not operate inside fenced
   code blocks.
2. Plain prose paragraphs may match after line wrapping changes. Joining lines
   with ordinary single spaces must reproduce the exact paragraph text.
   Lists, headings, block quotes, tables, inline code, links, inline HTML,
   backslash escapes, repeated spaces, and hard line breaks are excluded.
3. Code inside a typed fenced block may use the structural grammar named by
   the fence. Supported fence names are `js`, `javascript`, `jsx`, `ts`,
   `typescript`, `tsx`, `py`, `python`, `go`, `java`, and `scala`.

An unterminated fence, unknown fence language, malformed code block, or code
edit without the typed opening fence in its hunk context remains unmatched.
Multiple equivalent fenced blocks are subject to the same final-byte
uniqueness rule as ordinary source files.

A typed opening fence authorizes structural recovery only while the edit group
is still inside that fence in the hunk context. An intervening closing fence
ends that authorization. CommonMark fence whitespace, including a trailing
tab on a closing fence, is recognized correctly. CRLF line endings do not
weaken Markdown hard-break or other whitespace-sensitive exclusions.

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
4. remove the source only after destination installation succeeds; and
5. report the exact committed prefix if source removal or cleanup fails.

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

The implementation MUST NOT force a byte-opaque file through UTF-8 decoding
solely to validate chunks that cannot alter its contents.

### Move with state-changing chunks

An update that both changes content and moves the result remains a textual
operation:

1. read and decode the source as UTF-8;
2. derive the new text;
3. materialize an independent regular file at the destination; and
4. remove only the named source entry.

The independently materialized destination:

- replaces only the named destination directory entry;
- replaces a destination symbolic link without modifying its target;
- detaches the named destination from any former hard-link set without
  modifying the other links;
- preserves the source regular file's permission bits;
- receives normal new-file ownership, ACL, extended-attribute, and timestamp
  behavior; and
- is created with normal new-file permissions when the source is a symbolic
  link rather than a regular file.

If the source is a symbolic link, its target supplies the text to edit, the
updated result is materialized as a regular destination file, the source link
entry is removed, and its former target remains unchanged. A dangling source
link rejects because its old text cannot be verified.

If another hard link refers to the source inode, that other entry retains the
original inode and content. The state-changing move does not mutate the shared
source inode before materializing the result.

For case- or Unicode-only moves, update the content and establish the requested
destination spelling with a native rename strategy. If source and destination
reach the same entry through a symbolic-link parent, update in place and treat
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

Path normalization is used to understand dependencies, not to impose the
official Codex current-main rule that rejects all duplicate resolved targets.
This extension intentionally does not adopt that blanket rejection.

Case-, Unicode-, and symbolic-link-parent aliases share one virtual directory
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

For a failed move, domination of the source path alone is insufficient. Every
source-removal, destination-installation, destination-replacement, and
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
hard link. `Add File` and state-changing moves instead replace or materialize
only the named entry, leaving other hard links unchanged. A pure same-filesystem
move preserves the source inode and its remaining hard-link relationship;
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

### Symbolic links

Pure moves operate on links themselves:

- moving a source symlink moves the link entry;
- overwriting a destination symlink replaces the link entry; and
- a pure move does not modify either link target.

Text updates retain the existing text-operation behavior and are not silently
converted into link-entry moves. Specifically:

- ordinary text updates follow a live source link;
- state-changing updates through dangling links reject;
- `Add File` replaces live and dangling destination links;
- pure moves move a source link entry without dereferencing it, including when
  dangling;
- pure moves replace destination link entries without modifying their targets;
- state-changing moves materialize a regular destination and leave the former
  source-link target unchanged; and
- state-changing moves replace destination link entries without modifying
  their targets.

### Unsupported entry types

Directories, sockets, devices, FIFOs, and other special entries are outside
the pure-file move extension and MUST be rejected.

Add, delete, update, and move operations targeting a directory or unsupported
special entry reject during preflight. No operation invents shell-style
"move into directory" behavior or recursively removes a directory. Semantic
no-ops that require no filesystem interaction remain successful.

## Reviewed implementation scope

This section records the disposition of the adversarial review so future
implementors do not have to reconstruct decisions from session history.

### Confirmed defects to fix

The implementation MUST address these confirmed defect classes:

1. **Matcher constraints:** enforce complete-hunk EOF alignment and positional
   `@@` anchors across line, insertion, Markdown, and structural recovery.
2. **Matcher fidelity:** fix partial-span indentation and CRLF preservation,
   JavaScript array-elision normalization, ordinary-line decoys suppressing
   structural candidates, table fallback inside fences, closed-fence grammar
   leakage, closing-fence tab handling, and CRLF Markdown hard-break checks.
3. **Bounded work:** make optional-comma normalization linear; stop mapping
   traversal immediately when its exhaustive bound is exceeded; thread
   cancellation through long matcher loops; and retain conservative size/work
   bounds.
4. **Entry identity:** prevent write-then-unlink data loss for case, Unicode,
   symbolic-link-parent, and destination-link aliases; keep hard-link entries
   distinct; and make sequential virtual state coherent across equivalent path
   spellings and symbolic-link targets.
5. **Execution continuity:** account for link-count changes caused by the plan
   itself and for fresh destination identity after cross-filesystem moves, so
   valid later operations do not fail as apparent external drift.
6. **Preflight:** reject predictable directory and unsupported-entry conflicts,
   including write-through destinations that resolve to directories, before
   any mutation.
7. **Failure accounting:** mark partial writes inexact; report destination loss
   during cross-filesystem replacement retries; preserve the exact committed
   prefix; and keep same-inode completion checks from masking a missing
   destination.
8. **Diagnostics:** derive parse-failure instruction details with parser-aware
   line roles so header-looking context lines do not manufacture instructions.
9. **Harness quality:** compare complete success and failure trees, including
   directories, symlinks, entry types, modes, and collateral paths.

### Intentional non-goals and rejected proposals

The implementation MUST NOT:

- lint, repair, reinterpret, or reject replacement code merely because the LLM
  requested code that is invalid in its language context;
- add language-specific contextual-keyword blacklists;
- weaken the requirement that structural source documents and wrapped
  fragments parse without error;
- guess an unanchored tolerant insertion;
- move candidate-score pruning after mapping enumeration;
- reject exhaustive mappings that produce byte-identical final content;
- replace the original strict context error when tolerant matching declines;
- scan beyond an unclosed CommonMark fence as though later fences were outside
  it;
- require production-fixture fingerprints to hash sanitized fixture text;
- infer that fixture minimization or operation count caused an observed
  production failure without evidence; or
- preserve ownership, ACLs, extended attributes, or timestamps for
  independently materialized text results.

The following review claims were disproved or narrowed and MUST NOT drive
implementation:

- a proposed call-argument-tail versus parenthesized-sequence fixture did not
  apply and is not evidence of a matcher defect;
- raw `parseFragment` language-load failure after successful document loading
  is not an independent practical path because both use the same cached
  language promise;
- UTF-16-to-UTF-8 offset conversion is linear and is not the primary memory or
  performance defect;
- cross-process serialization is outside the in-process mutation queue's
  contract; missing-tail aliases remain an in-process canonicalization concern;
- every literal pipe in a Markdown link or HTML fragment is not inherently a
  false match, although table recovery must remain semantically exact and
  fence-aware; and
- generic exact line recovery inside a Markdown block is not itself a prose
  recovery defect.

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
- add replaces live and dangling symlinks without modifying or creating their
  targets;
- add replaces only the named member of a hard-link set, preserves its mode,
  and leaves other links unchanged;
- add through a case or Unicode alias establishes the requested spelling;
- missing source plus unrelated existing destination is rejected;
- missing source plus missing destination is rejected unless the move is dead;
- deletion-only text update leaves an existing zero-byte file;
- deletion-only text update of an absent path rejects unless dead.

### Formatter-tolerant matching

- parsed update hunks retain context, addition, and deletion roles;
- a uniquely located edit survives unrelated stale context;
- pure insertion uses surviving context and rejects an unanchored location;
- multiple mappings with byte-identical final content succeed;
- multiple mappings with different final content reject before writes;
- candidate and mapping search limits reject rather than assume uniqueness;
- JavaScript, JSX, TypeScript, TSX, Python, Go, Java, and Scala each recover a
  formatter-reflowed edit through the packaged grammar;
- current line wrapping is preserved for token-type-compatible replacements;
- known optional trailing-comma differences are accepted;
- JavaScript array elisions remain semantically distinct from empty arrays;
- comments and literal contents remain exact;
- line-level decoys do not suppress divergent structural candidates;
- malformed source or fragments reject structural recovery;
- UTF-8 byte edits remain correct after multibyte UTF-16 characters;
- partial-span replacements preserve indentation and source line endings;
- a present `@@` anchor excludes candidates before it;
- `*** End of File` aligns the complete old side, including trailing context,
  across line, Markdown, and structural recovery;
- typed Markdown fences recover supported-language code reflow;
- formatter-aligned Markdown tables match exact cell contents;
- table recovery ignores fenced-code rows;
- closed fences do not authorize later edit groups, and closing fences with
  trailing tabs are recognized;
- reflowed plain Markdown paragraphs recover insertions and replacements;
- Markdown hard breaks, inline code, links, escaped table pipes, lists, and
  other whitespace-sensitive constructs reject prose recovery;
- CRLF files enforce the same Markdown safety exclusions as LF files;
- a changed nearest insertion context is not bypassed using older context;
- obsolete context-only chunks do not block a later uniquely located edit;
- unsupported extensions retain conservative line matching; and
- strict Codex matching behavior remains first and unchanged.

### Bounded matching and cancellation

- optional trailing-comma normalization is linear in token count;
- reaching the complete-mapping limit immediately stops traversal;
- cancellation interrupts long structural and mapping loops with no writes;
- cached parser or language initialization failures can be retried rather than
  poisoning the process permanently; and
- bounded-work failures remain conservative context or ambiguity failures.

### Path identity

- `A`, `./A`, and normalized absolute aliases;
- lexical self-move;
- self-move with text changes becomes in-place update;
- case-only rename on case-insensitive filesystems;
- Unicode-normalization-only rename where the filesystem aliases spellings;
- equivalent case, Unicode, and symbolic-link-parent spellings share virtual
  sequential state;
- distinct hard links;
- source and destination hard links to the same inode;
- ordinary updates remain visible through all hard links;
- add and state-changing moves detach only the named hard-link entry;
- pure move through a symbolic-link-parent self-alias preserves the entry;
- ordinary text update follows a live source symlink;
- ordinary text update through an initially or virtually dangling symlink
  rejects before writes;
- state-changing move from a live source symlink materializes a regular
  destination and leaves the target unchanged;
- state-changing move from a dangling source symlink rejects;
- pure move of a live or dangling source symlink moves the link entry;
- pure and state-changing moves replace destination symlink entries without
  modifying targets;
- directory and unsupported special-entry rejection.

### Atomicity, preflight, and history

- any conflict prevents all writes;
- all involved paths participate in mutation queues;
- missing-tail paths below symbolic-link parents use the same in-process queue;
- external drift after preflight is detected;
- link-count changes caused by earlier planned operations do not masquerade as
  external drift;
- native move failure leaves source intact when no mutation committed;
- cross-filesystem move followed by update, delete, or another move succeeds;
- cross-filesystem partial failure reports the committed prefix;
- partial writes and destination-replacement retry failures are marked inexact;
- pure binary move history contains no binary payload;
- pure move rendering is path-only;
- parse-failure instruction details ignore header-looking hunk context lines;
- production fixtures compare complete trees including directories, symlinks,
  entry types, modes, and collateral paths;
- model-facing summaries report add, modify/move destination, and delete paths
  accurately;
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
   serialization;
9. formatter-tolerant matching accepts only exhaustively proven
   byte-equivalent outcomes; and
10. tests cover every required scenario above.
