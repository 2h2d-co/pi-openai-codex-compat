# Changelog

## Unreleased

### Added

- Add native OpenAI Codex remote compaction.
- Add a grammar-constrained Codex `apply_patch` tool.
- Add configurable hosted web search, text verbosity, reasoning summaries, and GPT-5.6 standard/pro reasoning mode.
- Add a dedicated `/codex-settings` pane backed by `openai-codex-compat.json`, including controls for the extension's additional tools.

### Changed

- Apply fast mode as a priority-tier request modification on the selected `openai-codex` provider.
- Make `/codex-settings` changes session-local by default and persist them only on `Ctrl+S`.
- Print effective settings once at session start and move non-default fast, pro, verbosity, and reasoning-summary indicators onto the second footer line.
- Keep unsampled user input outside provider-bound compaction and preserve native grammar-tool history across Codex checkpoints.
- Construct checkpoint history with a focused, attributed copy of Pi AI's relevant OpenAI Responses serialization methods.
- Use `apply_patch` in place of Pi's active `edit` and `write` tools, restoring only the tools suppressed by the setting when it is disabled.
- Match Codex `apply_patch` parsing, fuzzy context matching, unrestricted path resolution, symlink behavior, add/move overwrite semantics, model-facing results, structured committed-delta history, and diff-oriented TUI rendering.
- Render `apply_patch` as a dedicated tool call with a persistent tool header instead of a thinking block.
- Start `apply_patch` wall-time measurement after preflight verification, immediately before mutation execution, matching Codex's timer scope.
- Render `apply_patch` results with Codex-style per-file summaries, line-number gutters, move paths, syntax highlighting, and full-width added/removed line backgrounds without changing model-facing tool output.
- Render `apply_patch` on a transparent self-managed shell so its Codex diff highlights do not blend into Pi's successful-tool background.

### Removed

- Remove the separate `/codex-compat` status command.

## 0.0.1-alpha.0

- Initial alpha release.
