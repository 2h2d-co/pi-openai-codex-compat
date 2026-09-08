# Codex compaction and context-management implementation review

Date: September 8, 2026. Status: research and proposal only; no runtime changes.

## Recommendation

Keep native remote compaction as the default. Prototype **opt-in, Pi-backed
context management** as a separate mode, not as a replacement compaction
endpoint or an alias for `/compact`.

The important new approach is **explicit notes plus retrievable history plus
an unsummarized context reset**. Codex does not automatically generate a better
summary in this mode: it stops generating a summary altogether. That can avoid
repeated summary degradation and the remote-compaction wait, but it makes
recovery infrastructure and model note-taking critical.

Recommended order:

1. Harden the existing native-compaction contract and evaluate image budgeting.
2. Implement branch-scoped, bounded history retrieval and durable task notes.
3. Add budget guidance and a transactional reset at a safe sampling boundary.
4. Evaluate task continuity, latency, total usage, and branch isolation before
   considering a default change.

Do not adopt the official private history/notes backend first. Its ingestion,
encrypted tool results, account eligibility, and fork lineage are additional
contracts that the current extension does not implement.

## Dictionary

- **Active context**: the complete logical input available to one model
  request, regardless of how much is transmitted over a WebSocket.
- **Native compaction / memento**: a Responses request ending with
  `compaction_trigger`, producing an opaque `compaction` item for future input.
- **Context management / reset**: the experimental token-budget workflow that
  installs fresh initial context without summarizing the previous window.
- **Window**: one active-context generation, with persistent identity and a
  boundary in the conversation history.
- **History archive**: completed conversation records retained outside active
  context and available through bounded retrieval.
- **Task notes**: explicit progress checkpoints and references, not hidden
  chain-of-thought. The proposed Pi implementation would be user-inspectable.
- **Initial context**: current instructions, tools, environment/context
  information, and window/recovery guidance supplied by the host.
- **Safe sampling boundary**: after completed tool calls and all their results
  are persisted, but before the next model request starts.

## 1. Verified baseline and scope

| Item                                  | Verified value                                                  |
| ------------------------------------- | --------------------------------------------------------------- |
| Latest stable GitHub release          | `rust-v0.153.4`, published September 4, 2026, 23:25:48 UTC      |
| Peeled source commit                  | `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`                      |
| npm `@openai/codex` `latest`          | `0.153.4`, matching GitHub                                      |
| Prerelease observed, not used         | `0.154.0-alpha.6`                                               |
| Previous package-wide reviewed stable | `rust-v0.149.1`, `ff29a44391deccde0aba0f8390337d7f3c319ea4`     |
| Local implementation                  | `0.0.10-alpha.7`, `2db894e`; installed Pi dependencies `0.85.1` |

The source comparison is
[`rust-v0.149.1...rust-v0.153.4`](https://github.com/openai/codex/compare/rust-v0.149.1...rust-v0.153.4).
This is a focused compaction review, not a certification of every intervening
protocol/tool change. The package-wide compatibility baseline remains
`0.149.1`.

Release notes establish two relevant developments:

- [`0.150.1`](https://github.com/openai/codex/releases/tag/rust-v0.150.1)
  made retained-image budgeting the native-compaction default.
- [`0.153.0`](https://github.com/openai/codex/releases/tag/rust-v0.153.0)
  exposed the default-disabled experimental context-management configuration.
  `new_context` and token-budget machinery already existed at the previous
  reviewed baseline; the newly exposed workflow also includes the standalone
  history/notes extension. It was not first introduced by the `0.153.4` hotfix.

The [latest release](https://github.com/openai/codex/releases/tag/rust-v0.153.4)
primarily adjusts Astra model-picker/default selection and question guidance.
Selecting Astra does **not**, by itself, enable experimental context management
in the inspected bundled catalog.

Evidence comes from pinned source and upstream tests, not from executing
credentialed Codex sessions. No history-ingestion request, remote note write,
user-session reset, or model-quality benchmark was performed.

## 2. Two different official approaches

### A. Default native compaction

The v2 path remains stable and enabled by default:

1. Clone active history and prepare normal model input.
2. If necessary, replace eligible trailing tool outputs with truncation
   placeholders to make the compaction request fit. This walks the contiguous
   trailing output groups, newest first, and stops at a non-rewritable item;
   it is not arbitrary deletion of old messages.
3. Append `compaction_trigger` and sample through the ordinary Responses
   client. The current compaction step supplies the model, reasoning effort,
   reasoning summary, and service tier.
4. Require a completed response and exactly one `compaction` item committed
   through `OutputItemDone`. Do not reconstruct that item from terminal
   response snapshots.
5. Install selected retained input plus the opaque item, refresh applicable
   initial context, persist the new window/checkpoint, and recompute usage.

The compaction stream has at most two stream retries per transport, capped
further by provider policy. The exact retry categories still matter; this is
not a suggestion to retry every failed request.

Retention is a separate client-side operation:

- Filter **before** spending the 64,000-token retained-message budget.
- Keep real user/hook messages, with their eligible attached image notices.
- Drop ordinary developer/system wrappers and ordinary assistant/tool history
  from the retained v2 prefix.
- Certain structured agent messages can survive, but descendant progress,
  completion messages, and agent messages over 10,000 estimated tokens do not.
  These are not ordinary Pi assistant commentary.
- A separate default-off feature can preserve client-authored developer
  messages using provenance metadata.
- Images now consume estimated budget. Keep images and adjacent image labels
  atomic; preserve the newer part of an image-containing boundary message.
  An oversized boundary image stops backfilling older messages.
- The 64k budget is **not** a cap on total post-compaction context: initial
  instructions, tools, opaque state, and subsequent input also contribute.

The old `/responses/compact` path and local text summarization still exist for
other feature/provider combinations. Neither is the new context-management
mechanism. Sources: [S1], [S2], [S3].

### B. Experimental context management

Official configuration:

```toml
[features.context_management]
experimental_mode = true
```

This is Codex configuration, **not** a setting supported by this Pi package.

The convenience activation path checks Codex-backend routing, normal OpenAI
authentication, and a ChatGPT Plus, Pro, or Pro Lite subscription. API-key
sessions and custom authentication/provider paths are excluded; the release
also excludes temporary structured threads. Managed feature restrictions
remain authoritative. Lower-level token-budget settings and model-owned
activation defaults are separate paths, so these checks should not be
misrepresented as universal backend authorization rules. [S4]

The active workflow has four parts:

1. **Budget awareness.** Developer context identifies the first, previous, and
   current window. `get_context_remaining` reports remaining budget.
   Model-specific instructions explain when to write notes and reset.
2. **Durable recovery.** The model can retrieve prior normalized history and
   maintain notes through backend-backed tools.
3. **Model-requested reset.** `new_context({})` records a pending reset request.
   The host consumes it after sampling/tools finish, when another sample is
   needed. Calling the tool does not immediately mutate the history beneath
   sibling tool executions.
4. **Forced reset.** At budget exhaustion, the host can offer a bounded
   note-taking interval, then reset even if the model did not request it.

In token-budget mode, automatic compaction **and manual `/compact`** install a
fresh window without local or remote summarization. Compaction hooks and UI
lifecycle still run. Files, processes, and other execution-environment state
are not reset. [S5]

#### What survives a reset?

Fresh initial context, fresh window identity/recovery guidance, and optionally
retained client-authored developer messages. Previous user messages, assistant
messages, tool calls/results, and opaque compaction state are not automatically
included. The upstream tests explicitly assert that the active user request
and last tool result disappear from the next window.

Notes and old conversation remain in their stores, not automatically as
inlined replacement history. The extension fetches a bounded thread hint
(at most 4,000 bytes); the model must retrieve notes/history to recover details.
Do not assume that a successful reset means the model already has its task
back. [S5], [S6], [S7]

#### Budget semantics

Codex distinguishes total active context from optionally counting only growth
after the initial prefix. The full usable model window is always a hard cap.
A configured note-taking buffer extends the soft auto-compaction threshold,
not that hard cap. Reminders and the exhaustion prompt are each claimed once
per window. Unknown remaining budget is reported as unknown. [S8]

Bundled Astra and GPT-5.6 token-budget prompts use a 6,144-token reminder and a
16,384-token fallback buffer when those model defaults are selected. The
exhaustion prompt asks for one note write/append, then `new_context`. It is
guidance, not a tool allowlist: upstream tests confirm that the normal tool
surface remains available during the buffer.

For example, with the bundled 272,000-token window, ordinary total-scope
defaults yield:

- base threshold: `272,000 × 90% = 244,800`;
- usable hard cap: `272,000 × 95% = 258,400`;
- requested buffered threshold: `244,800 + 16,384 = 261,184`;
- actual forced-reset threshold: `min(261,184, 258,400) = 258,400`.

Thus the full nominal buffer is not always available. These are pinned
catalog/default examples, not universal values to hard-code into Pi. [S8], [S9]

### Official history and notes are a substantial runtime

| Namespace | Operations                                                                             |
| --------- | -------------------------------------------------------------------------------------- |
| `history` | `list_windows`, `list_items`, `read_item`, `search_contents`                           |
| `notes`   | `list_files_by_prefix`, `read_file`, `search_contents`, `append_to_file`, `write_file` |

Important implementation details:

- Calls go to `alpha/history/v2/*` and `alpha/notes/v2/*`, with session and
  current-agent identity supplied by the host.
- Responses metadata opts into `history_ingest_requested` and carries window
  UUIDs. Fork metadata includes a history ordinal boundary.
- History is read-only and eventually consistent. Notes promise immediate
  read-after-successful-write, but listings/searches can lag.
- Note paths are virtual, not arbitrary host filesystem paths. The documented
  file-size cap is 1,000,000 UTF-8 bytes.
- Writes are not parallel-capable in the official tool registry.
- Some schema fields carry `encrypted: true`. Search/write calls send
  `x-openai-encrypted-tool-arguments: true`; calls also send a server-side output
  truncation policy and use a 35-second request timeout.
- Results can contain encrypted model-only content and image attachments.
  Official code separates attachments from log/hook output.
- The tools are direct-model-only and their descriptions prescribe private
  recovery. That is an official product contract, not an instruction to hide a
  future Pi implementation from Kaan.

The open-source client shows these contracts, but not the backend's complete
ingestion, retention, encryption, or authorization implementation. Existing
Pi Responses traffic is not proof that these history endpoints can recover
complete, correctly branched Pi conversations. [S6], [S10]

## 3. Concrete context transformations

### Legend

`I` = stable base instructions/tool declarations;
`En` = host contextual messages; `Wn` = window identity/recovery guidance;
`U` = real user input; `A` = completed assistant output;
`Tn/On` = linked tool call/result; `C` = opaque compaction item;
`G` = `compaction_trigger`; `N` = saved task note; `F` = exhaustion guidance.
Brackets are ordered logical item lists. Base instructions and tool declarations
may be top-level fields rather than literal items; `I` represents that surface.
`E` groups the other contextual messages, excluding separately shown `W`.

### Case 1: native compaction between user turns

1. Existing input/history: `[I, E1, U1, A1, T1, O1, U2, A2]`.
2. Compaction request: `[I, E1, U1, A1, T1, O1, U2, A2, G]`.
3. Completed response items: `[C1]`.
4. Installed conversation prefix, assuming both users fit: `[U1, U2, C1]`.
5. Next ordinary logical request after pre-turn compaction:
   `[I, U1, U2, C1, E2, U3]`.

`A1/T1/O1/A2` are no longer replayed individually; their useful information may
be represented in `C1`. `U3` was not sampled into `C1` and must appear exactly
once afterward. `E1` is replaced by fresh `E2`. Old archive records remain.

For comparison, in a mid-turn native compaction of the same sampled history,
with no new `U3`, the next logical request is `[I, U1, E2, U2, C1]`.
This keeps the compaction item last, inserting refreshed contextual items before
the last real user when possible. It is not equivalent to appending arbitrary
context after `C1`. Pi instead rebuilds its own current system instructions.
[S1], [S2]

### Case 2: model-requested experimental reset

1. Ordinary request: `[I, E1, W1, U1, A1, T1, O1]`.
2. Completed response: `[T2 = notes.write_file(N)]`.
3. Next request after successful write: `[I, E1, W1, U1, A1, T1, O1, T2, O2]`.
4. Completed response: `[T3 = new_context({})]`; host records `O3`.
5. Reset installs fresh context; the next model request is `[I, E2, W2]`.
6. Recovery response: `[T4 = notes.read_file(...)]`.
7. Next request: `[I, E2, W2, T4, O4 = recovered note]`.
8. The model can call `history.read_item` for the old `U1` or tool result using
   the references in `N`, then resume work.

`N` is committed to the notes store before the reset. `U1` through `O3` remain
archived but are **discarded from active input**, not summarized. Neither
`C1` nor a synthetic user `continue` appears. Both `T3` and `O3` disappear
together; this is not a dangling-call layout. Optional client-developer
retention is omitted from this example. [S5], [S7]

### Case 3: budget exhaustion without a model-requested reset

1. History reaches the soft limit after a linked tool result:
   `[I, E1, W1, U1, T1, O1]`.
2. If buffer room exists, next request:
   `[I, E1, W1, U1, T1, O1, F]`.
3. A cooperative response writes notes, receives its result, and calls
   `new_context`, following Case 2.
4. If the model instead consumes the buffered limit, Codex installs
   `[I, E2, W2]` before the next required sample regardless.

No summary rescues a missing note in step 4. History retrieval is therefore a
correctness dependency, not just a convenience. A hard context limit can leave
no useful note-taking interval at all. [S7], [S8]

### Invalid layouts and transport distinctions

- `[I, E2, W2, O3]` is invalid if `T3` has been removed.
- `[I, E1, W1, U1, T3]` must not be sampled while `T3` still needs execution/result.
- `[I, E2, W2, old history, C1]` is not a fresh unsummarized window.
- Reusing an old `previous_response_id` with an empty suffix does not reset
  logical history: the server continuation still includes its old baseline.

WebSocket `previous_response_id` plus a suffix is only a transport
optimization. After context replacement, establish a compatible full-input
baseline; never chain the new window to the abandoned full-history baseline.
This does not imply deleting the archive or changing the root prompt-cache key.

**Invariant:** every next request must represent exactly the installed window
and its subsequent completed work; omitted history must be recoverable without
replaying incomplete calls or duplicating executed work.

## 4. Where this extension stands

| Area                 | Current implementation                                                                                                   | Implication                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Native request       | `performCompaction()` sends the ordinary/Lite request with `compaction_trigger` through the shared transport             | Reuse this runtime; no new compaction endpoint is needed                                                |
| Checkpoints          | `CheckpointData` version 1 requires exactly one opaque item; history is stored on Pi compaction entries                  | An unsummarized reset needs a distinct checkpoint kind, not an empty/fake `compaction` item             |
| Retention            | `selectRetainedContext()` retains user/developer/system messages under a text-only 64k budget                            | Deliberate P-007 deviation; image-policy changes must be separately adopted                             |
| Compaction collector | `collectRemoteCompaction()` accepts a checkpoint found only in terminal `response.output`; a test explicitly requires it | Pre-existing discrepancy with official item-done semantics and P-002; propose correcting it             |
| Retry budget         | Shared transport defaults to five WebSocket and five SSE retries                                                         | Different from the official two-retry compaction stream cap; review by failure category, not just count |
| Timing               | Provider-boundary percentage compaction plus Pi manual/threshold/overflow lifecycle                                      | Existing safe-boundary and continuation integration is reusable                                         |
| History/notes        | No archive-query or note runtime; only web/image non-default namespaces are allowed                                      | Merely registering official names would advertise missing capabilities                                  |
| Window identity      | Pi-derived thread identity, in-memory window counter                                                                     | Retrieval-addressable windows need persisted UUID/boundary state across reload and branches             |
| Encrypted results    | Tool-result content schema supports text/images, not the official encrypted-result variant                               | Official backend adoption requires serializer, storage, and rendering changes                           |
| Branches/model lock  | Active-branch checkpoint replay; model switches rejected with native checkpoints                                         | Preserve these invariants; do not infer cross-model opaque compatibility                                |

Local implementation anchors:

- [`codex-protocol.ts`](extensions/openai-codex-compat/codex-protocol.ts):
  `selectRetainedContext`, `collectRemoteCompaction`.
- [`compaction-checkpoint.ts`](extensions/openai-codex-compat/compaction-checkpoint.ts):
  `parseCheckpoint`, `checkpointData`, `providerHistory`.
- [`codex-provider-runtime.ts`](extensions/openai-codex-compat/codex-provider/codex-provider-runtime.ts):
  `performCompaction`, `maybeCompactPercentage`, request serialization/queue.
- [`remote-compaction.ts`](extensions/openai-codex-compat/remote-compaction.ts)
  and [`output-limit-continuation.ts`](extensions/openai-codex-compat/output-limit-continuation.ts):
  host lifecycle adapters.
- [`codex-protocol.test.ts`](test/codex-protocol.test.ts):
  `accepts compaction output supplied only on the terminal response`.

**Pi version caveat:** the installed `0.85.1` implementation checks host
compaction before a new prompt and after the low-level agent run. The local Pi
documentation checkout also describes newer between-tool-turn checks and
`retainedTail` checkpoints, but those are not present in the inspected installed
session implementation/types. Do not design against those documentation-only
capabilities without a separately reviewed dependency change.

## 5. Options and trade-offs

| Option                                     | Advantages                                                                                                                        | Costs and risks                                                                                                                                                                    | Recommendation                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Harden native compaction only              | Smallest change; existing lifecycle; opaque continuity without model-managed retrieval                                            | Remote latency/usage; opaque quality; repeated compression can lose details; model lock remains                                                                                    | Immediate default              |
| Pi-backed notes/history plus opt-in reset  | Pi remains canonical; deterministic local retrieval; inspectable notes; no summarization request; branch policy under our control | New archive projection and reset lifecycle; note/retrieval mistakes; prompt overhead; no guarantee of lower total cost                                                             | Preferred prototype            |
| Official backend parity                    | Closest official tool/encryption contract; server-normalized history; less local retrieval implementation                         | Private alpha endpoints; ingestion and consistency dependency; account gates; encrypted results; additional remote data retention; fork mapping; backend behavior not fully public | Defer pending authorized proof |
| Automatically combine summaries and resets | Can retain a summary safety net                                                                                                   | Double work/cost; two recovery representations; behavior no longer matches official reset; difficult failure semantics                                                             | Do not implement initially     |

Expected benefits are hypotheses, not benchmark results:

- Removing the compaction-generation request removes that wait, but adds note
  writes, recovery reads, and potentially several model/tool round trips.
- Smaller working context can reduce prefill, but repeated retrieval and loss of
  a warm deep prefix can increase total usage.
- Source retrieval avoids relying solely on lossy summaries; it does not ensure
  that the model retrieves the right evidence or preserves every constraint.
- Local history avoids backend eventual consistency, but local indexes and
  note projections must still respect branches and crash recovery.
- Environment continuity is valuable and dangerous: a process can still be
  running after the model forgets starting it. Recovery must not duplicate
  already-completed mutations or launch duplicate jobs.

## 6. Proposed implementation

### Phase 1 — native-path hardening

In a separately approved implementation:

- Require item-done compaction output and a successful completed terminal.
  Replace terminal-only acceptance with rejection tests, including conflicting
  terminal snapshots, duplicate items, missing encrypted content, cancellation,
  and incomplete streams. Do not repair malformed history with a text summary.
- Review a compaction-specific retry budget with explicit transport/protocol
  tests. Leave ordinary response retries and bounded transport policy intact.
- Evaluate image-aware retention independently of role filtering. The official
  stable-default change satisfies the evidence portion of P-007's revisit
  condition, but does not authorize changing Kaan's chosen retained roles.
  Port image estimation/atomic-boundary behavior only with explicit checkpoint
  policy approval.

Do not introduce model-switch fallbacks for opaque checkpoints or copy
multi-agent retention without a corresponding Pi runtime.

### Phase 2 — local recovery primitives

Add focused modules under `extensions/openai-codex-compat/`, keeping
`extensions/index.ts` thin:

- **History projection:** derive completed user/assistant/tool records from Pi
  session entries and native overrides; avoid counting the same native output
  twice. Provide window listing, bounded item listing/read, and literal search.
- **Stable references:** identify records by persisted window and entry/item
  IDs, not list offsets or text hashes. Lookups must authorize membership in the
  active branch; reject guessed IDs from sibling branches and unrelated sessions.
- **Task notes:** append versioned note events to Pi-owned branch history;
  replay them to build the current virtual note files. Serialize writes and
  enforce byte/output bounds. A logical replace appends a new version instead
  of overwriting previous session data.
- **Recovery entry point:** persist a small manifest identifying the active
  task, latest handoff note, and unresolved user-request references.

Use transparent Pi-specific tool names initially, such as
`context_history_read` and `context_notes_write`, rather than pretending to
implement the official encrypted namespaces. Do not expose global session
search, cross-agent writes, or unrestricted filesystem note paths.

Returned history is quoted evidence, not newly authoritative instructions.
Keep system policy out of lower-trust replay, preserve existing image-read
controls, and never store credentials, raw scanner evidence, or hidden
chain-of-thought in notes. User-facing diagnostics can report reset/recovery
status without printing note contents.

### Phase 3 — opt-in reset lifecycle

Introduce an explicit mode, proposed as
`contextManagement: "native" | "local-notes"`, defaulting to `"native"`.
Start the prototype on new sessions only. No session backfill, migration,
silent mode conversion, or compatibility shim is proposed.

Persist a distinct local-reset checkpoint containing:

- window UUID, previous/first window references, and branch/thread identity;
- the archived boundary and a validated recovery manifest;
- reset reason and continuation intent;
- enough initial-context policy information to rebuild the next request;
- no fake encrypted checkpoint and no duplicated cumulative usage.

Reset protocol:

1. A completed tool call records intent only; return its result normally.
2. Wait until the entire tool batch and note writes are persisted.
3. Under the provider/session serialization boundary, validate the unchanged
   branch leaf, archive reachability, and recovery manifest.
4. Append one checkpoint; only afterward advance window state and replace
   active request history.
5. Rebuild current Pi instructions and window guidance, exclude the old native
   checkpoint/history, and invalidate the old transport continuation baseline.
6. Continue only if unfinished work or queued user input requires another
   sample. Never manufacture a user `continue`.

A failure or cancellation before checkpoint installation keeps the old window
active. Missing recovery data blocks the reset; this deliberately improves on
official forced-reset behavior. After a committed reset, resume from that
checkpoint rather than repeating old tool work. A newly queued, unsampled user
message must survive exactly once after the boundary.

The current native checkpoint search, model-lock logic, context overlay, and
host compaction handler must all recognize the new boundary consistently.
Otherwise a reset could accidentally resurrect an older opaque checkpoint.
`/tree` branch summarization remains separate.

Host context reconstruction and token estimates must also reflect the reset.
Replacing only Responses input while Pi still counts its old retained tail can
cause immediate repeated compactions. Prove the installed `0.85.1` checkpoint
adapter handles this in host tests; do not assume that a custom metadata entry
alone changes Pi's context. Archive preservation and active-context replacement
are separate requirements.

Use the existing provider-boundary mechanism for an extension-only prototype,
with the same documented limitation around host lifecycle events. Do not
invoke unawaited `ctx.compact()` from inside a tool and hope it races safely.
For full lifecycle parity, prefer a reviewed Pi API that supports an awaited,
transactional replace-context-and-continue operation at the safe boundary.

In the proposed opt-in mode, route manual/automatic compaction through the same
validated reset installer; manual reset requires a valid recovery manifest and
must not unexpectedly resume completed work. Do not silently fall back from
failed native compaction into this mode.

### Phase 4 — budget guidance and evaluation

Keep budget calculation in one policy module shared by the remaining-budget
tool, reminder insertion, provider-boundary checks, and forced-reset decisions.

- Derive limits from the active Pi model and explicit mode configuration.
- Initially count total active context, not Codex's optional body-after-prefix
  scope. Do not copy a second percentage reduction onto an already-adjusted Pi
  `contextWindow`.
- Reserve room for note writing and output before the hard ceiling.
- Emit one reminder/exhaustion prompt per window; do not rewrite the stable
  system prompt with a changing token count on every request.
- Keep request usage separate from cumulative billing usage.
- Preserve successful `end_turn:false` output and execute completed tool calls
  before any reset, including after incomplete/error terminals.

Do not change global/session defaults while evaluating. A later full official
backend experiment requires separate authorization for ingestion and remote
note writes, proof of read-after-reset and fork isolation, encrypted-result
round-trip tests, and a documented retention/recovery policy.

## 7. Acceptance tests and measurements

Use this repository's Node test framework and real Pi host harness.

| Group           | Required evidence                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Native protocol | Item-done-only checkpoint; terminal conflicts; zero/multiple items; failed/incomplete/aborted stream; bounded retries       |
| Retention       | UTF-8 boundaries; image-only messages; atomic labels; oversized image; latest user; repeated compaction; chosen role policy |
| Archive         | Stable IDs; pagination bounds; exact reads; unknown IDs; denied sibling/unrelated session; no duplicate native records      |
| Notes           | Size limits; serialized concurrent writes; immediate reads; crash/reload; ancestor inheritance without sibling leakage      |
| Reset           | Tool intent does not mutate context; all sibling results finish; one checkpoint; failed install preserves old window        |
| Continuation    | Manual versus unfinished automatic work; `end_turn:false`; partial items; post-tool failures; cancellation; queued steering |
| Replay          | No old checkpoint resurrection; no orphan tool result; `/reload`, resume, `/tree`, fork; full-input WebSocket reset and SSE |
| Safety          | No unexpected remote writes; no credential/hidden-reasoning exposure; no duplicate filesystem/process effects               |

Evaluation should include long tool chains, image-heavy work, old user
constraints, multiple simultaneous requests, interrupted note writing, reload
after reset, and branch divergence.

Compare native and local-notes modes on equivalent controlled workloads:

- task completion and constraint recall;
- repeated/lost tool actions and recovery failures;
- total input/output/cache-read tokens and cost, including notes/recovery;
- reset latency **and time until useful work resumes**;
- archive growth, retrieval volume, and compaction/reset frequency.

No numerical performance improvement is claimed yet. Synthetic unit tests
prove history integrity, not the model's ability to recover a real task.

### Validation performed for this report

- `mise exec -- npm run check`: passed the full repository non-writing checks.
- `mise exec -- npm test`: 369 passed, 2 skipped, 0 failed.
- No runtime tests were added or changed; upstream tests were inspected, not
  executed. Credentialed/live evaluation remains outside this review.

The repository currently inherits the workspace's unrelated `check` Mise task,
so the commands above use Mise to run the project-owned npm entry points.

## 8. Decision summary

- **Keep:** Pi as canonical history; native compaction default; fail-closed
  behavior; active-branch isolation; opaque model lock; no `/tree` interception.
- **Propose:** native collector hardening, a separately reviewed image budget,
  and an opt-in local-notes prototype with bounded retrieval and transactional
  reset.
- **Defer:** private backend parity, cross-agent notes, automatic mode changes,
  and any default switch until controlled evidence supports it.
- **Do not confuse:** a fresh active context with a new Pi session, an empty
  WebSocket suffix with erased history, or archived information with information
  already available to the next model request.

**Before:** long context → opaque summary/checkpoint → continue.
**Experimental official:** long context → model-written notes → fresh context
→ retrieve notes/history → continue.
**Recommended Pi prototype:** the second flow, backed by Pi's own branch-aware
records, with reset blocked unless recovery is valid.

## Primary source index

All implementation links pin the inspected stable tag, not moving `main`.

- [S1 — Remote compaction v2 and item-done collector](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2.rs),
  [attempt preparation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2_attempt.rs).
- [S2 — Retention filtering and trailing-output trimming](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote.rs),
  [initial-context placement](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact.rs).
- [S3 — Image-budget truncation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2_images.rs),
  [feature defaults](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/features/src/lib.rs).
- [S4 — Experimental activation and model-owned budget resolution](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/token_budget.rs),
  [configuration shape](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/features/src/feature_configs.rs).
- [S5 — Unsummarized compaction lifecycle](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_token_budget.rs),
  [`start_new_context_window`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/mod.rs),
  [`new_context` handler](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/new_context_window.rs),
  [sampling/reset boundary](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/turn.rs).
- [S6 — History/notes tools, schemas, encryption and output handling](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/history-notes/src/tools.rs),
  [backend client](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/history-notes/src/backend.rs),
  [activation and thread hint](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/history-notes/src/extension.rs).
- [S7 — Token-budget integration tests](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/tests/suite/token_budget.rs):
  `token_budget_context_uses_new_window_after_compaction`,
  `token_budget_mid_turn_auto_compaction_resets_before_active_follow_up`,
  `token_budget_auto_compact_fallback_uses_buffer_until_new_context`,
  `token_budget_auto_compact_fallback_rolls_over_after_buffer`,
  `new_context_tool_skips_auto_compact_fallback`.
- [S8 — Budget accounting](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/context_window.rs),
  [window state](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/state/auto_compact_window.rs),
  [model limit calculation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/openai_models.rs).
- [S9 — Bundled model prompts and budget defaults](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/models.json).
- [S10 — History-ingestion and window metadata](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/session.rs),
  [metadata serialization](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/responses_metadata.rs).

[S1]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2.rs
[S2]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote.rs
[S3]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2_images.rs
[S4]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/token_budget.rs
[S5]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_token_budget.rs
[S6]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/ext/history-notes/src/tools.rs
[S7]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/tests/suite/token_budget.rs
[S8]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/context_window.rs
[S9]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/models.json
[S10]: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/session.rs
