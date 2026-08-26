# Official Codex CLI release compatibility log

## Purpose

This document answers two questions after every official Codex CLI release:

1. What changed in the model-facing protocol or `apply_patch`?
2. Will this package follow that change, deliberately behave differently, or
   exclude it because the required Codex runtime does not exist in Pi?

The goal is to preserve decisions and their reasons. A later review must not
treat a known deviation as an accidental bug merely because official Codex
still behaves differently.

The detailed `apply_patch` contracts remain normative:

- [`APPLY_PATCH_SEMANTIC_OPERATIONS.md`](APPLY_PATCH_SEMANTIC_OPERATIONS.md)
  defines parsing, matching, filesystem, planning, and execution behavior.
- [`APPLY_PATCH_INSTRUCTION_FEEDBACK.md`](APPLY_PATCH_INSTRUCTION_FEEDBACK.md)
  defines model-facing and TUI feedback.

## Dictionary

- **Protocol:** Model-facing Responses requests, streams, history, compaction,
  metadata, usage, and tool declarations.
- **Aligned:** We already behave like official Codex for the relevant feature.
- **Intentional deviation:** We deliberately behave differently for a recorded
  reason.
- **Excluded:** The change belongs to a Codex runtime this package does not
  implement. Copying only its wire shape would be misleading.
- **Revisit condition:** The concrete event that would justify reconsidering a
  decision.

## Current baseline

| Item                    | Baseline                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Official stable         | Codex CLI `0.149.1` / tag `rust-v0.149.1`                                                      |
| Published               | August 24, 2026                                                                                |
| Official commit         | `ff29a44391deccde0aba0f8390337d7f3c319ea4`                                                     |
| npm `latest`            | `@openai/codex@0.149.1`                                                                        |
| Package review baseline | `pi-openai-codex-compat` `0.0.10-alpha.3` at commit `32380caa762180de4a748bcacbfe8f4d32155093` |
| Reviewed                | August 25, 2026                                                                                |
| Latest prerelease seen  | `0.150.0-alpha.11`; noted only, not used as the baseline                                       |

## Decisions at a glance

### Protocol

- **Pi remains the source of truth for conversations.** We adapt Codex
  Responses items to Pi sessions instead of recreating Codex's rollout store.
- **Only completed provider items enter history.** The
  `response.output_item.done` event is our commit point.
- **We do not pretend to be the official CLI.** Required endpoint metadata is
  sent; Codex versions, attestation, tracing, analytics, and unsupported
  runtime state are not fabricated.
- **Responses Lite remains user-controlled and default-off.**
- **Only extension-owned dotted tools become native namespaces.** Unknown
  namespaces fail closed.
- **Compaction keeps a Pi-specific retained-history shape.**
- **Codex-only runtimes stay excluded until they are implemented as real Pi
  runtimes.**
- **Retries and compaction must preserve canonical Pi history.**
- **Transport recovery remains bounded rather than approximating Codex's
  unbounded connection-error category.**

### `apply_patch`

- **Official grammar and strict matching stay the compatibility baseline.**
- **Safe semantic extensions are intentional.** This includes move-only
  updates, harmless no-change instructions, repeated paths, and exactly proven
  skipped operations.
- **Matching stops after the official Codex-compatible line matcher; no
  formatter-recovery fallback is implemented.**
- **The complete patch is validated before writes.**
- **Filesystem behavior explicitly accounts for symlinks, hard links, opaque
  files, and cross-filesystem moves.**
- **All affected paths participate in mutation queues.**
- **Codex sandbox and approval dialogs are not simulated.**
- **Pi receives richer, structured failure and instruction feedback than
  official `apply_patch` stdout.**

## Detailed protocol decisions

### P-001 — Pi owns session and branch history

- **Our choice:** Pi sessions, branches, and compaction entries are canonical.
  We store an opaque Codex checkpoint in a Pi compaction entry. We add a sparse
  native-response override only when Pi's ordinary assistant message cannot
  round-trip completed Responses items exactly.
- **Official Codex:** Owns its rollout, thread, turn, rollback, fork, and
  paginated-history stores.
- **Why:** Running a second canonical conversation store beside Pi would create
  conflicting branch and compaction state.
- **Revisit only if:** Pi introduces a supported Codex-native session store or
  this package stops integrating with Pi session history.

### P-002 — Completed output items are the history commit point

- **Our choice:** For ordinary streamed assistant output, commit exact items
  from `response.output_item.done`. Preserve unknown fields on those items for
  forward-compatible replay. Unknown item `type` variants fail closed until an
  official release review adds them to the supported schema union. Discard
  started-only and incomplete items. The terminal response's `output` array is
  normally empty and is not used to reconstruct the completed output.
- **Official Codex:** Uses completed output items as durable model output.
- **Why:** The item-done events are the stream's reliable source of completed
  output; the terminal event normally supplies status and usage rather than
  output items. This boundary also prevents retries from duplicating partial
  text or tool calls.
- **Revisit only if:** Official Codex changes its item-level commit semantics
  or adds an item type this package must interpret or replay.

### P-003 — Adapt the endpoint without impersonating the official client

- **Our choice:** Identify the client truthfully as Pi with `originator: pi`
  and a Pi user agent. Send fields required for the first-party
  `openai-codex` endpoint, but do not invent an official Codex client version
  or identity, attestation, W3C trace, analytics payload, or Git state.
- **Official Codex:** Can truthfully send those values because it owns those
  systems.
- **Why:** Fabricated operational metadata is incorrect and can make debugging
  or policy decisions misleading.
- **Revisit only if:** Pi exposes a truthful equivalent that the endpoint
  requires.

### P-004 — Responses Lite is explicit and default-off

- **Our choice:** Enable Responses Lite only when the user opts in and the
  selected model is in this package's supported allowlist. Assume namespace
  support because this provider targets the first-party endpoint.
- **Official Codex:** Activates Lite from model metadata and can fall back to
  direct tool declarations for custom providers without namespace support.
- **Why:** Pi model objects do not expose the official capability fields, and
  changing request envelopes should remain user-controlled.
- **Revisit only if:** Pi exposes equivalent model and provider capability
  metadata.

### P-005 — Non-default tool namespaces are a fixed allowlist

- **Our choice:** Treat missing, empty, and `functions` namespaces as bare Pi
  tool names. Convert only `web.run` and `image_gen.imagegen` into non-default
  Responses namespaces. Reject unknown or ambiguously flat reserved names.
- **Official Codex:** Can register arbitrary MCP, plugin, app, and internal
  namespaces.
- **Why:** Pi tools are flat names, and this package owns only its two fixed
  namespaced surfaces.
- **Revisit only if:** Pi adds native namespace identity or this package owns a
  new namespaced runtime.

### P-006 — Pi owns tool registration and collision policy

- **Our choice:** Normalize the active Pi tool list by name before
  serialization. If duplicate names somehow reach the provider, the last
  active definition wins. Continue to reject malformed Lite namespace members.
- **Official Codex:** Has a trusted/external tool registry, reserved names, and
  an optional strict collision mode.
- **Why:** By the provider boundary, Pi has already resolved registration and
  no longer supplies enough provenance to reproduce Codex's registry policy.
- **Revisit only if:** Pi exposes tool-source and collision information at the
  provider boundary.

### P-007 — Compaction keeps Pi's retained-history shape

- **Our choice:** Before the opaque compaction item, retain recent user,
  developer, and system messages under a text-only 64k budget. Non-text
  content does not consume that local retained-history budget.
- **Official Codex:** Applies an additional installed-history filter, can keep
  bounded structured agent messages, groups image-resize notices with source
  items, and preserves delegated-task state. A default-disabled,
  under-development mode additionally charges retained images to the budget
  and treats an image plus adjacent harness labels as an atomic boundary unit.
- **Why:** Pi checkpoints do not represent all of those Codex-specific item
  types and currently depend on the existing retained-history shape.
- **Revisit only if:** Pi can represent those items canonically and changing
  checkpoint shape has an explicit migration plan, or official image budgeting
  becomes the stable default and the package adopts a corresponding checkpoint
  migration.

### P-008 — Do not copy schemas for runtimes we do not implement

- **Our choice:** Exclude Codex-only plugin, app, MCP, Code Mode, multi-agent,
  asynchronous-message, permission-profile, remote-environment, plan, goal,
  memory, remote-skill-resource, and model-owned token-budget behavior.
- **Official Codex:** Owns the state, trust, UI, execution, and lifecycle
  systems behind those fields and tools.
- **Why:** Sending a schema without the corresponding runtime would claim
  capabilities that do not work.
- **Revisit only if:** A specific runtime is deliberately implemented in this
  package or a separate Pi package.

### P-009 — Send only truthful metadata

- **Our choice:** Send Pi-derived installation, session, thread, branch,
  window, turn, source, sandbox, request-kind, and compaction metadata. Omit
  parent-agent, parent-turn, workspace Git, plugin, and Code Mode metadata.
- **Official Codex:** Sends those extra values when its runtime owns them.
- **Why:** Missing data is more accurate than fabricated lineage.
- **Revisit only if:** Pi gains an equivalent lifecycle and exposes it here.

### P-010 — Pi's usage model is the accounting boundary

- **Our choice:** Store standard input, output, cache-read, cache-write, total
  token, and cost values. Ignore `codex_rollout_budget_units`.
- **Official Codex:** Uses rollout-budget units in its goal and budget
  runtimes.
- **Why:** Pi has no corresponding usage field or persisted-goal budget
  runtime.
- **Revisit only if:** Pi adds a first-class field with defined accounting
  semantics.

### P-011 — Retry and compaction flow must preserve Pi history

- **Our choice:** Provider retries may carry forward only committed native
  output. Percentage, threshold, overflow, and manual compaction follow the
  documented Pi-compatible lifecycle.
- **Official Codex:** Can perform retries and compaction entirely inside its own
  sampling and session-startup loops.
- **Why:** Pi remains responsible for visible messages, tool execution,
  branches, and compaction entries.
- **Revisit only if:** Pi delegates the complete agent sampling loop to the
  provider.

### P-012 — Keep transport recovery bounded

- **Our choice:** Retry fresh WebSockets at most five times before sticky SSE
  fallback, and retry SSE transport failures at most five times before
  model-visible output. Do not approximate an unbounded connection-only retry
  category from the phase of a Fetch request.
- **Official Codex:** Enables `unbounded_connection_retries` by default for
  sampling `ConnectionFailed` errors outside internal sessions and Amazon
  Bedrock. Those retries use a separate counter, wait 5 seconds, double to a
  60-second cap, and continue until cancellation. Reqwest distinguishes
  connection establishment from timeouts, HTTP failures, and established
  stream failures; ordinary failures retain the bounded retry and transport
  fallback path.
- **Why:** The standard Fetch API reliably reveals whether response headers
  arrived, but not Reqwest's narrower `is_connect()` category. A request can
  reach the server and fail before headers, and custom Fetch implementations
  can reject for deterministic non-network reasons. Treating that broader
  phase as unbounded could repeat accepted work indefinitely and hold Pi's
  provider turn open without a faithful error classification.
- **Revisit only if:** Pi's supported transport exposes a stable semantic
  connection-error category, or this package deliberately adds a
  user-controlled connection-recovery policy.

## Detailed `apply_patch` decisions

### A-001 — Official grammar and strict matching are the baseline

- **Our choice:** Keep the official freeform Lark grammar, matching-mode
  priority, first-match behavior, `@@` anchor meaning, `*** End of File`
  meaning, and unrestricted path resolution unless another recorded decision
  explicitly changes behavior.
- **Why:** This preserves the model contract and predictable official patch
  behavior.
- **Revisit only if:** An official release changes the grammar or strict
  matcher.

### A-002 — Safe semantic extensions are intentional

- **Our choice:** Accept grammar-valid move-only updates, empty and identity
  updates, identical adds, absent deletes, self-moves, repeated or aliased
  paths, and same-patch fulfilled moves. Skip an inapplicable operation only
  after proving that every effect is unobservable.
- **Official Codex:** Rejects several of these forms even when their meaning or
  no-change postcondition is safe.
- **Why:** The objective is safe filesystem semantics, not rejection of
  harmless model output.
- **Revisit only if:** A counterexample shows that an accepted operation is
  ambiguous or unsafe.

### A-003 — Do not add formatter-recovery matching

- **Our policy:** Stop after the official exact, trailing-trim, full-trim, and
  Unicode matcher. Preserve its mode priority, first-match selection, anchor
  handling, pure-insertion placement, and EOF behavior. Do not add
  Tree-sitter, Markdown-table, typed-fence, formatter-reflow, exhaustive
  candidate, candidate-ranking, ambiguity, or output-equivalence matching.
  Preserve local CRLF after a successful official-compatible match.
- **Official Codex:** Uses the same matching tiers without formatter recovery.
  Its historical stable mode normalizes edited files to LF; a
  default-disabled, under-development mode preserves existing line endings and
  uses the file's preferred ending for new lines. That opt-in mode also makes
  EOF search respect the current hunk cursor.
- **Why:** Additional matching expanded the set of accepted patches and could
  apply an edit at a location not described by the complete official old-line
  sequence. Matching compatibility is safer and easier to audit when one
  source-traceable algorithm determines eligibility.
- **Revisit only if:** Official Codex changes its matcher and the corresponding
  pinned release review adopts that change.

### A-004 — Validate the complete patch before writes

- **Our choice:** Parse, resolve, simulate, and classify every instruction
  before the first mutation. Reject predictable conflicts without writing.
  After an unpredictable low-level failure, inspect and report confirmed
  partial effects without destructive rollback.
- **Official Codex:** Can leave a committed prefix when execution fails after
  earlier mutations.
- **Why:** A model-generated multi-file patch should not partially apply
  because a later semantic conflict was detectable in advance.
- **Revisit only if:** A safe transactional mechanism replaces complete
  preflight.

### A-005 — Filesystem semantics are operation-specific

- **Our choice:** Pure moves preserve opaque bytes and symlink entries, use
  native rename when valid, and model hard-link and cross-filesystem topology.
  Text updates follow live symlinks. Adds and move destinations replace
  symlink entries. Directories and unsupported special entries reject.
- **Why:** Treating every operation as a text rewrite loses identity, metadata,
  links, or binary content.
- **Revisit only if:** Host filesystem behavior or official semantics supply
  new evidence requiring a specific rule change.

### A-006 — Every affected path participates in mutation queues

- **Our choice:** Queue every source and destination through Pi's mutation
  queue for the complete preflight-and-execution window. Acquire multiple
  queue paths deterministically and retain operation-specific symlink-entry
  handling. Do not add a second extension-local alias queue.
- **Official Codex:** Uses its own execution and sandbox orchestration rather
  than Pi's queue contract.
- **Why:** Pi's queue coordinates ordinary same-target mutation tools without
  duplicating lock identity and lifecycle logic in this extension.
- **Operating model:** Relevant filesystem state is not modified outside the
  queued execution window. Separate processes, hard-link aliases not
  canonicalized by Pi, callbacks, and injected filesystem hooks must not
  mutate that state.
- **Revisit only if:** Pi provides a broader shared mutation transaction.

### A-007 — Do not simulate Codex sandbox or approval orchestration

- **Our choice:** Run with the host permissions available to Pi extensions. Do
  not fabricate permission profiles, environment selection, approval caching,
  automatic review, or sandbox telemetry.
- **Official Codex:** Routes patches through its environment, permission,
  approval, and sandbox systems.
- **Why:** A confirmation-shaped UI without enforcement would provide false
  assurance. Our safety boundary is semantic preflight, mutation queues,
  direct result postconditions, partial-failure inspection, and fail-closed
  behavior inside the single-writer operating model.
- **Revisit only if:** Pi provides an enforceable sandbox and approval
  lifecycle.

### A-008 — Keep structured Pi-native feedback

- **Our choice:** Preserve the aggregate A/M/D summary and, when explanation is
  needed, list every instruction with its status. Attribute partial effects to
  the failing instruction, inspect final path states, and store structured
  textual or path-only history for the TUI.
- **Official Codex:** Uses its own stdout, rollout events, approval events, and
  TUI cells.
- **Why:** Pi needs one canonical result that is useful to both the model and
  its TUI after success or partial failure.
- **Revisit only if:** Pi introduces a richer canonical mutation-result
  protocol that can carry the same facts.

## Release log

### Codex CLI 0.149.1

#### Baseline

- Release:
  [`rust-v0.149.1`](https://github.com/openai/codex/releases/tag/rust-v0.149.1)
- Published: August 24, 2026
- Commit: `ff29a44391deccde0aba0f8390337d7f3c319ea4`
- Compared with the previously reviewed stable:
  [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0)
  at `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`
- Source comparison:
  [`rust-v0.149.0...rust-v0.149.1`](https://github.com/openai/codex/compare/rust-v0.149.0...rust-v0.149.1)
- GitHub's latest stable release and npm's `latest` dist-tag both resolved to
  `0.149.1`. A fresh command-tool review on August 25, 2026 reconfirmed that
  baseline; the newest prerelease then observed was `0.150.0-alpha.11`.

#### What changed in the protocol

Intentional deviations retained:

1. **Optional retained-image budgeting:** Official Codex added the
   default-disabled, under-development `compaction_image_budget` mode. When
   enabled, remote-compaction-v2 retained history charges images against its
   64k budget, keeps image labels and their image atomic, and truncates the
   oldest retained boundary without backfilling older messages past an
   oversized image. P-007 retains the package's existing text-only retained
   history and exposes no equivalent experimental mode. Because the official
   stable default remains disabled, no request or checkpoint change is needed
   for default behavior.

Excluded because the runtime is absent:

1. **Memory-consolidation metadata:** Detached memory requests now identify
   their `thread_source` as `memory_consolidation`. P-008 and P-009 continue to
   exclude the memory runtime and its synthetic metadata.
2. **CLI/SDK thread-source controls:** `codex exec` and the TypeScript SDK can
   classify newly created or forked Codex threads. The package already sends
   truthful Pi-derived thread source under P-009 and does not recreate the
   Codex CLI thread lifecycle.

Already aligned or unchanged:

1. No Responses request, SSE, WebSocket, completed-item, Responses Lite, or
   tool-declaration wire contract changed.
2. The 46-name fixed built-in tool inventory is unchanged from `0.149.0`. The
   focused tool catalog was advanced from its older `0.146.0` research
   baseline and now records package coverage explicitly.

#### What changed in `apply_patch`

Nothing changed under `codex-rs/apply-patch/`, its core handler/runtime, tool
specification, grammar, matcher, filesystem path, approvals, sandbox
orchestration, protocol events, or tests. All A-series decisions remain in
force.

#### Outcome

- No runtime implementation or test change was required.
- P-007 now records the optional retained-image budget and its revisit
  condition without changing the package's checkpoint shape.
- The README, Responses Lite report, and official tool catalog were advanced
  to the `0.149.1` baseline.
- No changelog entry was added because the package's user-visible behavior did
  not change.

### Codex CLI 0.149.0

#### Baseline

- Release:
  [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0)
- Published: August 20, 2026
- Commit: `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`
- Compared with the previously reviewed stable:
  [`rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0)
  at `be6e8eac029b183056b7e4402879f15d2c85f61b`
- Intervening stable:
  [`rust-v0.148.0`](https://github.com/openai/codex/releases/tag/rust-v0.148.0),
  published August 18, 2026 at
  `3ba0f711642a888aec92a611a3f3b2211157ff89`
- Source comparison:
  [`rust-v0.147.0...rust-v0.149.0`](https://github.com/openai/codex/compare/rust-v0.147.0...rust-v0.149.0)
- GitHub's latest stable release and npm's `latest` dist-tag both resolved to
  `0.149.0`.

#### What changed in the protocol

Implemented or already aligned:

1. **Misalignment policy failures:** Official Codex now maps
   `misalignment_policy_violation` to a typed, non-retryable error and stops
   the active TUI chat. The package now treats the same streamed failure code
   as terminal before and after linked tool execution, makes one request, and
   preserves the provider's message.
2. **Model routing hints:** Official first-party requests now send the
   model-and-service-tier routing hint. The package already sends the same
   endpoint-owned hint for ordinary, prewarm, retry, fallback, and compaction
   requests.
3. **Response storage:** Official Azure Responses requests now explicitly
   disable storage. The package already sends `store: false` on its first-party
   Responses paths.
4. **Wire schemas:** No new provider `ResponseItem` variant or Responses Lite
   default-tool namespace layout requires a package schema or serializer
   change. Known item variants continue to preserve additional provider
   fields under P-002.

Intentional deviations retained:

1. **Unbounded connection recovery:** Official Codex now has a stable,
   default-enabled `unbounded_connection_retries` feature for sampling
   connection-establishment failures. P-012 retains the package's bounded
   five-WebSocket and five-SSE retry behavior. No phase-only or error-code
   approximation was added.
2. **Tool namespace metadata:** Official turns can advertise configured
   namespace inventories. P-004 through P-006 retain the package's explicit
   Responses Lite setting, fixed extension-owned namespace allowlist, and
   Pi-owned tool registration.
3. **Request metadata:** Official requests can carry configurable metadata,
   sandbox state, and expanded harness context. P-003 and P-009 continue to
   send only truthful Pi-owned values.

Excluded because the runtime is absent:

1. safety-buffering metadata, Guardian sampling, approval routing, and stored
   risk scores;
2. rollout history envelopes, turn-aware item injection, asynchronous user
   messages, and tool-lifecycle history access;
3. provider-owned custom authentication recovery and model-catalog ETag
   refresh; and
4. plugin, MCP, remote-environment, Code Mode, and multi-agent lifecycle
   additions.

#### What changed in `apply_patch`

1. **Grammar and strict matching:** The grammar and exact, trailing-trim,
   full-trim, and Unicode matching tiers did not change. The stable default
   still uses the previously reviewed matcher behavior.
2. **Optional line-ending preservation:** Official Codex added the
   default-disabled, under-development
   `apply_patch_preserve_line_endings` mode. It preserves existing terminators,
   chooses the file's preferred ending for inserted lines, and makes EOF
   search respect the current hunk cursor. The package retains A-003: preserve
   the matched region's local endings after the stable official-compatible
   matcher succeeds, without adopting a second matcher mode.
3. **Duplicate resolved paths:** Official verification now rejects multiple
   operations resolving to the same path. A-002 deliberately retains
   sequential repeated and aliased paths after complete virtual preflight.
4. **No-follow filesystem access:** Official Codex can disable symlink
   following when otherwise-required sandbox enforcement is unavailable;
   standalone `apply_patch` still follows symlinks by default. The package
   retains its operation-specific A-005 symlink semantics and does not copy a
   sandbox fallback without the A-007 runtime. Ancestor replacement during
   execution is outside the queued single-writer model recorded in A-006.
5. **Permission orchestration:** Official core handling avoids widening a
   selected environment's write permissions for patch execution. This remains
   excluded under A-007; Pi extensions run with host process permissions.

#### Outcome

- One runtime compatibility fix was committed:
  `misalignment_policy_violation` is terminal and preserves the provider
  message.
- Unbounded connection retries were reviewed and deliberately not
  implemented; P-012 records the bounded policy and revisit condition.
- No `apply_patch` implementation change was adopted as part of this release
  review. The strict matcher, repeated-path extension, line-ending policy,
  symlink semantics, and move semantics remain unchanged.
- The README and Responses Lite report were advanced to the official
  `0.149.0` baseline.

### Codex CLI 0.147.0

#### Baseline

- Release:
  [`rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0)
- Published: August 7, 2026
- Commit: `be6e8eac029b183056b7e4402879f15d2c85f61b`
- Compared with:
  [`rust-v0.146.0`](https://github.com/openai/codex/releases/tag/rust-v0.146.0)
  at `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`
- Source comparison:
  [`rust-v0.146.0...rust-v0.147.0`](https://github.com/openai/codex/compare/rust-v0.146.0...rust-v0.147.0)

#### What changed in the protocol

Already aligned:

1. **Responses Lite default tools:** Official Codex now groups top-level
   function and custom tools into one `functions` namespace. The package
   already used this layout.
2. **Deferred freeform tools:** Official custom tools can carry
   `defer_loading` and appear inside namespaces or tool-search output. The
   package already emits the equivalent eager and deferred forms.
3. **Default namespace aliases:** Missing, empty, and `functions` namespaces
   identify the same default tool surface. The package maps all three to bare
   Pi names.
4. **Transport terminals:** No relevant item-commit, turn-terminal, WebSocket
   continuation, or retry wire change was found.

Intentional deviations retained:

1. **Strict tool collisions:** Official Codex can reject registry collisions.
   We retain P-006 because Pi has already resolved registration before the
   provider sees tools.
2. **Rollout-budget usage:** Official usage can include
   `codex_rollout_budget_units`. We retain P-010 and do not store it.
3. **Compaction history:** Official Codex can retain bounded structured agent
   messages and attached image-resize notices. We retain the Pi checkpoint
   shape under P-007.

Excluded because the runtime is absent:

1. `encrypted_function_args` semantics for plaintext multi-agent messages;
2. `parent_turn_id` for parent-agent lineage;
3. attempted-tool-call analytics metadata;
4. plugin/app/collaboration/model-budget instruction systems;
5. Amazon Bedrock search and compaction translation; and
6. Codex app-server command redaction and replay presentation.

Raw completed response items still preserve unknown provider fields under
P-002, even when the package does not interpret the corresponding runtime.

#### What changed in `apply_patch`

1. **No parser or filesystem change:** Nothing changed under
   `codex-rs/apply-patch/`. The parser, matcher, fixtures, and standalone
   executor are unchanged from `0.146.0`. All A-series decisions remain in
   force.
2. **Optional deferred field:** The official eager tool now has
   `defer_loading: None`. Omitting that optional field is wire-equivalent to
   the package's eager declaration. Deferred Pi history already sends `true`.
3. **Permission orchestration refactor:** Official core handling now uses the
   selected environment's current permission profile and revised approval
   action. This is excluded under A-007 because it did not change patch
   semantics and Pi has no corresponding enforcement runtime.

#### Outcome

- No runtime implementation change was required for `0.147.0`.
- `RESPONSES_LITE_COMPATIBILITY.md` and the README baseline were advanced to
  the official `0.147.0` release.
- Existing protocol and `apply_patch` tests remain the executable evidence.

## Procedure for the next release

When asked to check a new official Codex CLI release:

1. **Resolve the stable release.**
   - Verify GitHub's latest non-prerelease release.
   - Verify npm's `@openai/codex` `latest` dist-tag.
   - If they disagree, do not advance the baseline; ask Kaan how to proceed.
   - Note prereleases for awareness, but use one as the baseline only when Kaan
     explicitly requests it.
2. **Pin and compare exact source.**
   - Record the tag, publication date, and commit SHA.
   - Compare with the previous reviewed stable tag, not unpinned `main`.
   - Use release notes for discovery, then verify against source and tests.
3. **Inspect the protocol.**
   - Requests and transports:
     `codex-rs/core/src/client.rs`,
     `codex-rs/codex-api/src/requests/responses.rs`,
     `codex-rs/codex-api/src/endpoint/responses.rs`,
     `codex-rs/codex-api/src/endpoint/responses_websocket.rs`, and
     `codex-rs/codex-api/src/sse/responses.rs`.
   - History and compaction:
     `codex-rs/core/src/context_manager/`,
     `codex-rs/core/src/compact*.rs`, rollout handling, and their tests.
   - Metadata and models:
     `codex-rs/core/src/responses_metadata.rs` and
     `codex-rs/protocol/src/`.
   - Tool wire contracts:
     `codex-rs/tools/src/`, `codex-rs/core/src/tools/`, and Responses Lite
     tests.
4. **Inspect `apply_patch`.**
   - Diff `codex-rs/apply-patch/`, the Lark grammar, prompt and tool
     specification, core handler, runtime, approvals, sandbox path, protocol
     events, and tests.
   - Separate parser, matcher, and filesystem changes from orchestration-only
     changes.
5. **Make each decision explicit.**
   - Map every material change to an existing P-series or A-series decision.
   - For a new decision, record our choice, official behavior, reason, and
     revisit condition.
   - If the decision cannot be resolved from existing policy, ask Kaan before
     implementing it.
   - Do not leave an unresolved “action required” entry in a completed review.
6. **Update and validate.**
   - Advance the current baseline and append a release entry.
   - Update README and focused reports whose claims changed.
   - Change normative semantic documents only when their contracts changed.
   - Add a changelog entry only for a user-visible package change.
   - Add tests for implementation changes, then run `npm run check` and
     `npm test`.
   - Commit the review as a cohesive checkpoint.

## Primary official sources

- [OpenAI Codex releases](https://github.com/openai/codex/releases)
- [Latest stable GitHub release](https://github.com/openai/codex/releases/latest)
- [`@openai/codex` on npm](https://www.npmjs.com/package/@openai/codex)
- [Codex changelog](https://developers.openai.com/codex/changelog)
