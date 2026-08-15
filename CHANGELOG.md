# Changelog

## Unreleased

### Added

- Add a default-off `applyPatchDebug` setting, environment override, and `/codex-settings` control that labels calls `apply_patch (debug)` and shows exact model-facing feedback without a redundant renderer-only heading in collapsed completed results while preserving normal diffs when expanded.

### Changed

- Omit Pi's auto-compaction state from the compatibility footer until extensions can observe its live value.
- Evaluate grammar-valid `apply_patch` operations against a sequential virtual filesystem, accepting harmless no-ops and provably dead updates while rejecting conflicts before writes.
- Recover uniquely determined `apply_patch` edits after whitespace-only formatter line reflow using the official `web-tree-sitter` runtime and packaged `@2h2d/tree-sitter-wasms` grammars for JavaScript, JSX, TypeScript, TSX, Python, Go, Java, and Scala, including typed Markdown code fences and formatter-aligned tables; require exact old-side punctuation and apply requested replacement lines without reinterpretation.
- Move regular files and symbolic-link entries opaquely for move-only `apply_patch` hunks, preserving arbitrary binary bytes and rendering path-only move history.
- Preserve the aggregate `apply_patch` changed-file summary and list every concise source-ordered result under `Patch instruction results:` as `N. [STATUS] operation` in model and TUI feedback.

### Fixed

- Preserve each matched source region's local line endings when strict `apply_patch` matching edits CRLF or mixed-line-ending files.
- Model native renames and cross-filesystem copy-and-unlink moves with distinct hard-link topology, and account for earlier planned unlinks when proving later edits dead.
- Record symbolic-link deletion as a path-only entry operation so history and rendering never claim that the link target's bytes were deleted.
- Serialize same-process `apply_patch` calls across case, Unicode, symlink-parent, and hard-link aliases while retaining Pi's ordinary path queues.
- Render semantic no-change and skipped results in simplified technical English, without instruction limits, detached proof sections, or repeated patch text.
- Attribute completed filesystem effects, deterministic post-failure path states, matcher evidence, and errors to the instruction that produced them.
- Preserve confirmed partial-move effects in changed-file summaries when later inspection is unavailable, without rendering the partial operation as a completed rename.
- Report parent-directory and temporary-entry failure effects without a false no-change summary.
- Report patch-level errors once and distinguish stopped instructions from input failures.
- Keep unreadable previous content and diff availability out of model feedback.
- Execute the move strategy proven during validation, with an injectable filesystem boundary covering native rename, cross-filesystem replacement, Windows overwrite fallback, and partial-failure inspection.
- Retry Tree-sitter parser and grammar initialization after transient failures, and cover cancellation across queue, matching, pre-mutation, and committed-prefix phases.
- Reject FIFOs, Unix sockets, directories, and available character or block devices during side-effect-free preflight.
- Avoid dereferencing symbolic-link targets while queuing entry-only operations and no-op updates, including cyclic links.
- Replay later add/delete entry state when proving stale hard-link updates dead.
- Preserve cancellation raised during Tree-sitter work and classify pure-move filesystems from the source entry rather than its parent.
- Re-resolve relative symbolic-link targets from their destination after native or cross-filesystem pure moves.
- Deduplicate byte-identical line and structural matcher candidates before applying candidate and mapping limits.

### Security

- Require npm releases to match a locally built SHA-256 recorded in an SSH-signed release commit before trusted publishing can stage the package.
- Require code-owner review for release policy, protect `main` and `v*` refs, and gate npm OIDC behind a reviewed tag-only environment.

## 0.0.6 - 2026-08-10

### Added

- Add `npm run pack:dry` to inspect the npm package contents before release.

### Changed

- Require Pi 0.84.x, use Pi 0.84.1 as the development integration baseline, and preserve Pi 0.84 header removals across Codex tools and native compaction.

### Fixed

- Support Pi 0.84's subscription-aware default footer without crashing during startup.

## 0.0.5 - 2026-08-07

### Fixed

- Avoid repeating the extension name in Pi's startup display.

## 0.0.4 - 2026-08-07

### Added

- Persist and send the official Codex installation/window request identity used for backend affinity, advancing the window after successful compaction.
- Persist structured Codex transport-recovery diagnostics on assistant messages for rejected or locally bypassed WebSocket continuations and WebSocket-to-SSE recovery, including request modes, cache-affinity preservation, and exact response ids.
- Prewarm only the static instruction/tool prefix with Responses v2 `generate: false`, generate the dynamic conversation from its continuation, and persist whether prewarm established continuation state.
- Send Pi-derived Codex session, thread, turn, and request-kind metadata through `client_metadata` and compatible request headers, with one turn id shared across each Pi agent run.
- Capture server-issued Codex turn state once per agent run, replay it across WebSocket retries, SSE requests, and WebSocket-to-SSE fallback, and include the exact value in transport diagnostics.
- Persist cache diagnostics with exact session, account, cache, turn, response, and routing-state identifiers alongside transport selection, full/delta request sizes, static-prefix fingerprints, and reported cache read/write usage.
- Record the exact baseline and current history items when local WebSocket continuation validation rejects a changed prefix.
- Persist hidden thread markers for finalized `/tree` branches, send branch-specific Codex thread/fork/window lineage while retaining the root prompt-cache identity, and reset WebSocket continuation state when switching threads.
- Add a default-off `responsesLite` setting, environment override, and `/codex-settings` control for switching supported GPT-5.6 models between ordinary Responses and Responses Lite.
- Use Codex's Responses Lite input envelope, metadata, request header, tool grouping, and all-turn reasoning context for GPT-5.6 Sol, Terra, and Luna.

### Changed

- Align Responses Lite with current Codex default-tool namespaces, HTTP/WebSocket metadata placement, prewarm identity, and per-request WebSocket timing metadata.
- Align ordinary function declarations with Codex's explicit `strict: false` and ignore Pi's generic temperature option because Codex Responses has no temperature request field.
- Send the official thread-scoped `x-client-request-id` on Responses HTTP/SSE requests and require all prompt-cache affinity identifiers to match before diagnostics report alignment.
- Continue provider-owned sampling when `response.completed.end_turn` is false, and resample retryable `response.failed` and `response.incomplete` events from the completed output history already received.
- Send official nested Responses Compaction v2 metadata, classifying manual, threshold, provider-boundary, and overflow compaction by trigger, reason, phase, implementation, and strategy.
- Align first-party Codex Responses, WebSocket, and compaction requests with the official model-and-tier routing hint.
- Match official Codex request continuity more closely by always serializing the ordinary `tools` array, omitting the legacy SSE beta header, ignoring response-only stream options and internal item metadata during WebSocket delta comparison, retaining healthy session sockets, and applying jittered retry backoff.
- Resample retryable SSE HTTP failures and dropped streams up to five times before model-visible output while preserving cache and account identity; fail closed after visible output.
- Retry retryable WebSocket failures on up to five fresh connections before selecting sticky SSE when no model-visible output has been emitted.
- Treat WebSocket response metadata as non-visible during retry decisions and send the Responses Lite HTTP marker only on SSE while retaining its WebSocket body metadata.

### Fixed

- Preserve completed native output items, discard only unfinished attempt content, and accumulate usage across provider-owned response resampling.
- Normalize missing, empty, and `functions` namespaces for Responses Lite function and custom calls, preserve the server's flat default calls in continuation history, and reject invalid default-namespace members before sending.
- Omit `reasoning.mode` for the default GPT-5.6 standard mode and send the field only when pro mode is selected.
- Continue interrupted Codex tasks automatically after an exact output-token-limit response, including after successful Pi threshold compaction, without treating incomplete WebSocket responses as completed continuation state.
- Render delete-and-recreate replacements and repeated in-place `apply_patch` operations as one logical file with a recomputed initial-to-final diff instead of counting the path multiple times.

## 0.0.3 - 2026-08-04

### Added

- Expose Pi AI-compatible Codex WebSocket debug statistics, reset helpers, and force-close control for connection reuse, continuation deltas, failures, and SSE fallback.

### Changed

- Rely on Pi's compaction indicator instead of adding a temporary third footer status line during percentage-triggered compaction.
- Adapt the `image_gen.imagegen` descriptions and prompt metadata to Pi while retaining the server-reserved schema.
- Normalize local image paths before reading them and enforce image-count bounds and edit-selector exclusivity in the executor.
- Add a concise `web.run` prompt snippet and four high-signal system-prompt guidelines derived from its official description.
- Clarify the `apply_patch` prompt snippet, format its system-prompt guidance consistently, and omit the redundant Python file-I/O reminder.
- Disable standalone `web.run` and hosted web search by default; both remain available through settings or environment overrides.

### Fixed

- Report WebSocket close codes and reasons instead of `[object CloseEvent]`, and preserve an underlying WebSocket error when a close event follows it.
- Scope sticky Codex WebSockets to the authenticated account so changing accounts cannot reuse a connection authorized for another account.
- Recover once from expired WebSocket continuations and connection-limit responses while preserving structured Codex API and protocol errors.
- Finish SSE requests as soon as a terminal response arrives, even if the response body remains open, and reject pre-aborted cached-WebSocket requests before sending.
- Apply `cacheRetention: "none"` consistently to ordinary and compaction payloads and clamp cache-affinity headers to the backend's 64-character limit.
- Keep SSE fallback sticky after midstream WebSocket failures and use the fallback for later requests regardless of the preferred WebSocket mode.
- Validate transport timeouts, allow zero to disable the WebSocket connect timeout, report SSE header timeouts clearly, and honor bounded `Retry-After` guidance.
- Surface concise structured Codex HTTP errors, fail closed on malformed WebSocket events, and retain WebSocket-to-SSE recovery diagnostics on assistant messages.
- Distinguish output-token truncation from other incomplete Codex responses and preserve the provider's incomplete reason.
- Match Pi AI's Codex stream lifecycle by delaying `start` until transport readiness, cleaning parser scratch state on failure, and normalizing structured or non-Error failures.
- Honor every non-undefined payload replacement and reject missing `streamSimple` authentication synchronously, matching Pi AI.
- Match Pi AI's configured SSE retry behavior for callback, body-read, and otherwise non-terminal response-acquisition failures.
- Use Pi AI's time-ordered UUIDv7 identifiers for WebSocket requests without session affinity.
- Stop at terminal WebSocket events and honor aborts while requests wait for session transport ownership or finish streaming.
- Ignore type-less Codex events before transport start and retain WebSocket continuation IDs supplied by `response.created`.
- Validate Codex authentication before request hooks, template capture, or native compaction work.
- Apply service-tier pricing to unsuccessful terminal responses and match Pi AI when total-token usage is absent.
- Match Pi AI's final-answer phase state, reasoning-part separators, and suppression of empty final tool-call deltas.
- Retry generic Codex usage-limit responses according to Pi AI's configured SSE retry policy.
- Require Pi AI's order-sensitive request and history equality before sending cached WebSocket deltas.
- Cache the exact canonical or native assistant representation replayed by the next turn so harmless response key ordering cannot disable WebSocket continuation.
- Send full WebSocket context when a payload hook supplies string-valued Responses input instead of incorrectly continuing with an empty delta.
- Treat an empty Codex session identifier as absent and generate a stable UUIDv7 WebSocket request identifier.
- Preserve Pi AI's exact Codex HTTP error bodies and fallback wording without local trimming or truncation.
- Keep native Codex history keyed by the complete Pi session identifier even when cache retention is disabled or the backend cache key is shortened.
- Represent overlong Codex cache identifiers with collision-resistant 64-character SHA-256 hex values instead of truncating them.
- Prevent SSE reader cleanup failures from masking the original Codex stream error.
- Reject malformed Codex credentials whose account identifier is empty.
- Snapshot cached WebSocket continuation requests through their JSON wire representation so payload-hook values omitted by JSON serialization cannot break completed responses.
- Match Pi AI's metadata for non-Error WebSocket failures and its fallback wording for unavailable transports and terminal responses without provider details.
- Discard WebSockets and continuation state when downstream response parsing or terminal validation fails, report parser diagnostics, and retry a fresh WebSocket on later requests without activating sticky SSE fallback.
- Reuse one JSON serialization for SSE requests, align outbound WebSocket close reasons, and match Pi AI's closed grammar-input error wording.

## 0.0.2 - 2026-08-03

### Added

- Add transient `PI_OPENAI_CODEX_COMPAT_*` environment overrides for every compatibility setting, including common boolean aliases, explicit `off`/`default` percentage-compaction values, and an unambiguous `WEB_SEARCH_MODE` name.

### Changed

- Make `Enter` save and close `/codex-settings`, make `Escape` discard unsaved changes and close, and retain `Ctrl+S` as save without closing.

## 0.0.1 - 2026-08-03

### Added

- Add native OpenAI Codex remote compaction.
- Add an extension-managed `openai-codex` provider runtime that shares transport state between ordinary responses and remote compaction while preserving otherwise lossy native Responses items in Pi sessions.
- Add a grammar-constrained Codex `apply_patch` tool.
- Add independently configurable `image_gen.imagegen` and `web.run` tools, enabled by default and transported as native Responses API namespaces.
- Add Codex Images generation/edit execution with generated PNG persistence under the Pi agent directory.
- Add standalone `alpha/search` execution with structured result persistence in Pi tool-result details.
- Add configurable hosted web search, text verbosity, reasoning summaries, and GPT-5.6 standard/pro reasoning mode.
- Add configurable image tool-result detail with `auto` as the default.
- Add a dedicated `/codex-settings` pane backed by `openai-codex-compat.json`, including controls for the extension's additional tools.
- Add dedicated collapsible renderers for `web.run` and `image_gen.imagegen`, including structured web source cards and image artifact metadata.
- Add a shared configurable background surface for extension-owned Codex tools.

### Changed

- Match the complete server-reserved `web.run` description and command schema, including finance, weather, sports, and time operations.
- Document the package's configurable defaults, architectural differences, known gaps, and unsupported runtime/tool families relative to Codex CLI `0.146.0`.
- Match the server-reserved `image_gen.imagegen` description and JSON Schema so Codex accepts the tool declaration.
- Apply fast mode as a priority-tier request modification on the selected `openai-codex` provider.
- Make `/codex-settings` changes session-local by default and persist them only on `Ctrl+S`.
- Print effective settings once at session start and move non-default fast, pro, verbosity, and reasoning-summary indicators onto the second footer line.
- Keep unsampled user input outside provider-bound compaction and preserve native grammar-tool history across Codex checkpoints.
- Match Codex middle truncation markers and UTF-8 byte-boundary behavior for the oldest retained message.
- Persist percentage-triggered compaction as usage-bearing Pi compaction entries and continue the intercepted request from the installed opaque checkpoint.
- Replay sparse native response overrides by response id on the active Pi session branch instead of duplicating round-trippable assistant output.
- Reject model switches while the active branch contains a native Codex checkpoint, and scope extension-owned tools to selected `openai-codex` models.
- Prefer standalone `web.run` over hosted `web_search` when enabled, while retaining the configured cached, indexed, or live access mode.
- Serialize, replay, defer, compact, and parse the extension-owned dotted tool allowlist with native Responses namespace/member identities.
- Avoid persisting synthetic missing-tool-result items when checking whether completed assistant tool calls need native response overrides.
- Construct checkpoint history with a focused, attributed copy of Pi AI's relevant OpenAI Responses serialization methods.
- Use `apply_patch` in place of Pi's active `edit` and `write` tools, restoring only the tools suppressed by the setting when it is disabled.
- Match Codex `apply_patch` parsing, fuzzy context matching, unrestricted path resolution, symlink behavior, add/move overwrite semantics, model-facing results, structured committed-delta history, and diff-oriented TUI rendering.
- Render `apply_patch` as a dedicated tool call with a persistent tool header instead of a thinking block.
- Start `apply_patch` wall-time measurement after preflight verification, immediately before mutation execution, matching Codex's timer scope.
- Render `apply_patch` results with Codex-style per-file summaries, line-number gutters, move paths, syntax highlighting, and full-width added/removed line backgrounds without changing model-facing tool output.
- Render `apply_patch` on a transparent self-managed shell so its Codex diff highlights do not blend into Pi's successful-tool background.
- Render `apply_patch` paths relative to the working directory, home-abbreviated with `~` when applicable, and absolute otherwise.
- Collapse `apply_patch` rendering to aggregate and per-file change summaries by default, with full hunks available through Pi's `Ctrl+O` tool expansion.
- Preserve added and removed line highlighting when display diffs contain padded multi-digit line numbers, including moved-file hunks.
- Fail closed to a compact error state when Pi supplies generic or malformed tool-result details instead of crashing the TUI.
- Place the complete `apply_patch` tool call on a subtle theme-derived neutral surface while preserving stronger added and removed line backgrounds.
- Add Pi-style horizontal and vertical padding around the `apply_patch` surface while keeping its title and result visually continuous.
- Render `apply_patch`, `image_gen.imagegen`, and `web.run` on the same theme-derived surface, configurable as `subtle`, Pi `status` colors, or `none`.
- Collapse `web.run` to operation and source summaries by default while exposing detailed action views through `Ctrl+O`.
- Add polished action-specific `web.run` summaries and expanded cards for image search, page navigation, find, reference-only PDF screenshots, finance, weather, sports, and time, including concise display domains, forward-compatible structured-field rendering, and empty/error states.
- Show up to 250 characters of image-generation prompts in collapsed tool-call summaries.

### Fixed

- Serialize `web.run` with Codex's post-normalization Responses schema, omitting generated `format` and `minimum` annotations that cause reserved-tool declaration rejection.
- Return successful `web.run` model output as Codex's single `input_text` content-item array while retaining structured search results only in session metadata.

### Removed

- Remove the separate `/codex-compat` status command.

## 0.0.1-alpha.0

- Initial alpha release.
