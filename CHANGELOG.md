# Changelog

## Unreleased

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
