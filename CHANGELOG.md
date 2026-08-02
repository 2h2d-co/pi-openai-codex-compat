# Changelog

## Unreleased

### Added

- Add native OpenAI Codex remote compaction.
- Add a grammar-constrained Codex `apply_patch` tool with workspace path protections.
- Add configurable hosted web search, text verbosity, reasoning summaries, and GPT-5.6 standard/pro reasoning mode.
- Add a dedicated `/codex-settings` pane backed by `openai-codex-compat.json`, including controls for the extension's additional tools.

### Changed

- Apply fast mode as a priority-tier request modification on the selected `openai-codex` provider.
- Make `/codex-settings` changes session-local by default and persist them only on `Ctrl+S`.
- Print effective settings once at session start and move non-default fast, pro, verbosity, and reasoning-summary indicators onto the second footer line.
- Keep unsampled user input outside provider-bound compaction and preserve native grammar-tool history across Codex checkpoints.

### Removed

- Remove the separate `/codex-compat` status command.

## 0.0.1-alpha.0

- Initial alpha release.
