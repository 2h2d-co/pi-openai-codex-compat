# Official Codex CLI release compatibility log

## Purpose

This is the canonical release-by-release decision record for how
`pi-openai-codex-compat` handles:

1. the model-facing Codex protocol; and
2. `apply_patch`.

It records alignment, deliberate deviations, and excluded upstream behavior so
a later release review does not reopen settled decisions without new evidence.
When asked to “check the new Codex CLI release,” update this document using the
procedure below.

The detailed `apply_patch` contracts remain normative:

- [`APPLY_PATCH_SEMANTIC_OPERATIONS.md`](APPLY_PATCH_SEMANTIC_OPERATIONS.md)
  for parsing, matching, filesystem, planning, and execution semantics; and
- [`APPLY_PATCH_INSTRUCTION_FEEDBACK.md`](APPLY_PATCH_INSTRUCTION_FEEDBACK.md)
  for model-facing and TUI feedback.

This log records when those contracts were compared with official releases and
why their differences remain intentional.

## Dictionary

- **Official stable:** The non-prerelease release selected by both GitHub's
  latest-release endpoint and npm's `latest` dist-tag.
- **Protocol:** The model-facing Responses request, stream, history, compaction,
  metadata, usage, and tool-declaration contracts. Codex app-server and TUI
  protocols are included only when they alter one of those contracts.
- **Aligned:** The package already implements the relevant upstream behavior.
- **Retained deviation:** The package intentionally behaves differently. The
  rationale is part of the compatibility contract.
- **Excluded:** The upstream behavior belongs to a Codex runtime that this
  package does not implement.
- **Action required:** The package is intended to align, but implementation or
  validation work remains. Do not leave this status in a completed release
  review.

## Current baseline

| Item                    | Baseline                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Official stable         | Codex CLI `0.147.0` / tag `rust-v0.147.0`                                             |
| Published               | August 7, 2026                                                                        |
| Official commit         | `be6e8eac029b183056b7e4402879f15d2c85f61b`                                            |
| npm `latest`            | `@openai/codex@0.147.0`                                                               |
| Package review baseline | `pi-openai-codex-compat` `0.0.9` at commit `87c598b5674a88f450e2cfd27f9014207fba498d` |
| Reviewed                | August 17, 2026                                                                       |
| Latest prerelease seen  | `0.148.0-alpha.20`; recorded for awareness only, not as the normative baseline        |

## Durable protocol decisions

These decisions carry forward until this table is explicitly amended with a
rationale in a later release entry.

| ID      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P-001` | **Pi owns canonical sessions and branches.** Opaque compaction checkpoints live in Pi compaction entries. Exact completed Responses items are stored only as sparse native-response overrides when Pi's normal assistant representation cannot round-trip them. Codex rollout, thread, rollback, and pagination storage are not reproduced.                                                                                                 |
| `P-002` | **`response.output_item.done` is the native item commit point.** Exact done items, including unknown forward-compatible fields, are preserved for replay. Terminal `response.output` snapshots do not replace item-level commits. Started-only or otherwise incomplete items are discarded according to the provider retry contract.                                                                                                        |
| `P-003` | **The transport targets the first-party `openai-codex` endpoint without impersonating the official client.** Request and response fields needed for the endpoint are adapted, but the package does not fabricate Codex client versions, originators, attestation, W3C tracing, analytics, Git state, or unsupported runtime metadata.                                                                                                       |
| `P-004` | **Responses Lite remains explicit and default-off.** It is enabled only for the package's supported model allowlist. Official Codex may instead activate it from remotely supplied model metadata. The package assumes namespace support because this provider targets the first-party endpoint; it does not implement the official custom-provider fallback to direct declarations.                                                        |
| `P-005` | **Default and non-default namespaces have different boundaries.** Missing, empty, and `functions` response namespaces map to bare Pi tool names. Only the fixed extension-owned allowlist, currently `web.run` and `image_gen.imagegen`, becomes a non-default Responses namespace. Unknown namespaces and ambiguously flat reserved names fail closed; arbitrary MCP/plugin namespaces are not accepted.                                   |
| `P-006` | **Pi owns global tool registration and override policy.** This provider normalizes the active flat tool surface by name before serialization; the last active definition wins if duplicate names reach the provider. It does not reproduce Codex's global trusted/external tool registry or strict-collision mode because collision provenance is no longer available at this boundary. Malformed Lite namespace members still fail closed. |
| `P-007` | **Native retained context deliberately uses the Pi checkpoint shape.** The package keeps recent user, developer, and system messages under its 64k budget before the opaque compaction item. It does not adopt Codex's second installed-history filter, eligible structured agent-message retention, attached image-resize notices, or delegated-task state.                                                                                |
| `P-008` | **Pi's model and runtime capabilities remain authoritative.** Codex-only plan, account, plugin, app, MCP, Code Mode, multi-agent, permission-profile, remote-environment, and model-owned token-budget gates are excluded unless this package explicitly implements the corresponding runtime.                                                                                                                                              |
| `P-009` | **Metadata is sent only when it has a truthful Pi analogue.** The package sends Pi-derived installation, session, thread, branch, window, turn, source, sandbox, request-kind, and compaction metadata. Parent-agent/parent-turn, workspace Git, plugin, and Code Mode metadata are omitted rather than fabricated.                                                                                                                         |
| `P-010` | **Pi usage accounting is the storage boundary.** Standard input, output, cache-read, cache-write, total-token, and cost values are retained. Codex-only rollout-budget units are not stored because Pi has no corresponding usage field or persisted-goal budget runtime.                                                                                                                                                                   |
| `P-011` | **Retry and compaction control flow must preserve Pi history.** Provider retries can carry forward only committed native output. Percentage, threshold, overflow, and manual compaction use the package's documented Pi lifecycle, even where official Codex can perform the same work inside its own sampling loop or session startup.                                                                                                     |

## Durable `apply_patch` decisions

| ID      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `A-001` | **Keep the official freeform Lark grammar and strict matcher as the baseline.** Official matching-mode priority, first-match behavior, `@@` anchor meaning, `*** End of File` meaning, and unrestricted path resolution remain unless a recorded extension below says otherwise.                                                                                                                                                                                                                 |
| `A-002` | **Accept safe grammar-valid semantic operations that official Codex rejects.** Empty and identity updates, move-only updates, identical adds, absent deletes, self-moves, repeated or aliased paths, and same-patch fulfilled moves use the exact semantics in `APPLY_PATCH_SEMANTIC_OPERATIONS.md`. Inapplicable operations are skipped only after a complete filesystem-identity-aware proof that no observable result changes.                                                                |
| `A-003` | **Retain conservative formatter recovery.** It runs only after strict matching fails and accepts only exhaustive mappings with byte-identical final output. Tree-sitter recovery is exact-token and whole-line; replacement text is opaque. Typed Markdown fences and exact-cell tables are supported, while prose reflow, optional punctuation, partial-line, single-token, and heuristic candidate selection are rejected. Strict edits preserve local CRLF rather than Codex's LF conversion. |
| `A-004` | **Validate every hunk before writes.** Parsing, path resolution, semantic planning, conflict detection, and virtual sequential execution are side-effect free. Predictable conflicts reject the whole patch before mutation. Low-level runtime failures can still leave confirmed partial effects, which are inspected and reported without destructive rollback.                                                                                                                                |
| `A-005` | **Use operation-specific filesystem semantics.** Pure moves preserve opaque bytes and symlink entries, use native rename when valid, and model cross-filesystem and hard-link topology. Text updates follow live symlinks; adds and move destinations replace link entries. Directories and unsupported special entries reject. The normative details are not inferred from official changes; they live in the semantic reference.                                                               |
| `A-006` | **Participate in Pi's mutation queue and the extension's process-local alias queue.** Every source and destination uses Pi's queue; proven case, Unicode, symlink-parent, and hard-link aliases also use deterministic extension-local keys. This intentionally exceeds official parser/executor behavior but does not claim cross-process coordination or coordination with unrelated Pi mutation tools.                                                                                        |
| `A-007` | **Do not reproduce Codex sandbox or approval orchestration.** Pi extensions execute with host permissions. The package does not fabricate Codex permission profiles, environment selection, approval caching, automatic review, or sandbox-violation telemetry. Filesystem safety instead comes from complete semantic preflight, mutation queues, execution-time identity checks, and fail-closed behavior.                                                                                     |
| `A-008` | **Keep structured Pi-native results.** Model and TUI output share one instruction ledger, include every instruction when a ledger is needed, preserve A/M/D summaries, attribute partial effects to the failing instruction, inspect final path states, and retain structured textual/path-only history. This is intentionally richer than official `apply_patch` stdout and Codex TUI events.                                                                                                   |

Do not reopen an `A-*` decision merely because official Codex still differs.
Reopen it only when a new official release changes the underlying grammar,
matching, filesystem, safety, or result contract in a way that supplies new
technical evidence.

## Release log

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

#### Protocol review

| Official `0.147.0` change                                                                                                                                              | Package decision                                                                                                                                                                                                                                                                   | Status                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Responses Lite now groups top-level function and custom tools into one `functions` namespace for namespace-capable providers.                                          | The package had already adopted the post-`0.146.0` upstream contract. It preserves first-occurrence placement, explicit non-empty namespace descriptions, an empty default description, member ordering, and empty-namespace omission.                                             | Aligned               |
| Freeform custom tools can carry `defer_loading` and can appear inside namespace and tool-search output declarations.                                                   | Immediate `apply_patch` omits `defer_loading`, equivalent to official `None`. Pi additive tool-search history emits `defer_loading: true`, and the Lite transformer accepts both function and custom children.                                                                     | Aligned               |
| Flat, empty-namespace, and `functions` tool names are canonical aliases. The official registry also adds optional strict collision rejection and reserved-name checks. | Response calls use the same default-namespace aliases. The package retains `P-005` and `P-006`: Pi owns registration, only fixed non-default namespaces are adapted, malformed or unknown namespaces fail closed, and duplicate flat Pi names are normalized rather than rejected. | Retained deviation    |
| Function-call items can preserve `encrypted_function_args`; an empty array identifies plaintext direct collaboration messages in specific multi-agent tools.           | Raw done items preserve this unknown field through native overrides under `P-002`. The package does not interpret it because Codex collaboration tools and logging are excluded by `P-008`. Ordinary Pi tool calls remain canonical Pi calls.                                      | Excluded runtime      |
| Completed usage can include `codex_rollout_budget_units`.                                                                                                              | Standard usage remains aligned. The extra field is intentionally not stored under `P-010`; no goal or rollout-budget behavior is inferred from it.                                                                                                                                 | Retained deviation    |
| Turn metadata can include `parent_turn_id`.                                                                                                                            | Omitted under `P-009` because this package has no Codex parent-agent turn lifecycle.                                                                                                                                                                                               | Excluded runtime      |
| Remote-compaction retention now groups image-resize notices with source items and can retain bounded non-final structured agent messages.                              | The package retains its Pi checkpoint shape under `P-007`. It does not create official image-resize notices or delegated-agent messages, and does not change its 64k retained-context selection.                                                                                   | Retained deviation    |
| Model metadata centralizes instruction templates and adds plugin/app guidance, collaboration messages, and model-owned token-budget defaults.                          | Pi supplies the model catalog and system prompt. Plugin, app, collaboration, and model-owned budget runtimes remain excluded by `P-008`; the provider does not synthesize their instructions.                                                                                      | Excluded runtime      |
| Attempted tool calls can be attached to internal message metadata for official analytics.                                                                              | The package preserves provider-returned unknown metadata but does not create Codex analytics metadata, consistent with `P-003`.                                                                                                                                                    | Excluded runtime      |
| Cached web search and remote compaction were added for Amazon Bedrock.                                                                                                 | This package targets the first-party `openai-codex` endpoint and does not implement Bedrock provider translation.                                                                                                                                                                  | Excluded provider     |
| Command secret redaction was added to Codex app-server projections and replay UI.                                                                                      | The package does not own Pi's shell-command projection or general session UI. It preserves exact provider items for replay and does not mutate opaque or encrypted history. Secret handling outside extension-owned diagnostics and tool results remains Pi's responsibility.      | Excluded presentation |
| The SSE usage parser changed only to carry rollout-budget units; no relevant turn terminal, item-commit, WebSocket continuation, or retry wire change was found.       | Keep the package's current transport, commit-point, retry, and continuation behavior.                                                                                                                                                                                              | Aligned               |

#### `apply_patch` review

| Official `0.147.0` change                                                                                                                                            | Package decision                                                                                                                                                                                                    | Status           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| No files changed in `codex-rs/apply-patch/`; the parser, matcher, invocation semantics, fixtures, and standalone executor are unchanged from `0.146.0`.              | Keep the existing official strict baseline and every recorded `A-*` extension. No semantic reevaluation or implementation change is warranted.                                                                      | Aligned baseline |
| The freeform tool specification gained `defer_loading: None`.                                                                                                        | The package's immediate custom grammar declaration omits the optional field, which is wire-equivalent. Deferred additive declarations already emit `defer_loading: true`.                                           | Aligned          |
| Core handling was consolidated around the selected turn environment and current permission profile; approval actions now carry shared changes and sandbox telemetry. | Retain `A-007`. This is official runtime orchestration, not a parser, matcher, or filesystem-semantic change. Pi has no corresponding Codex environment, permission-profile, approval, or sandbox runtime to adapt. | Excluded runtime |

#### Outcome

- No runtime implementation change was required for `0.147.0`.
- `RESPONSES_LITE_COMPATIBILITY.md` and the README baseline were advanced from
  the inspected post-`0.146.0` upstream state to the official `0.147.0`
  release.
- Existing protocol and `apply_patch` tests remain the executable evidence for
  the aligned behavior and retained deviations.

## Procedure for the next release

Complete every step when asked to check a new official Codex CLI release.

1. **Resolve the release.**
   - Verify GitHub's latest non-prerelease release.
   - Verify npm's `@openai/codex` `latest` dist-tag.
   - If they disagree, do not advance the baseline; record the discrepancy and
     ask Kaan how to proceed.
   - Record newer prereleases for awareness, but do not use one as the
     normative baseline unless Kaan explicitly requests a prerelease review.
2. **Pin exact source.**
   - Record the tag, publication date, and commit SHA.
   - Compare the new tag with the previous reviewed stable tag, not with
     unpinned `main`.
   - Use the release notes for discovery, then verify every relevant claim
     against source and tests.
3. **Inspect protocol changes.**
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
   - Map each material change to an existing `P-*` decision or add a new
     durable decision with an explicit rationale.
4. **Inspect `apply_patch` changes.**
   - Always diff `codex-rs/apply-patch/`, the Lark grammar, prompt/tool
     specification, core handler, runtime, approval/sandbox path, protocol
     events, and tests.
   - Separate parser, matcher, and filesystem changes from
     orchestration-only changes.
   - Map each material change to an existing `A-*` decision. Do not infer that
     an intentional deviation became accidental merely because upstream still
     differs.
5. **Decide before implementing.**
   - Classify each item as Aligned, Retained deviation, or Excluded.
   - If alignment is intended, implement and validate it before completing the
     release entry.
   - If a genuinely new product decision cannot be resolved from the durable
     rules, ask Kaan before implementation instead of leaving an unresolved
     status.
6. **Update documentation.**
   - Advance **Current baseline** and append a release entry; never erase old
     decisions silently.
   - Update README compatibility wording and focused reports when their
     baselines or claims changed.
   - Update the semantic and feedback references only when their normative
     contracts changed.
   - Add a changelog entry only for a user-visible package change, not for a
     source-review-only baseline update.
7. **Validate and commit.**
   - Add or update regression tests for every implementation change.
   - Run `npm run check` and `npm test`.
   - Record the implementation outcome and validation in the release entry.
   - Commit the review and any required adaptation as a cohesive checkpoint.

## Primary official sources

- [OpenAI Codex releases](https://github.com/openai/codex/releases)
- [Latest stable GitHub release](https://github.com/openai/codex/releases/latest)
- [`@openai/codex` on npm](https://www.npmjs.com/package/@openai/codex)
- [Codex changelog](https://developers.openai.com/codex/changelog)
