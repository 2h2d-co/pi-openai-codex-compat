# Agent Instructions

- This project is a Pi package with a TypeScript extension entrypoint.
- Pi extensions run with full system permissions; keep side effects explicit and documented.
- Keep the package entrypoint compositional: provider, compaction, request-option, and tool behavior belongs in focused modules under `extensions/openai-codex-compat/`.
- Preserve canonical `openai-codex` assistant history when changing fast-mode request behavior.
- Native Codex compaction must fail closed and must not intercept `/tree` branch summarization.
- `apply_patch` must validate all hunks before writes and participate in Pi's file mutation queue.
- Add changelog entries for user-visible changes under `Unreleased`.
- Release commits should update the package version, move `Unreleased` entries into the new release section, and use `release: v<version>` as the commit subject.
- Release tags must be lightweight tags. Create one with `git tag v<version>`; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
- Run `npm run check` and `npm test` before committing meaningful code changes.
