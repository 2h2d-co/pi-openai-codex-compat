# Agent Instructions

- This project is a Pi package with a TypeScript extension entrypoint.
- Pi extensions run with full system permissions; keep side effects explicit and documented.
- Keep `extensions/index.ts` as a thin public entrypoint; provider, compaction, request-option, and tool behavior belongs in focused modules under `extensions/openai-codex-compat/`.
- Preserve canonical `openai-codex` assistant history when changing fast-mode request behavior.
- Native Codex compaction must fail closed and must not intercept `/tree` branch summarization.
- `apply_patch` must validate all hunks before writes and participate in Pi's file mutation queue.
- When asked to check a new official Codex CLI release, follow `OFFICIAL_CODEX_CLI_RELEASES.md`, compare the newest stable tag with the previous reviewed stable tag, and append the protocol and `apply_patch` decisions without silently reopening recorded deviations.
- When explaining model/provider context layouts, use concrete, traceable history transformations rather than mixing context with control flow: define a compact symbol legend, show each request/response as an ordered item list, walk each case independently, contrast valid and invalid layouts, and state which items are committed, discarded, compacted, or carried forward. Distinguish the logical full context from transport optimizations such as `previous_response_id` plus a suffix, and end with the key invariant or concise before/after summary.
- Add changelog entries for user-visible changes under `Unreleased`.
- Run `npm run pack:dry` to inspect the npm package contents before release.
- Keep changelog entries under `Unreleased` for prereleases and move them into a release section only for stable releases.
- Use `npm run release -- <version>` to build the release locally, record its SHA-256 in an SSH-signed `release: v<version>` commit, prove a clean rebuild is reproducible, and create the matching lightweight tag.
- Push release commits and tags atomically; do not create annotated or signed tag objects.
- Run `npm run check` and `npm test` before committing meaningful code changes.
